"""
train_github_actions.py
Training script for GitHub Actions — incremental XGBoost, resumable via GCS checkpoint.
Run by .github/workflows/train.yml

Environment variables required:
    PROJECT_ID    — GCP project
    BUCKET        — GCS bucket name
    FORCE_RETRAIN — 'true' to ignore threshold check
"""

import os
import json
import math
import datetime
import logging
import joblib
import numpy as np
import pandas as pd
import xgboost as xgb
from google.cloud import storage, bigquery

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)

PROJECT_ID    = os.environ["PROJECT_ID"]
BUCKET        = os.environ["BUCKET"]
FORCE_RETRAIN = os.environ.get("FORCE_RETRAIN", "false").lower() == "true"

TRAIN_THRESHOLD = int(os.environ.get("TRAIN_THRESHOLD", "10000"))
CHECKPOINT_TTL_HOURS = 24
TREES_PER_STEP = 100
TOTAL_TREES    = 500
CHECKPOINT_KEY = "registry/training_checkpoint.json"

FEATURES = [
    "sensor_delta", "sensor_mean", "reading_variance",
    "centroid_row", "centroid_col", "coverage_ratio",
    "wind_angle", "wind_magnitude", "distance_to_boundary",
    "wind_x", "wind_y", "diffusion_rate", "decay_factor",
    "leak_injection", "sensor_count",
]

gcs = storage.Client(project=PROJECT_ID)
bq  = bigquery.Client(project=PROJECT_ID)


# ── Threshold check ───────────────────────────────────────────────────────────

def should_train() -> bool:
    if FORCE_RETRAIN:
        log.info("FORCE_RETRAIN=true — skipping threshold check")
        return True

    bucket = gcs.bucket(BUCKET)
    try:
        reg = json.loads(bucket.blob("model_registry.json").download_as_text())
        rows_trained  = reg.get("rows_trained_on", 0) or 0
    except Exception:
        rows_trained = 0

    bq_count = list(bq.query(
        f"SELECT COUNT(*) as n FROM `{PROJECT_ID}.raw.simulation_ticks`"
    ))[0]["n"]

    new_rows = bq_count - rows_trained
    log.info("BQ rows: %d  trained_on: %d  new: %d  threshold: %d",
             bq_count, rows_trained, new_rows, TRAIN_THRESHOLD)

    if new_rows < TRAIN_THRESHOLD:
        log.info("Below threshold — skipping training")
        return False
    return True


# ── Checkpoint helpers ────────────────────────────────────────────────────────

def load_checkpoint() -> dict | None:
    try:
        bucket = gcs.bucket(BUCKET)
        raw    = bucket.blob(CHECKPOINT_KEY).download_as_text()
        cp     = json.loads(raw)
        started = datetime.datetime.fromisoformat(cp["started_at"])
        age_hours = (datetime.datetime.now(datetime.timezone.utc) - started).seconds / 3600
        if age_hours > CHECKPOINT_TTL_HOURS:
            log.info("Checkpoint expired (%dh old) — starting fresh", age_hours)
            return None
        log.info("Resuming from checkpoint step %d/%d",
                 cp["step"], math.ceil(TOTAL_TREES / TREES_PER_STEP))
        return cp
    except Exception:
        return None


def save_checkpoint(step: int, version: str,
                    model_row: xgb.Booster, model_col: xgb.Booster) -> None:
    bucket = gcs.bucket(BUCKET)

    model_row.save_model(f"/tmp/checkpoint_row.ubj")
    model_col.save_model(f"/tmp/checkpoint_col.ubj")

    bucket.blob(f"registry/checkpoint_row.ubj").upload_from_filename("/tmp/checkpoint_row.ubj")
    bucket.blob(f"registry/checkpoint_col.ubj").upload_from_filename("/tmp/checkpoint_col.ubj")

    cp = {
        "version":        version,
        "step":           step,
        "trees_completed": step * TREES_PER_STEP,
        "total_trees":    TOTAL_TREES,
        "started_at":     datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "backend":        "github_actions",
    }
    bucket.blob(CHECKPOINT_KEY).upload_from_string(
        json.dumps(cp, indent=2), content_type="application/json"
    )
    log.info("Checkpoint saved — step %d", step)


