"""
ENV D — FastAPI inference service
Loads model.joblib from GCS on startup, serves /predict endpoint.
"""

import os
import json
import math
import logging
from functools import lru_cache

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

app = FastAPI(title="gas-sim-pro inference", version="1.0.0")

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
]


# ── Model loading ─────────────────────────────────────────────────────────

def load_registry() -> dict:
    gcs = storage.Client(project=PROJECT_ID)
    return json.loads(gcs.bucket(BUCKET).blob("model_registry.json").download_as_text())


def load_model(joblib_path: str):
    gcs      = storage.Client(project=PROJECT_ID)
    local    = "/tmp/model.joblib"
    gcs.bucket(BUCKET).blob(joblib_path).download_to_filename(local)
    log.info("Model loaded from %s", joblib_path)
    return joblib.load(local)


# Load on startup — cached for the lifetime of the container
_registry = None
_model     = None
_version   = None


@app.on_event("startup")
def startup():
    global _registry, _model, _version
    _registry = load_registry()
    joblib_path = _registry.get("joblib_path")
    if not joblib_path:
        raise RuntimeError("No model in registry yet — run Colab training first")
    _model   = load_model(joblib_path)
    _version = _registry.get("latest_version", "unknown")
    log.info("Serving model version: %s  MAE: %s", _version, _registry.get("mae"))


# ── Request / response models ─────────────────────────────────────────────

class SensorReading(BaseModel):
    row:     float
    col:     float
    reading: float


class PredictRequest(BaseModel):
    sensor_readings:   list[SensorReading]
    wind_x:            float
    wind_y:            float
    diffusion_rate:    float = 0.10
    decay_factor:      float = 0.999
    leak_injection:    float = 20.0


class LeakPoint(BaseModel):
    row: float
    col: float


class PredictResponse(BaseModel):
    predicted_polygon: list[LeakPoint]
    model_version:     str
    confidence:        float
    mae:               float


# ── Feature engineering ───────────────────────────────────────────────────

def extract_features(req: PredictRequest) -> list[float]:
    readings = [s.reading for s in req.sensor_readings]
    rows     = [s.row     for s in req.sensor_readings]
    cols     = [s.col     for s in req.sensor_readings]
    n        = len(readings)

    total = sum(readings)
    mean  = total / n if n else 0.0

    sensor_delta    = max(readings) - min(readings) if readings else 0.0
    sensor_mean     = mean
    reading_variance = (
        sum((r - mean) ** 2 for r in readings) / (n - 1)
        if n > 1 else 0.0
    )

    centroid_row = (
        sum(rows[i] * readings[i] for i in range(n)) / total
        if total > 0 else 50.0
    )
    centroid_col = (
        sum(cols[i] * readings[i] for i in range(n)) / total
        if total > 0 else 50.0
    )

    coverage_ratio = sum(1 for r in readings if r > 0.01) / n if n else 0.0

    wind_angle     = math.atan2(req.wind_y, req.wind_x)
    wind_magnitude = math.sqrt(req.wind_x ** 2 + req.wind_y ** 2)

    distance_to_boundary = min(
        centroid_row,
        100 - centroid_row,
        centroid_col,
        100 - centroid_col,
    )

    return [
        sensor_delta, sensor_mean, reading_variance,
        centroid_row, centroid_col, coverage_ratio,
        wind_angle, wind_magnitude, distance_to_boundary,
        req.wind_x, req.wind_y,
        req.diffusion_rate, req.decay_factor, req.leak_injection,
        float(n),
    ]


# ── Endpoints ─────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {
        "status":  "ok",
        "version": _version,
        "mae":     _registry.get("mae") if _registry else None,
    }


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    if len(req.sensor_readings) < 3:
        raise HTTPException(status_code=400, detail="Need at least 3 sensor readings")

    features = extract_features(req)
    X        = np.array([features], dtype=np.float32)
    pred     = _model.predict(X)[0]  # [leak_row, leak_col]

    return PredictResponse(
        predicted_polygon=[LeakPoint(row=float(pred[0]), col=float(pred[1]))],
        model_version=_version or "unknown",
        confidence=1.0,
        mae=float(_registry.get("mae") or 0.0),
    )
