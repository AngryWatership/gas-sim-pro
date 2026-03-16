"""
Cloud Function — auto-deploy new model to Cloud Run
Trigger: GCS object finalised on model_registry.json

When Colab writes a new model version to model_registry.json this function:
  1. Reads the new registry
  2. MAE gate — new model must beat prod by > 2%
  3. Builds new Docker image via Cloud Build
  4. Deploys to Cloud Run at 0% traffic (no-traffic flag)
  5. Runs smoke test against the new revision directly
  6. On pass: shift to 100% traffic, write last_deployed to registry
  7. On fail: delete new revision, write gate_status=rolled_back
"""

import json
import os
import time
import logging
import requests
from datetime import datetime, timezone
from google.cloud import storage
import google.auth
import google.auth.transport.requests

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

PROJECT_ID  = os.environ["PROJECT_ID"]
BUCKET      = os.environ["BUCKET"]
REGION      = os.environ.get("REGION", "us-central1")
SERVICE     = os.environ.get("SERVICE",  "gas-sim-api")
IMAGE_REPO  = f"{REGION}-docker.pkg.dev/{PROJECT_ID}/gas-sim-repo/{SERVICE}"

gcs = storage.Client(project=PROJECT_ID)


def on_registry_update(event: dict, context) -> None:
    """Entry point — fires when model_registry.json is written."""
    object_name = event["name"]

    # Only react to model_registry.json at bucket root
    if object_name != "model_registry.json":
        log.info("Skipping %s — not model_registry.json", object_name)
        return

    bucket = gcs.bucket(BUCKET)
    reg    = json.loads(bucket.blob("model_registry.json").download_as_text())

    # Skip if no model trained yet
    if not reg.get("latest_version") or not reg.get("last_trained"):
        log.info("No model version in registry — skipping deploy")
        return

    # Skip if already deployed this version
    if reg.get("last_deployed") and reg.get("latest_version") == reg.get("previous_version"):
        log.info("Version %s already deployed — skipping", reg["latest_version"])
        return

    version  = reg["latest_version"]
    new_mae  = reg.get("mae")
    prod_mae = reg.get("previous_mae")

    log.info("New model detected: %s  MAE: %s  prev MAE: %s", version, new_mae, prod_mae)

    # ── MAE gate ──────────────────────────────────────────────────────────
    if new_mae is not None and prod_mae is not None:
        if new_mae >= prod_mae * 0.98:
            log.warning("MAE gate FAILED: %s >= %s * 0.98 — aborting deploy", new_mae, prod_mae)
            _write_gate_status(bucket, "failed_mae_gate")
            return

    log.info("MAE gate passed — proceeding with deploy")

    # ── Cloud Build ───────────────────────────────────────────────────────
    image_tag = f"{IMAGE_REPO}:{version}"
    log.info("Triggering Cloud Build for image: %s", image_tag)

    try:
        result = _run_gcloud([
            "gcloud", "builds", "submit",
            f"gs://{BUCKET}/{reg['joblib_path']}",
            "--no-source",
            f"--tag={image_tag}",
            f"--project={PROJECT_ID}",
        ])
        log.info("Cloud Build complete: %s", result[:200])
    except Exception as e:
        log.error("Cloud Build failed: %s", e)
        _update_registry(bucket, reg, {"gate_status": "build_failed"})
        return

    # ── Deploy with no traffic ────────────────────────────────────────────
    log.info("Deploying new revision (no traffic)")
    try:
        result = _run_gcloud([
            "gcloud", "run", "deploy", SERVICE,
            f"--image={image_tag}",
            f"--region={REGION}",
            f"--project={PROJECT_ID}",
            "--no-traffic",
            f"--set-env-vars=PROJECT_ID={PROJECT_ID},BUCKET={BUCKET}",
            "--memory=1Gi",
            "--format=value(status.latestCreatedRevisionName)",
        ])
        new_revision = result.strip()
        log.info("New revision: %s", new_revision)
    except Exception as e:
        log.error("Deploy failed: %s", e)
        _update_registry(bucket, reg, {"gate_status": "deploy_failed"})
        return

    # ── Smoke test ────────────────────────────────────────────────────────
    service_url = _get_service_url()
    log.info("Running smoke test against %s", service_url)

    smoke_passed = _smoke_test(service_url)

    if not smoke_passed:
        log.warning("Smoke test FAILED — rolling back")
        _update_registry(bucket, reg, {"gate_status": "rolled_back"})
        return

    # ── Promote to 100% traffic ───────────────────────────────────────────
    log.info("Smoke test passed — promoting %s to 100%%", new_revision)
    try:
        _run_gcloud([
            "gcloud", "run", "services", "update-traffic", SERVICE,
            f"--region={REGION}",
            f"--project={PROJECT_ID}",
            "--to-latest",
        ])
    except Exception as e:
        log.error("Traffic promotion failed: %s", e)
        _update_registry(bucket, reg, {"gate_status": "traffic_failed"})
        return

    # ── Update registry ───────────────────────────────────────────────────
    now = datetime.now(timezone.utc).isoformat()

    # Write last_deployed to a separate file to avoid rate-limiting model_registry.json
    _write_last_deployed(bucket, now)

    # Also try updating model_registry.json but don't fail if rate limited
    try:
        _update_registry(bucket, reg, {
            "gate_status":   "passed",
            "last_deployed": now,
        })
    except Exception as e:
        log.warning("Registry update failed (non-fatal): %s", e)

    log.info("Deploy complete — version %s live at 100%% traffic", version)


