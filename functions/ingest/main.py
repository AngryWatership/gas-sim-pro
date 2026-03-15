"""
Cloud Function — NDJSON validator + BigQuery loader
Trigger: GCS object finalised in raw/ndjson/
Streams the file line by line to avoid OOM on large files.
"""

import json
import os
import logging
from datetime import datetime, timezone
from google.cloud import storage, bigquery

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

PROJECT_ID = os.environ["PROJECT_ID"]
BUCKET     = os.environ["BUCKET"]
BQ_DATASET = os.environ.get("BQ_DATASET", "raw")
BQ_TABLE   = os.environ.get("BQ_TABLE",   "simulation_ticks")

# Flush to BigQuery every N rows — keeps memory flat regardless of file size
BQ_BATCH_SIZE = 500

REQUIRED_FIELDS = {
    "source", "seed", "layout_id", "config_hash",
    "tick", "leaks", "sensors", "walls", "doors",
}

bq_client  = bigquery.Client(project=PROJECT_ID)
gcs_client = storage.Client(project=PROJECT_ID)


def on_ndjson_upload(event: dict, context) -> None:
    bucket_name = event["bucket"]
    object_name = event["name"]

    if not object_name.startswith("raw/ndjson/"):
        return
    if object_name.endswith(".keep"):
        return
    # Skip files already in rejected/
    if "/rejected/" in object_name:
        return

    log.info("Processing: %s", object_name)
    bucket = gcs_client.bucket(bucket_name)
    blob   = bucket.blob(object_name)

    table_ref = f"{PROJECT_ID}.{BQ_DATASET}.{BQ_TABLE}"
    now_utc   = datetime.now(timezone.utc).isoformat()

    batch        = []
    total_loaded = 0
    errors       = []
    line_num     = 0

    # Stream line by line — never loads the whole file into memory
    with blob.open("r", encoding="utf-8") as f:
        for raw_line in f:
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

            batch.append(_to_bq_row(record, now_utc))

            # Flush batch to BigQuery
            if len(batch) >= BQ_BATCH_SIZE:
                bq_errors = bq_client.insert_rows_json(table_ref, batch)
                if bq_errors:
                    log.error("BigQuery insert errors: %s", bq_errors)
                    errors.append(f"BigQuery error on batch ending line {line_num}")
                else:
                    total_loaded += len(batch)
                batch = []

    # Flush remaining rows
    if batch:
        bq_errors = bq_client.insert_rows_json(table_ref, batch)
        if bq_errors:
            log.error("BigQuery insert errors (final batch): %s", bq_errors)
        else:
            total_loaded += len(batch)

    if errors:
        log.warning("%d validation errors in %s — first 5: %s",
                    len(errors), object_name, errors[:5])
        # Only reject if ALL lines failed — partial success still loads
        if total_loaded == 0:
            _move_to_rejected(bucket, object_name, "\n".join(errors[:20]))
            return

    log.info("Loaded %d rows from %s into %s", total_loaded, object_name, table_ref)
    _update_registry_timestamp(bucket_name, now_utc)


def _validate(record: dict, line_num: int) -> str | None:
    missing = REQUIRED_FIELDS - set(record.keys())
    if missing:
        return f"Line {line_num}: missing fields {missing}"

    sensors = record.get("sensors", [])
    if not isinstance(sensors, list) or len(sensors) < 3:
        return f"Line {line_num}: sensors must be a list with at least 3 entries"

    leaks = record.get("leaks", [])
    if not isinstance(leaks, list) or len(leaks) < 1:
        return f"Line {line_num}: leaks must be a non-empty list"

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


def _move_to_rejected(bucket, object_name: str, reason: str) -> None:
    filename    = object_name.split("/")[-1]
    dest_name   = f"raw/ndjson/rejected/{filename}"
    reason_name = f"raw/ndjson/rejected/{filename}.reason.txt"
    try:
        bucket.copy_blob(bucket.blob(object_name), bucket, dest_name)
        bucket.blob(reason_name).upload_from_string(reason, content_type="text/plain")
        bucket.blob(object_name).delete()
        log.info("Moved %s to rejected/", object_name)
    except Exception as e:
        log.error("Failed to move to rejected: %s", e)


def _update_registry_timestamp(bucket_name: str, timestamp: str) -> None:
    try:
        bucket = gcs_client.bucket(bucket_name)
        blob   = bucket.blob("model_registry.json")
        reg    = json.loads(blob.download_as_text())
        reg["last_data_upload"] = timestamp
        blob.upload_from_string(
            json.dumps(reg, indent=2),
            content_type="application/json",
        )
        blob.cache_control = "no-cache, no-store, max-age=0"
        blob.patch()
        log.info("Updated model_registry.json last_data_upload = %s", timestamp)
    except Exception as e:
        log.error("Failed to update registry: %s", e)
