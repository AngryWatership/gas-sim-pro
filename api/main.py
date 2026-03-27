"""
gas-sim-pro · FastAPI inference service
Serves the 34-feature XGBoost model trained in train.ipynb.
Features must match exactly what Cell 4 produces.
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

app = FastAPI(title="gas-sim-pro inference", version="2.1.0")

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

# ── Feature order — must match Cell 4 output exactly ────────────────────
# Verified from registry/feature_order.json written by Cell 10
ALL_FEATURES = [
    "top1_col",              #  0
    "top1_row",              #  1
    "top3_centroid_row",     #  2
    "top3_centroid_col",     #  3
    "wind_x",                #  4
    "wind_y",                #  5
    "wind_angle",            #  6
    "t1_t2_ratio",           #  7
    "t1_t3_ratio",           #  8
    "coverage_ratio",        #  9
    "centroid_col",          # 10
    "top2_reading",          # 11
    "top3_col",              # 12
    "sensor_mean",           # 13
    "top3_reading",          # 14
    "top2_col",              # 15
    "open_path_ratio",       # 16
    "walls_blocking_top1",   # 17
    "top3_row",              # 18
    "top1_reading",          # 19
    "t1_t2_vec_row",         # 20
    "t1_t2_vec_col",         # 21
    "distance_to_boundary",  # 22
    "wall_density",          # 23
    "t1_t2_dist",            # 24
    "sensor_count",          # 25
    "walls_q1",              # 26
    "wall_spread_row",       # 27
    "reading_variance",      # 28
    "wind_corr_row",         # 29
    "wind_corr_col",         # 30
    "disp_row",              # 31
    "disp_col",              # 32
    "wall_asymmetry_col",    # 33
    "wall_asymmetry_row",    # 34
]
N_FEATURES = len(ALL_FEATURES)  # 35

_registry = None
_model    = None
_version  = None


def _load_model(path: str):
    gcs   = storage.Client(project=PROJECT_ID)
    local = f"/tmp/{path.replace('/', '_')}"
    gcs.bucket(BUCKET).blob(path).download_to_filename(local)
    return joblib.load(local)


@app.on_event("startup")
def startup():
    global _registry, _model, _version
    gcs = storage.Client(project=PROJECT_ID)
    _registry = json.loads(
        gcs.bucket(BUCKET).blob("model_registry.json").download_as_text()
    )
    path = _registry.get("joblib_path") or _registry.get("model_path")
    if not path:
        raise RuntimeError("No model in registry — run Colab training first")
    _model   = _load_model(path)
    _version = _registry.get("latest_version", "unknown")
    log.info("Serving version: %s  MAE: %s  Features: %d",
             _version, _registry.get("mae"), N_FEATURES)


class SensorReading(BaseModel):
    row:     float
    col:     float
    reading: float


class PredictRequest(BaseModel):
    sensor_readings:     list[SensorReading]
    wind_x:              float = 0.0
    wind_y:              float = 0.0
    diffusion_rate:      float = 0.10
    decay_factor:        float = 0.999
    leak_injection:      float = 20.0
    # Wall features — computed in useInference.ts from state.blockedCells/doorCells
    n_walls:             int   = 0
    n_doors:             int   = 0
    wall_density:        float = 0.0
    open_path_ratio:     float = 1.0
    wall_centroid_row:   float = 50.0
    wall_centroid_col:   float = 50.0
    wall_spread_row:     float = 0.0
    walls_q1:            int   = 0
    walls_q2:            int   = 0
    walls_q3:            int   = 0
    walls_q4:            int   = 0
    walls_blocking_top1: int   = 0
    wall_asymmetry_col:  float = 0.0
    wall_asymmetry_row:  float = 0.0


class LeakPrediction(BaseModel):
    row:        float
    col:        float
    confidence: float


class PredictResponse(BaseModel):
    predicted_polygon: list[LeakPrediction]
    model_version:     str
    mae:               float


def _build_features(req: PredictRequest) -> np.ndarray:
    sensors  = req.sensor_readings
    rows     = [s.row     for s in sensors]
    cols     = [s.col     for s in sensors]
    n        = len(sensors)

    # NO normalisation — model trained on raw readings from dbt
    readings = [s.reading for s in sensors]
    total    = sum(readings) or 1e-9
    mean_r   = total / n

    sensor_delta    = max(readings) - min(readings)
    reading_var     = sum((r - mean_r)**2 for r in readings) / max(n - 1, 1)
    centroid_row    = sum(rows[i]*readings[i] for i in range(n)) / total
    centroid_col    = sum(cols[i]*readings[i] for i in range(n)) / total
    coverage_ratio  = sum(1 for r in readings if r > 0.10) / n
    wind_angle      = math.atan2(req.wind_y, req.wind_x)
    dist_boundary   = min(centroid_row, 100-centroid_row,
                          centroid_col, 100-centroid_col)

    # Sort sensors by reading descending — top1, top2, top3
    sorted_s = sorted(zip(readings, rows, cols), reverse=True)
    def get(idx, default_r=50.0, default_c=50.0, default_v=0.0):
        if idx < len(sorted_s):
            return sorted_s[idx][1], sorted_s[idx][2], sorted_s[idx][0]
        return default_r, default_c, default_v

    top1_r, top1_c, top1_v = get(0)
    top2_r, top2_c, top2_v = get(1)
    top3_r, top3_c, top3_v = get(2)

    top_total = top1_v + top2_v + top3_v + 1e-9
    top3_cen_row = (top1_r*top1_v + top2_r*top2_v + top3_r*top3_v) / top_total
    top3_cen_col = (top1_c*top1_v + top2_c*top2_v + top3_c*top3_v) / top_total
    t1_t2_ratio  = top1_v / (top2_v + 1e-9)
    t1_t3_ratio  = top1_v / (top3_v + 1e-9)
    t1_t2_dist   = min(math.sqrt((top1_r-top2_r)**2 + (top1_c-top2_c)**2), 142.0)
    t1_t2_vec_row = top1_r - top2_r
    t1_t2_vec_col = top1_c - top2_c

    # Derived
    wind_corr_row = centroid_row - req.wind_y * 5
    wind_corr_col = centroid_col - req.wind_x * 5
    disp_row      = top1_r - centroid_row
    disp_col      = top1_c - centroid_col
    # Build vector in exact order matching ALL_FEATURES (verified from feature_order.json)
    feat = [
        top1_c,                      #  0 top1_col
        top1_r,                      #  1 top1_row
        top3_cen_row,                #  2 top3_centroid_row
        top3_cen_col,                #  3 top3_centroid_col
        req.wind_x,                  #  4 wind_x
        req.wind_y,                  #  5 wind_y
        wind_angle,                  #  6 wind_angle
        t1_t2_ratio,                 #  7 t1_t2_ratio
        t1_t3_ratio,                 #  8 t1_t3_ratio
        coverage_ratio,              #  9 coverage_ratio
        centroid_col,                # 10 centroid_col
        top2_v,                      # 11 top2_reading
        top3_c,                      # 12 top3_col
        mean_r,                      # 13 sensor_mean
        top3_v,                      # 14 top3_reading
        top2_c,                      # 15 top2_col
        req.open_path_ratio,            # 16 open_path_ratio
        float(req.walls_blocking_top1), # 17 walls_blocking_top1
        top3_r,                      # 18 top3_row
        top1_v,                      # 19 top1_reading
        t1_t2_vec_row,               # 20 t1_t2_vec_row
        t1_t2_vec_col,               # 21 t1_t2_vec_col
        dist_boundary,               # 22 distance_to_boundary
        req.wall_density,            # 23 wall_density
        t1_t2_dist,                  # 24 t1_t2_dist
        float(n),                    # 25 sensor_count
        float(req.walls_q1),         # 26 walls_q1
        req.wall_spread_row,         # 27 wall_spread_row
        reading_var,                 # 28 reading_variance
        wind_corr_row,               # 29 wind_corr_row
        wind_corr_col,               # 30 wind_corr_col
        disp_row,                    # 31 disp_row
        disp_col,                    # 32 disp_col
        req.wall_asymmetry_col,      # 33 wall_asymmetry_col
        req.wall_asymmetry_row,      # 34 wall_asymmetry_row
    ]

    assert len(feat) == N_FEATURES, f"Feature count mismatch: {len(feat)} vs {N_FEATURES}"
    return np.array([feat], dtype=np.float32)


@app.get("/health")
def health():
    return {
        "status":  "ok",
        "version": _version,
        "mae":     _registry.get("mae") if _registry else None,
        "n_features": N_FEATURES,
    }


@app.post("/debug_features")
def debug_features(req: PredictRequest):
    """Returns the feature vector as the API builds it — for debugging."""
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    X    = _build_features(req)
    feat = X[0].tolist()
    return {
        "n_features": len(feat),
        "features": {ALL_FEATURES[i]: round(float(feat[i]), 4) for i in range(len(feat))},
        "raw": feat,
    }


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    if _model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    if len(req.sensor_readings) < 3:
        raise HTTPException(status_code=400, detail="Need at least 3 sensor readings")

    X    = _build_features(req)
    pred = _model.predict(X)[0]

    return PredictResponse(
        predicted_polygon=[
            LeakPrediction(row=float(pred[0]), col=float(pred[1]), confidence=0.9)
        ],
        model_version=_version or "unknown",
        mae=float(_registry.get("mae") or 0.0),
    )