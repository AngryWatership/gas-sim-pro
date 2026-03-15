"""
P3.5 — Export ml_export from BigQuery to GCS as Parquet.
Run from WSL:
    python3 export_features.py

Reads PROJECT_ID and BUCKET from environment.
Writes to gs://{BUCKET}/features/latest/training_export.parquet
Updates model_registry.json feature_version field.
"""

import os
import json
import datetime
from google.cloud import bigquery, storage

PROJECT_ID = os.environ["PROJECT_ID"]
BUCKET     = os.environ["BUCKET"]
DATASET    = "dbt_dev"
TABLE      = "ml_export"
DEST_URI   = f"gs://{BUCKET}/features/latest/training_export-*.parquet"
REGISTRY   = "model_registry.json"

bq  = bigquery.Client(project=PROJECT_ID)
gcs = storage.Client(project=PROJECT_ID)


def export():
    table_ref = f"{PROJECT_ID}.{DATASET}.{TABLE}"

    print(f"Exporting {table_ref} → {DEST_URI}")

    job_config = bigquery.ExtractJobConfig(
        destination_format=bigquery.DestinationFormat.PARQUET,
        compression=bigquery.Compression.SNAPPY,
    )

    job = bq.extract_table(
        table_ref,
        DEST_URI,
        job_config=job_config,
        location="us-central1",
    )
    job.result()  # wait for completion
    print(f"Export complete")

    # List exported files
    bucket = gcs.bucket(BUCKET)
    blobs  = list(bucket.list_blobs(prefix="features/latest/"))
    print(f"Files in GCS:")
    for b in blobs:
        print(f"  gs://{BUCKET}/{b.name}  ({b.size:,} bytes)")

    # Update model_registry.json
    reg_blob = bucket.blob(REGISTRY)
    reg      = json.loads(reg_blob.download_as_text())

    # Bump feature version
    current = reg.get("feature_version", "v0")
    version_num = int(current.lstrip("v") or 0) + 1
    new_version = f"v{version_num}"

    reg["feature_version"]   = new_version
    reg["last_data_upload"]  = datetime.datetime.now(datetime.timezone.utc).isoformat()

    reg_blob.upload_from_string(
        json.dumps(reg, indent=2),
        content_type="application/json",
    )
    reg_blob.cache_control = "no-cache, no-store, max-age=0"
    reg_blob.patch()

    print(f"Registry updated — feature_version: {new_version}")
    print("P3.5 complete. Colab can now read:")
    print(f"  gs://{BUCKET}/features/latest/training_export-*.parquet")


if __name__ == "__main__":
    export()
