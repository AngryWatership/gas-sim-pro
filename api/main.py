"""
gas-sim-pro · FastAPI inference service
Clean rewrite — versions pinned to match Colab training environment exactly:
  xgboost==3.2.0  sklearn==1.6.1  numpy==2.0.2  joblib==1.5.3

Feature order matches registry/feature_order.json (35 features).
No normalisation — model trained on raw readings.
"""

import os, json, math, logging
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

app = FastAPI(title="gas-sim-pro inference", version="2.2.0")
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

# ── Feature order — verified from registry/feature_order.json ────────────
# Feature order matches Cell 4 output exactly (33 features, no ratios)
FEATURES = [
    "top1_col",              #  0
    "top1_row",              #  1
    "top3_centroid_row",     #  2
    "top3_centroid_col",     #  3
    "wind_x",                #  4
    "wind_y",                #  5
    "wind_angle",            #  6
    "coverage_ratio",        #  7
    "centroid_col",          #  8
    "top2_reading",          #  9
    "top3_col",              # 10
    "sensor_mean",           # 11
    "top3_reading",          # 12
    "top2_col",              # 13
    "open_path_ratio",       # 14
    "walls_blocking_top1",   # 15
    "top3_row",              # 16
    "top1_reading",          # 17
    "t1_t2_vec_row",         # 18
    "t1_t2_vec_col",         # 19
    "distance_to_boundary",  # 20
    "wall_density",          # 21
    "t1_t2_dist",            # 22
    "wall_asymmetry_col",    # 23
    "sensor_count",          # 24
    "walls_q1",              # 25
    "wall_spread_row",       # 26
    "reading_variance",      # 27
    "wall_asymmetry_row",    # 28
    "wind_corr_row",         # 29
    "wind_corr_col",         # 30
    "disp_row",              # 31
    "disp_col",              # 32
    "t1_t2_ratio",           # 33
]
N_FEATURES = len(FEATURES)  # 34

# ── Global state ──────────────────────────────────────────────────────────
_model    = None
_registry = None
_version  = None


def _load_model(path: str):
    gcs   = storage.Client(project=PROJECT_ID)
    local = f"/tmp/model_{path.replace('/', '_')}.joblib"
    gcs.bucket(BUCKET).blob(path).download_to_filename(local)
    return joblib.load(local)


@app.on_event("startup")
def startup():
    global _model, _registry, _version
    gcs = storage.Client(project=PROJECT_ID)
    _registry = json.loads(
        gcs.bucket(BUCKET).blob("model_registry.json").download_as_text()
    )
    path = _registry.get("joblib_path") or _registry.get("model_path")
    if not path:
        raise RuntimeError("No model path in registry")
    _model   = _load_model(path)
    _version = _registry.get("latest_version", "unknown")
    log.info("Loaded version=%s  MAE=%s  features=%d",
             _version, _registry.get("mae"), N_FEATURES)


# ── Request / Response schemas ────────────────────────────────────────────
class SensorReading(BaseModel):
    row:     float
    col:     float
    reading: float


class PredictRequest(BaseModel):
    sensor_readings:     list[SensorReading]
    wind_x:              float = 0.0
    wind_y:              float = 0.0
    diffusion_rate:      float = 0.10
    decay_factor:        float = 0.99
    leak_injection:      float = 8.0
    # Wall features — computed client-side in useInference.ts
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


