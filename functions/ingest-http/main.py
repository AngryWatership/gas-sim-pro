"""
Cloud Function HTTP — direct NDJSON ingest from browser
Replaces the manual download/upload flow.
Browser POSTs NDJSON directly here every 5000 ticks.

Authentication: static bearer token (VITE_INGEST_TOKEN)
CORS: allows GitHub Pages and localhost origins
"""

import os
import json
import logging
import functions_framework
from datetime import datetime, timezone
from google.cloud import storage, bigquery
from flask import Request, Response, jsonify

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

PROJECT_ID     = os.environ["PROJECT_ID"]
BUCKET         = os.environ["BUCKET"]
INGEST_TOKEN   = os.environ.get("INGEST_TOKEN", "")
BQ_DATASET     = os.environ.get("BQ_DATASET", "raw")
BQ_TABLE       = os.environ.get("BQ_TABLE",   "simulation_ticks")
TRAIN_THRESHOLD = int(os.environ.get("TRAIN_THRESHOLD", "10000"))
GH_REPO        = os.environ.get("GH_REPO", "AngryWatership/gas-sim-pro")
GH_TOKEN       = os.environ.get("GH_TOKEN", "")

ALLOWED_ORIGINS = [
    "https://angrywatership.github.io",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

REQUIRED_FIELDS = {
    "source", "seed", "layout_id", "config_hash",
    "tick", "leaks", "sensors", "walls", "doors",
}

BQ_BATCH_SIZE = 500

# Clients initialised lazily on first request
_gcs_client = None
_bq_client  = None

def _gcs():
    global _gcs_client
    if _gcs_client is None:
        _gcs_client = storage.Client(project=PROJECT_ID)
    return _gcs_client

def _bq():
    global _bq_client
    if _bq_client is None:
        _bq_client = bigquery.Client(project=PROJECT_ID)
    return _bq_client


def cors_headers(origin: str) -> dict:
    allowed = origin if origin in ALLOWED_ORIGINS else ALLOWED_ORIGINS[0]
    return {
        "Access-Control-Allow-Origin":  allowed,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age":       "3600",
    }


@functions_framework.http
def ingest_http(request: Request) -> Response:
    origin = request.headers.get("Origin", "")

    # Handle CORS preflight
    if request.method == "OPTIONS":
        return Response("", 204, cors_headers(origin))

    headers = cors_headers(origin)

    # Auth check
    if INGEST_TOKEN:
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {INGEST_TOKEN}":
            log.warning("Unauthorized ingest attempt from %s", origin)
            return Response(
                json.dumps({"error": "unauthorized"}),
                401, {**headers, "Content-Type": "application/json"}
            )

    if request.method != "POST":
        return Response("Method not allowed", 405, headers)

    # Parse body
    body = request.get_data(as_text=True)
    if not body:
        return Response(
            json.dumps({"error": "empty body"}),
            400, {**headers, "Content-Type": "application/json"}
        )

    now_utc   = datetime.now(timezone.utc).isoformat()
    table_ref = f"{PROJECT_ID}.{BQ_DATASET}.{BQ_TABLE}"

    rows    = []
    errors  = []
    line_num = 0

    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        line_num += 1

        try:
            record = json.loads(line)
        except json.JSONDecodeError as e:
            errors.append(f"Line {line_num}: JSON parse error — {e}")
            continue

        err = _validate(record, line_num)
        if err:
            errors.append(err)
            continue

        rows.append(_to_bq_row(record, now_utc))

        if len(rows) >= BQ_BATCH_SIZE:
            bq_errors = _bq().insert_rows_json(table_ref, rows)
            if bq_errors:
                log.error("BQ insert errors: %s", bq_errors)
            rows = []

    # Flush remaining
    if rows:
        bq_errors = _bq().insert_rows_json(table_ref, rows)
        if bq_errors:
            log.error("BQ insert errors (final): %s", bq_errors)

    if errors and line_num > 0 and len(errors) == line_num:
        log.warning("All %d records failed validation", line_num)
        return Response(
            json.dumps({"error": "all records failed validation", "details": errors[:5]}),
            400, {**headers, "Content-Type": "application/json"}
        )

    loaded = line_num - len(errors)
    log.info("Ingested %d/%d records from %s", loaded, line_num, origin)

    # Update last_data_upload.txt
    _update_last_data_upload(now_utc)

    # Check training threshold
    _maybe_trigger_training()

    return Response(
        json.dumps({
            "ok":      True,
            "loaded":  loaded,
            "errors":  len(errors),
            "details": errors[:3] if errors else [],
        }),
        200, {**headers, "Content-Type": "application/json"}
    )


def _validate(record: dict, line_num: int) -> str | None:
    missing = REQUIRED_FIELDS - set(record.keys())
    if missing:
        return f"Line {line_num}: missing fields {missing}"
    sensors = record.get("sensors", [])
    if not isinstance(sensors, list) or len(sensors) < 3:
        return f"Line {line_num}: sensors must have at least 3 entries"
    leaks = record.get("leaks", [])
    if not isinstance(leaks, list) or len(leaks) < 1:
        return f"Line {line_num}: leaks must be non-empty"
    for leak in leaks:
        if "row" not in leak or "col" not in leak:
            return f"Line {line_num}: each leak must have row and col"
    return None


def _to_bq_row(record: dict, uploaded_at: str) -> dict:
    return {
        "source":            record.get("source"),
        "seed":              record.get("seed"),
        "layout_id":         record.get("layout_id"),
        "config_hash":       record.get("config_hash"),
        "locked_dimensions": record.get("locked_dimensions", []),
        "tick":              record.get("tick"),
        "wind_x":            record.get("wind_x"),
        "wind_y":            record.get("wind_y"),
        "diffusion_rate":    record.get("diffusion_rate"),
        "decay_factor":      record.get("decay_factor"),
        "leak_injection":    record.get("leak_injection"),
        "leaks":             json.dumps(record.get("leaks", [])),
        "sensors":           json.dumps(record.get("sensors", [])),
        "walls":             json.dumps(record.get("walls", [])),
        "doors":             json.dumps(record.get("doors", [])),
        "uploaded_at":       uploaded_at,
    }


def _update_last_data_upload(timestamp: str) -> None:
    try:
        bucket = _gcs().bucket(BUCKET)
        blob   = bucket.blob("registry/last_data_upload.txt")
        try:
            current = blob.download_as_text().strip()
            if current and current >= timestamp:
                return
        except Exception:
            pass
        blob.upload_from_string(timestamp, content_type="text/plain")
        blob.cache_control = "no-cache, no-store, max-age=0"
        blob.patch()
        log.info("Updated last_data_upload.txt = %s", timestamp)
    except Exception as e:
        log.error("Failed to update last_data_upload: %s", e)


def _maybe_trigger_training() -> None:
    """Fire repository_dispatch to GitHub Actions if threshold is met."""
    if not GH_TOKEN or not GH_REPO:
        return
    try:
        import urllib.request
        # Get current BQ count
        rows = list(_bq().query(
            f"SELECT COUNT(*) as n FROM `{PROJECT_ID}.{BQ_DATASET}.{BQ_TABLE}`"
        ))[0]["n"]

        # Get rows_trained_on from registry
        bucket = _gcs().bucket(BUCKET)
        reg    = json.loads(bucket.blob("model_registry.json").download_as_text())
        trained_on = reg.get("rows_trained_on", 0) or 0
        new_rows   = rows - trained_on

        log.info("BQ rows: %d  trained_on: %d  new: %d  threshold: %d",
                 rows, trained_on, new_rows, TRAIN_THRESHOLD)

        if new_rows < TRAIN_THRESHOLD:
            return

        # Fire repository_dispatch
        payload = json.dumps({
            "event_type": "new-training-data",
            "client_payload": {
                "bq_rows":    rows,
                "new_rows":   new_rows,
                "triggered_at": datetime.now(timezone.utc).isoformat(),
            }
        }).encode()

        req = urllib.request.Request(
            f"https://api.github.com/repos/{GH_REPO}/dispatches",
            data=payload,
            headers={
                "Authorization": f"Bearer {GH_TOKEN}",
                "Accept":        "application/vnd.github+json",
                "Content-Type":  "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            log.info("Training webhook fired — HTTP %d  new_rows=%d",
                     resp.status, new_rows)

    except Exception as e:
        log.error("Failed to trigger training: %s", e)