def clear_checkpoint() -> None:
    bucket = gcs.bucket(BUCKET)
    for key in [CHECKPOINT_KEY, "registry/checkpoint_row.ubj", "registry/checkpoint_col.ubj"]:
        try:
            bucket.blob(key).delete()
        except Exception:
            pass


# ── Load features ─────────────────────────────────────────────────────────────

def load_features() -> pd.DataFrame:
    log.info("Loading features from GCS Parquet...")
    bucket = gcs.bucket(BUCKET)
    blobs  = list(bucket.list_blobs(prefix="features/latest/"))
    paths  = [f"gs://{BUCKET}/{b.name}" for b in blobs if b.name.endswith(".parquet")]

    if not paths:
        raise RuntimeError("No Parquet files found in features/latest/")

    log.info("Found %d Parquet file(s)", len(paths))
    df = pd.concat(
        [pd.read_parquet(p, storage_options={"token": "google_default"}) for p in paths],
        ignore_index=True,
    )
    log.info("Loaded %d rows × %d columns", len(df), len(df.columns))

    if len(df) < 500:
        raise RuntimeError(f"Only {len(df)} rows — need at least 500 to train")

    return df


# ── Train ─────────────────────────────────────────────────────────────────────

def train(df: pd.DataFrame, checkpoint: dict | None) -> tuple[xgb.Booster, xgb.Booster, float, str]:
    X = df[FEATURES].values.astype(np.float32)
    y_row = df["leak_row"].values.astype(np.float32)
    y_col = df["leak_col"].values.astype(np.float32)

    # 85/15 train/val split
    n_val  = max(int(len(X) * 0.15), 1)
    X_val, y_row_val, y_col_val = X[-n_val:], y_row[-n_val:], y_col[-n_val:]
    X_tr,  y_row_tr,  y_col_tr  = X[:-n_val], y_row[:-n_val], y_col[:-n_val]

    dtrain_row = xgb.DMatrix(X_tr,  label=y_row_tr)
    dtrain_col = xgb.DMatrix(X_tr,  label=y_col_tr)
    dval_row   = xgb.DMatrix(X_val, label=y_row_val)
    dval_col   = xgb.DMatrix(X_val, label=y_col_val)

    params = {
        "objective":       "reg:squarederror",
        "max_depth":        6,
        "learning_rate":    0.05,
        "subsample":        0.8,
        "colsample_bytree": 0.8,
        "seed":             42,
        "verbosity":        0,
    }

    version = f"v{datetime.date.today().strftime('%Y%m%d')}-ga"

    # Load checkpoint models if resuming
    prev_row = prev_col = None
    start_step = 0
    if checkpoint:
        try:
            bucket = gcs.bucket(BUCKET)
            bucket.blob("registry/checkpoint_row.ubj").download_to_filename("/tmp/checkpoint_row.ubj")
            bucket.blob("registry/checkpoint_col.ubj").download_to_filename("/tmp/checkpoint_col.ubj")
            prev_row   = "/tmp/checkpoint_row.ubj"
            prev_col   = "/tmp/checkpoint_col.ubj"
            start_step = checkpoint["step"]
            version    = checkpoint["version"]
            log.info("Loaded checkpoint models from step %d", start_step)
        except Exception as e:
            log.warning("Could not load checkpoint models: %s — starting fresh", e)
            start_step = 0

    n_steps = math.ceil(TOTAL_TREES / TREES_PER_STEP)
    model_row = model_col = None

    for step in range(start_step, n_steps):
        log.info("Training step %d/%d (%d trees)...", step + 1, n_steps, TREES_PER_STEP)
        model_row = xgb.train(
            params, dtrain_row,
            num_boost_round=TREES_PER_STEP,
            xgb_model=prev_row,
            evals=[(dval_row, "val")],
            verbose_eval=False,
        )
        model_col = xgb.train(
            params, dtrain_col,
            num_boost_round=TREES_PER_STEP,
            xgb_model=prev_col,
            evals=[(dval_col, "val")],
            verbose_eval=False,
        )
        prev_row = prev_col = None  # xgb_model only on first incremental step
        # After first step, use the model object directly
        save_checkpoint(step + 1, version, model_row, model_col)

    # Evaluate
    pred_row = model_row.predict(dval_row)
    pred_col = model_col.predict(dval_col)
    mae = float(np.mean(
        np.abs(pred_row - y_row_val) + np.abs(pred_col - y_col_val)
    ) / 2)
    log.info("Val MAE: %.4f cells", mae)

    return model_row, model_col, mae, version


