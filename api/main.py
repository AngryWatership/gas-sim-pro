"""
ENV D — FastAPI inference service
Loads three models from GCS on startup:
  model_centroid.joblib — predicts leak centroid (primary)
  model_nearest.joblib  — predicts nearest individual leak
  model_count.joblib    — predicts number of leaks
"""

import os
import json
import math
import logging

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google.cloud import storage

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

PROJECT_ID = os.environ["PROJECT_ID"]
BUCKET     = os.environ["BUCKET"]

app = FastAPI(title="gas-sim-pro inference", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://angrywatership.github.io",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

FEATURES = [
    "sensor_delta", "sensor_mean", "reading_variance",
    "centroid_row", "centroid_col", "coverage_ratio",
    "wind_angle", "wind_magnitude", "distance_to_boundary",
    "wind_x", "wind_y", "diffusion_rate", "decay_factor",
    "leak_injection", "sensor_count",
    "n_sensors_above_threshold", "max_reading",
    "max_reading_row", "max_reading_col",
    "n_leaks",
    "leaks_centroid_row", "leaks_centroid_col",
    "leaks_spread_row", "leaks_spread_col",
]

_registry = None
_model_centroid = None
_model_nearest  = None
_model_count    = None
_version = None


def _load_model(path: str):
    gcs   = storage.Client(project=PROJECT_ID)
    local = f"/tmp/{path.replace('/', '_')}"
    gcs.bucket(BUCKET).blob(path).download_to_filename(local)
    return joblib.load(local)


@app.on_event("startup")
def startup():
    global _registry, _model_centroid, _model_nearest, _model_count, _version
    gcs = storage.Client(project=PROJECT_ID)
    _registry = json.loads(
        gcs.bucket(BUCKET).blob("model_registry.json").download_as_text()
    )
    joblib_path = _registry.get("joblib_path") or _registry.get("model_path")
    if not joblib_path:
        raise RuntimeError("No model in registry — run Colab training first")

    base = joblib_path.rsplit("/", 1)[0]
    _model_centroid = _load_model(f"{base}/model_centroid.joblib")
    _version = _registry.get("latest_version", "unknown")

    # Load secondary models if available (graceful fallback)
    try:
        _model_nearest = _load_model(f"{base}/model_nearest.joblib")
    except Exception:
        log.warning("model_nearest.joblib not found — using centroid for nearest")
        _model_nearest = _model_centroid

    try:
        _model_count = _load_model(f"{base}/model_count.joblib")
    except Exception:
        log.warning("model_count.joblib not found — count prediction disabled")
        _model_count = None

    log.info("Serving version: %s  MAE: %s", _version, _registry.get("mae"))


class SensorReading(BaseModel):
    row:     float
    col:     float
    reading: float


class PredictRequest(BaseModel):
    sensor_readings: list[SensorReading]
    wind_x:          float
    wind_y:          float
    diffusion_rate:  float = 0.10
    decay_factor:    float = 0.999
    leak_injection:  float = 20.0
    # Optional hint: known leaks from previous chain call
    known_leak_row:  float = 0.0
    known_leak_col:  float = 0.0


class LeakPrediction(BaseModel):
    row:        float
    col:        float
    confidence: float
    type:       str   # "centroid" | "nearest"


class PredictResponse(BaseModel):
    predicted_polygon:  list[LeakPrediction]
    predicted_count:    float
    model_version:      str
    mae:                float
    mae_nearest:        float | None


def _extract_features(req: PredictRequest) -> list[float]:
    readings = [s.reading for s in req.sensor_readings]
    rows     = [s.row     for s in req.sensor_readings]
    cols     = [s.col     for s in req.sensor_readings]
    n        = len(readings)
    total    = sum(readings) or 1e-9
    mean     = total / n

    sensor_delta   = max(readings) - min(readings)
    reading_var    = sum((r - mean)**2 for r in readings) / max(n - 1, 1)
    centroid_row   = sum(rows[i] * readings[i] for i in range(n)) / total
    centroid_col   = sum(cols[i] * readings[i] for i in range(n)) / total
    coverage       = sum(1 for r in readings if r > 0.01) / n
    wind_angle     = math.atan2(req.wind_y, req.wind_x)
    wind_mag       = math.sqrt(req.wind_x**2 + req.wind_y**2)
    dist_boundary  = min(centroid_row, 100-centroid_row, centroid_col, 100-centroid_col)
    n_above        = sum(1 for r in readings if r > 0.10)
    max_reading    = max(readings)
    max_idx        = readings.index(max_reading)
    max_row        = rows[max_idx]
    max_col        = cols[max_idx]

    return [
        sensor_delta, mean, reading_var,
        centroid_row, centroid_col, coverage,
        wind_angle, wind_mag, dist_boundary,
        req.wind_x, req.wind_y,
        req.diffusion_rate, req.decay_factor, req.leak_injection,
        float(n), float(n_above), max_reading, max_row, max_col,
        1.0,              # n_leaks — unknown at inference, assume 1 for first call
        centroid_row,     # leaks_centroid_row — use sensor centroid as proxy
        centroid_col,     # leaks_centroid_col
        0.0,              # leaks_spread_row — unknown
        0.0,              # leaks_spread_col
    ]


@app.get("/health")
def health():
    return {
        "status":      "ok",
        "version":     _version,
        "mae":         _registry.get("mae") if _registry else None,
        "mae_nearest": _registry.get("mae_nearest") if _registry else None,
        "n_models":    sum([
            _model_centroid is not None,
            _model_nearest  is not None,
            _model_count    is not None,
        ]),
    }


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    if _model_centroid is None:
        raise HTTPException(status_code=503, detail="Models not loaded")
    if len(req.sensor_readings) < 3:
        raise HTTPException(status_code=400, detail="Need at least 3 sensor readings")

    features = _extract_features(req)
    X = np.array([features], dtype=np.float32)

    pred_c = _model_centroid.predict(X)[0]
    pred_n = _model_nearest.predict(X)[0]
    pred_k = float(_model_count.predict(X)[0]) if _model_count else 1.0

    polygon = [
        LeakPrediction(
            row=float(pred_c[0]), col=float(pred_c[1]),
            confidence=0.9, type="centroid"
        ),
        LeakPrediction(
            row=float(pred_n[0]), col=float(pred_n[1]),
            confidence=0.7, type="nearest"
        ),
    ]

    return PredictResponse(
        predicted_polygon=polygon,
        predicted_count=round(pred_k),
        model_version=_version or "unknown",
        mae=float(_registry.get("mae") or 0.0),
        mae_nearest=_registry.get("mae_nearest"),
    )