# ── Feature extraction ────────────────────────────────────────────────────
def _build_features(req: PredictRequest) -> np.ndarray:
    sensors  = req.sensor_readings
    readings = [s.reading for s in sensors]
    rows_s   = [s.row     for s in sensors]
    cols_s   = [s.col     for s in sensors]
    n        = len(readings)
    total    = sum(readings) or 1e-9
    mean_r   = total / n

    # Sensor aggregates — raw readings, no normalisation
    reading_var    = sum((r - mean_r)**2 for r in readings) / max(n - 1, 1)
    centroid_row   = sum(rows_s[i]*readings[i] for i in range(n)) / total
    centroid_col   = sum(cols_s[i]*readings[i] for i in range(n)) / total
    coverage_ratio = sum(1 for r in readings if r > 0.01) / n
    wind_angle     = math.atan2(req.wind_y, req.wind_x)
    dist_boundary  = min(centroid_row, 100-centroid_row,
                         centroid_col, 100-centroid_col)

    # Top-3 sensors by reading
    sorted_s = sorted(zip(readings, rows_s, cols_s), reverse=True)
    def get(idx):
        return sorted_s[idx] if idx < len(sorted_s) else (0.0, 50.0, 50.0)
    top1_v, top1_r, top1_c = get(0)
    top2_v, top2_r, top2_c = get(1)
    top3_v, top3_r, top3_c = get(2)

    # Ratios
    t1_t2_ratio  = min(top1_v / (top2_v + 1e-9), 10000.0)

    # Triangulation
    top_total    = top1_v + top2_v + top3_v + 1e-9
    top3_cen_row = (top1_r*top1_v + top2_r*top2_v + top3_r*top3_v) / top_total
    top3_cen_col = (top1_c*top1_v + top2_c*top2_v + top3_c*top3_v) / top_total
    t1_t2_dist   = min(math.sqrt((top1_r-top2_r)**2 + (top1_c-top2_c)**2), 142.0)
    t1_t2_vec_row = top1_r - top2_r
    t1_t2_vec_col = top1_c - top2_c

    # Derived
    wind_corr_row = centroid_row - req.wind_y * 5
    wind_corr_col = centroid_col - req.wind_x * 5
    disp_row      = top1_r - centroid_row
    disp_col      = top1_c - centroid_col

    # Build vector in exact FEATURES order (33 features, no ratios)
    feat = [
        top1_c,                         #  0 top1_col
        top1_r,                         #  1 top1_row
        top3_cen_row,                   #  2 top3_centroid_row
        top3_cen_col,                   #  3 top3_centroid_col
        req.wind_x,                     #  4 wind_x
        req.wind_y,                     #  5 wind_y
        wind_angle,                     #  6 wind_angle
        coverage_ratio,                 #  7 coverage_ratio
        centroid_col,                   #  8 centroid_col
        top2_v,                         #  9 top2_reading
        top3_c,                         # 10 top3_col
        mean_r,                         # 11 sensor_mean
        top3_v,                         # 12 top3_reading
        top2_c,                         # 13 top2_col
        req.open_path_ratio,            # 14 open_path_ratio
        float(req.walls_blocking_top1), # 15 walls_blocking_top1
        top3_r,                         # 16 top3_row
        top1_v,                         # 17 top1_reading
        t1_t2_vec_row,                  # 18 t1_t2_vec_row
        t1_t2_vec_col,                  # 19 t1_t2_vec_col
        dist_boundary,                  # 20 distance_to_boundary
        req.wall_density,               # 21 wall_density
        t1_t2_dist,                     # 22 t1_t2_dist
        req.wall_asymmetry_col,         # 23 wall_asymmetry_col
        float(n),                       # 24 sensor_count
        float(req.walls_q1),            # 25 walls_q1
        req.wall_spread_row,            # 26 wall_spread_row
        reading_var,                    # 27 reading_variance
        req.wall_asymmetry_row,         # 28 wall_asymmetry_row
        wind_corr_row,                  # 29 wind_corr_row
        wind_corr_col,                  # 30 wind_corr_col
        disp_row,                       # 31 disp_row
        disp_col,                       # 32 disp_col
        t1_t2_ratio,                    # 33 t1_t2_ratio
    ]

    assert len(feat) == N_FEATURES, f"Feature count mismatch: {len(feat)} vs {N_FEATURES}"
    return np.array([feat], dtype=np.float32)


# ── Endpoints ─────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "status":     "ok",
        "version":    _version,
        "mae":        _registry.get("mae") if _registry else None,
        "n_features": N_FEATURES,
    }


@app.post("/debug_features")
def debug_features(req: PredictRequest):
    X   = _build_features(req)
    raw = X[0].tolist()
    return {
        "n_features": len(raw),
        "features":   {FEATURES[i]: round(raw[i], 6) for i in range(len(raw))},
        "raw":        raw,
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
            LeakPrediction(
                row=float(pred[0]),
                col=float(pred[1]),
                confidence=0.9,
            )
        ],
        model_version=_version or "unknown",
        mae=float(_registry.get("mae") or 0.0),
    )