# ── MAE gate ──────────────────────────────────────────────────────────────────

def check_mae_gate(mae: float, registry: dict) -> bool:
    prod_mae = registry.get("mae")
    if prod_mae is None:
        log.info("No previous MAE — gate passes automatically")
        return True
    threshold = prod_mae * 0.98
    if mae >= threshold:
        log.warning("MAE gate FAILED: %.4f >= %.4f * 0.98 = %.4f", mae, prod_mae, threshold)
        return False
    log.info("MAE gate PASSED: %.4f < %.4f", mae, threshold)
    return True


# ── Upload model ──────────────────────────────────────────────────────────────

def upload_model(model_row: xgb.Booster, model_col: xgb.Booster,
                 version: str, mae: float, n_rows: int) -> None:
    bucket = gcs.bucket(BUCKET)

    # Save combined joblib for Cloud Run (sklearn-compatible wrapper)
    from sklearn.base import BaseEstimator
    class DualBooster(BaseEstimator):
        def __init__(self, row, col):
            self.row = row
            self.col = col
        def predict(self, X):
            dm = xgb.DMatrix(X)
            return np.column_stack([self.row.predict(dm), self.col.predict(dm)])

    model = DualBooster(model_row, model_col)
    joblib.dump(model, "/tmp/model.joblib")

    blob = bucket.blob(f"models/{version}/model.joblib")
    blob.upload_from_filename("/tmp/model.joblib")
    log.info("Uploaded: models/%s/model.joblib", version)

    # Update registry
    reg_blob = bucket.blob("model_registry.json")
    try:
        reg = json.loads(reg_blob.download_as_text())
    except Exception:
        reg = {}

    prev_version = reg.get("latest_version")
    prev_mae     = reg.get("mae")

    reg.update({
        "latest_version":   version,
        "previous_version": prev_version,
        "last_trained":     datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "model_path":       f"models/{version}/model.joblib",
        "joblib_path":      f"models/{version}/model.joblib",
        "mae":              mae,
        "previous_mae":     prev_mae,
        "rows_trained_on":  n_rows,
        "gate_status":      "passed",
    })

    reg_blob.upload_from_string(
        json.dumps(reg, indent=2), content_type="application/json"
    )
    reg_blob.cache_control = "no-cache, no-store, max-age=0"
    reg_blob.patch()
    log.info("Registry updated — version: %s  MAE: %.4f", version, mae)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    log.info("=== Training start ===")
    log.info("Project: %s  Bucket: %s", PROJECT_ID, BUCKET)

    if not should_train():
        log.info("Training skipped — threshold not met")
        return

    # Load registry for gate check
    bucket = gcs.bucket(BUCKET)
    try:
        registry = json.loads(bucket.blob("model_registry.json").download_as_text())
    except Exception:
        registry = {}

    # Check for existing checkpoint
    checkpoint = load_checkpoint()

    # Load features and train
    df = load_features()
    model_row, model_col, mae, version = train(df, checkpoint)

    # MAE gate
    if not check_mae_gate(mae, registry):
        bucket.blob("registry/gate_status.txt").upload_from_string("failed_mae_gate")
        raise SystemExit(f"MAE gate failed — {mae:.4f} does not improve on {registry.get('mae'):.4f}")

    # Upload
    upload_model(model_row, model_col, version, mae, len(df))
    clear_checkpoint()
    log.info("=== Training complete — %s  MAE: %.4f ===", version, mae)


if __name__ == "__main__":
    main()
