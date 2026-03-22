"""
diagnostics_ci.py
CI-friendly pipeline diagnostics — runs inside GitHub Actions.
Writes registry/health.json with results.
Exits with code 1 if any layer fails (triggers GitHub Issue via workflow).

Environment variables:
    PROJECT_ID   — GCP project
    BUCKET       — GCS bucket
    DIAG_TIER    — smoke | integration | full
    SERVICE_URL  — Cloud Run URL for /health and /predict tests
"""

import os
import sys
import json
import time
import datetime
import requests
import logging
from google.cloud import storage, bigquery

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

PROJECT_ID  = os.environ["PROJECT_ID"]
BUCKET      = os.environ["BUCKET"]
TIER        = os.environ.get("DIAG_TIER", "smoke")
SERVICE_URL = os.environ.get("SERVICE_URL", "")

gcs = storage.Client(project=PROJECT_ID)
bq  = bigquery.Client(project=PROJECT_ID)

RESULTS = {}


def record(layer: str, status: str, note: str = "") -> None:
    RESULTS[layer] = {"status": status, "note": note}
    icon = "✓" if status == "pass" else ("⚠" if status == "warn" else "✗")
    log.info("%s %s — %s %s", icon, layer, status, note)


# ── Layer 1: GCS object integrity ────────────────────────────────────────────
def test_l1():
    try:
        bucket = gcs.bucket(BUCKET)
        blob   = bucket.blob("model_registry.json")
        text   = blob.download_as_text()
        reg    = json.loads(text)
        if len(text) < 10:
            record("L1", "fail", "model_registry.json is empty")
            return False
        record("L1", "pass", f"size={len(text)}b  version={reg.get('latest_version')}")
        return True
    except Exception as e:
        record("L1", "fail", str(e)[:100])
        return False


# ── Layer 2: Registry consistency ────────────────────────────────────────────
def test_l2():
    try:
        bucket = gcs.bucket(BUCKET)
        reg    = json.loads(bucket.blob("model_registry.json").download_as_text())
        required = ["latest_version", "mae", "last_trained", "last_deployed",
                    "last_data_upload", "gate_status", "joblib_path", "feature_version"]
        missing = [k for k in required if k not in reg]
        if missing:
            record("L2", "fail", f"missing keys: {missing}")
            return False

        # Check separate files
        for fname in ["registry/last_data_upload.txt",
                      "registry/last_deployed.txt",
                      "registry/gate_status.txt"]:
            try:
                bucket.blob(fname).download_as_text()
            except Exception:
                record("L2", "warn", f"missing helper file: {fname}")

        record("L2", "pass", f"mae={reg.get('mae')}  gate={reg.get('gate_status')}")
        return True
    except Exception as e:
        record("L2", "fail", str(e)[:100])
        return False


# ── Layer 3: Cloud Function health (smoke — no live trigger) ──────────────────
def test_l3():
    import subprocess
    all_pass = True
    for fn in ["ingest-ndjson", "deploy-model"]:
        r = subprocess.run(
            ["gcloud", "functions", "describe", fn,
             "--region=us-central1",
             f"--project={PROJECT_ID}",
             "--format=value(state)"],
            capture_output=True, text=True
        )
        state = r.stdout.strip()
        if state == "ACTIVE":
            record(f"L3_{fn}", "pass", "ACTIVE")
        else:
            record(f"L3_{fn}", "fail", f"state={state or 'MISSING'}")
            all_pass = False
    record("L3", "pass" if all_pass else "fail",
           "both functions ACTIVE" if all_pass else "one or more functions not ACTIVE")
    return all_pass


# ── Layer 4: Cloud Function connectivity (integration+ only) ─────────────────
def test_l4():
    if TIER == "smoke":
        record("L4", "warn", "skipped in smoke tier")
        return True

    import json as _json
    bucket = gcs.bucket(BUCKET)

    # Get baseline BQ count
    before = list(bq.query(
        f"SELECT COUNT(*) as n FROM `{PROJECT_ID}.raw.simulation_ticks`"
    ))[0]["n"]

    # Upload test record
    test_record = _json.dumps({
        "source": "ci_diagnostic", "seed": 0, "layout_id": "ci-test",
        "config_hash": "ci", "locked_dimensions": [], "tick": 1,
        "wind_x": 0.1, "wind_y": 0.0, "diffusion_rate": 0.1,
        "decay_factor": 0.999, "leak_injection": 20.0,
        "leaks": [{"row": 50, "col": 50}],
        "sensors": [
            {"row": 10, "col": 10, "reading": 0.001},
            {"row": 50, "col": 90, "reading": 0.500},
            {"row": 90, "col": 50, "reading": 0.800},
        ],
        "walls": [], "doors": [],
    })

    test_obj = f"raw/ndjson/ci_diag_{int(time.time())}.ndjson"
    bucket.blob(test_obj).upload_from_string(test_record)
    time.sleep(45)

    after = list(bq.query(
        f"SELECT COUNT(*) as n FROM `{PROJECT_ID}.raw.simulation_ticks`"
    ))[0]["n"]

    # Cleanup
    try:
        bucket.blob(test_obj).delete()
    except Exception:
        pass

    if after > before:
        record("L4", "pass", f"BQ grew {before}→{after}")
        return True
    else:
        record("L4", "fail", f"BQ unchanged at {before} after 45s")
        return False