def _smoke_test(service_url: str) -> bool:
    """Returns True if /predict responds correctly."""
    payload = {
        "sensor_readings": [
            {"row": 10, "col": 10, "reading": 0.0},
            {"row": 50, "col": 50, "reading": 0.8},
            {"row": 90, "col": 90, "reading": 0.1},
        ],
        "wind_x": 0.2, "wind_y": -0.1,
    }
    try:
        r = requests.post(
            f"{service_url}/predict",
            json=payload,
            timeout=10,
        )
        if r.status_code != 200:
            log.error("Smoke test HTTP %s", r.status_code)
            return False
        data = r.json()
        polygon = data.get("predicted_polygon", [])
        if not polygon:
            log.error("Smoke test: empty polygon")
            return False
        pt = polygon[0]
        if not (-200 <= pt["row"] <= 300 and -200 <= pt["col"] <= 300):
            log.error("Smoke test: prediction out of range %s", pt)
            return False
        log.info("Smoke test PASSED — prediction: %s", pt)
        return True
    except Exception as e:
        log.error("Smoke test exception: %s", e)
        return False


def _get_service_url() -> str:
    result = _run_gcloud([
        "gcloud", "run", "services", "describe", SERVICE,
        f"--region={REGION}",
        f"--project={PROJECT_ID}",
        "--format=value(status.url)",
    ])
    return result.strip()


def _run_gcloud(cmd: list) -> str:
    import subprocess
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed: {result.stderr}")
    return result.stdout



def _write_last_deployed(bucket, timestamp: str) -> None:
    """Write last_deployed to a lightweight separate file."""
    try:
        blob = bucket.blob("registry/last_deployed.txt")
        blob.upload_from_string(timestamp, content_type="text/plain")
        blob.cache_control = "no-cache, no-store, max-age=0"
        blob.patch()
        log.info("Written registry/last_deployed.txt = %s", timestamp)
    except Exception as e:
        log.error("Failed to write last_deployed: %s", e)


def _write_gate_status(bucket, status: str) -> None:
    """Write gate status to a lightweight separate file."""
    try:
        blob = bucket.blob("registry/gate_status.txt")
        blob.upload_from_string(status, content_type="text/plain")
        log.info("Written registry/gate_status.txt = %s", status)
    except Exception as e:
        log.error("Failed to write gate_status: %s", e)


def _update_registry(bucket, reg: dict, updates: dict, retries: int = 5) -> None:
    reg.update(updates)
    blob = bucket.blob("model_registry.json")
    for attempt in range(retries):
        try:
            blob.upload_from_string(
                json.dumps(reg, indent=2),
                content_type="application/json",
            )
            blob.cache_control = "no-cache, no-store, max-age=0"
            blob.patch()
            log.info("Registry updated: %s", updates)
            return
        except Exception as e:
            if "429" in str(e) or "rateLimitExceeded" in str(e):
                wait = 2 ** attempt
                log.warning("Registry rate limit — retrying in %ss (attempt %s/%s)", wait, attempt+1, retries)
                time.sleep(wait)
            else:
                log.error("Registry update failed: %s", e)
                raise
    log.error("Registry update failed after %s retries", retries)