# ── Layer 5: Gate logic ───────────────────────────────────────────────────────
def test_l5():
    try:
        bucket = gcs.bucket(BUCKET)
        reg    = json.loads(bucket.blob("model_registry.json").download_as_text())
        mae      = reg.get("mae")
        prev_mae = reg.get("previous_mae")
        if mae is None:
            record("L5", "warn", "mae is null — gate will pass on next training run")
            return True
        if prev_mae is None:
            record("L5", "pass", f"no previous mae — gate passes automatically (mae={mae:.4f})")
            return True
        gate_blocked = mae >= prev_mae * 0.98
        if gate_blocked:
            record("L5", "warn",
                   f"gate would BLOCK next run — mae={mae:.4f} prev={prev_mae:.4f}")
        else:
            record("L5", "pass", f"gate would pass — mae={mae:.4f} < prev={prev_mae:.4f}×0.98")
        return True
    except Exception as e:
        record("L5", "fail", str(e)[:100])
        return False


# ── Layer 6: Cloud Run health ─────────────────────────────────────────────────
def test_l6():
    if not SERVICE_URL:
        record("L6", "warn", "SERVICE_URL not set — skipping")
        return True
    try:
        r = requests.get(f"{SERVICE_URL}/health", timeout=35)
        if r.status_code == 200:
            data = r.json()
            record("L6", "pass",
                   f"version={data.get('version')}  mae={data.get('mae')}")
            return True
        else:
            record("L6", "fail", f"HTTP {r.status_code}")
            return False
    except requests.Timeout:
        record("L6", "fail", "timeout after 35s — cold start or service down")
        return False
    except Exception as e:
        record("L6", "fail", str(e)[:100])
        return False


# ── Layer 7: TRAIN button state ───────────────────────────────────────────────
def test_l7():
    try:
        bucket = gcs.bucket(BUCKET)
        reg    = json.loads(bucket.blob("model_registry.json").download_as_text())

        def read_ts(path):
            try:
                return bucket.blob(path).download_as_text().strip() or None
            except Exception:
                return None

        def is_after(a, b):
            if not a:
                return False
            from datetime import datetime, timezone
            try:
                ta = datetime.fromisoformat(a.replace("Z", "+00:00"))
                tb = datetime.fromisoformat(b.replace("Z", "+00:00")) \
                    if b else datetime(1970, 1, 1, tzinfo=timezone.utc)
                return ta > tb
            except Exception:
                return False

        upload  = read_ts("registry/last_data_upload.txt") or reg.get("last_data_upload")
        trained = reg.get("last_trained")
        state   = "purple" if is_after(upload, trained) else "grey"

        record("L7", "pass", f"button={state}  upload={upload}  trained={trained}")
        return True
    except Exception as e:
        record("L7", "fail", str(e)[:100])
        return False


# ── Write health.json ─────────────────────────────────────────────────────────
def write_health(all_pass: bool) -> None:
    layers = {k: v["status"] for k, v in RESULTS.items() if k.startswith("L")}
    failed = [k for k, v in layers.items() if v == "fail"]

    status = "healthy" if all_pass else (
        "critical" if len(failed) >= 3 else "degraded"
    )
    message = f"Failed layers: {failed}" if failed else None

    health = {
        "status":       status,
        "tier":         TIER,
        "last_checked": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "layers":       layers,
        "message":      message,
    }

    bucket = gcs.bucket(BUCKET)
    blob   = bucket.blob("registry/health.json")
    blob.upload_from_string(json.dumps(health, indent=2), content_type="application/json")
    blob.cache_control = "no-cache, no-store, max-age=0"
    blob.patch()
    log.info("health.json written — status=%s", status)


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    log.info("=== Diagnostics start — tier=%s ===", TIER)

    results = [
        test_l1(),
        test_l2(),
        test_l3(),
        test_l4(),
        test_l5(),
        test_l6(),
        test_l7(),
    ]

    all_pass = all(results)
    write_health(all_pass)

    log.info("=== Diagnostics complete — %s ===",
             "ALL PASSED" if all_pass else "FAILURES DETECTED")

    if not all_pass:
        sys.exit(1)


if __name__ == "__main__":
    main()
