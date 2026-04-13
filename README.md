# gas-sim-pro v2.2.0

A real-time 2D gas leak detection simulator with ML-powered inference.

Draw a room, place sensors, watch gas diffuse — the model predicts the leak location in real time.

**[Try the live demo →](https://angrywatership.github.io/gas-sim-pro)**

---

## What it does

- **Physics simulator** — FTCS diffusion + first-order upwind advection on a 100×100 grid with wind, walls, and doors
- **ML inference** — XGBoost model trained on 1.8M simulations predicts leak position from sensor readings
- **34 engineered features** — sensor aggregates, top-3 spatial positions, triangulation, wall geometry
- **Real-time API** — FastAPI on Cloud Run, responds in <50ms
- **Automated data pipeline** — browser uploads training data directly to BigQuery via Cloud Function
- **MAE 0.037 cells** — sub-pixel accuracy on validation set

---

## How to use the demo

1. **Draw walls** — click and drag to place walls. Add doors to create openings
2. **Place a gas leak** — select the gas leak tool, click anywhere on the grid
3. **Add sensors** — scatter 5-15 sensors around the room
4. **Hit Play** — gas diffuses through the layout, the ML model predicts the leak position live
5. **Generate random** — one-click random layout with 1 leak, random walls/doors/sensors/wind

The ESTIMATION panel shows the predicted row/col and position error against the actual leak.

---

## Architecture

```
Browser (React + TypeScript)
  ├── Physics simulation (Web Worker — off main thread)
  ├── ML inference → POST /predict → Cloud Run API
  └── Data upload → Cloud Function → BigQuery

BigQuery (raw.simulation_ticks)
  └── dbt → fct_training_examples → ml_export (34 features)
             └── Parquet export → GCS

Google Colab (train.ipynb)
  ├── Load Parquet from GCS
  ├── XGBoost training (Optuna hyperparameter search)
  ├── MAE gate — only deploys if improvement > 2%
  └── Deploy → GCS → Cloud Run (auto via Cloud Function)
```

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, GitHub Pages |
| Physics | Custom FTCS diffusion engine, Web Worker |
| Data | Google BigQuery, dbt, Parquet |
| ML Training | XGBoost 3.2.0, scikit-learn 1.6.1, Google Colab |
| Serving | FastAPI, Cloud Run, Google Cloud Storage |
| CI/CD | GitHub Actions |

---

## Local development

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` and fill in your GCP values.

```bash
cp .env.example .env.local
```

## Run tests

```bash
npm test
```

## Build

```bash
npm run build
```

---

## ML Pipeline

The training pipeline runs in Google Colab (`notebooks/train.ipynb`):

1. Loads feature Parquet from GCS (`features/latest/`)
2. Applies signal threshold filter (`sensor_delta >= 0.15`)
3. Trains XGBoost with Optuna hyperparameter search
4. Gates deployment — only proceeds if new MAE < current MAE × 0.98
5. Uploads model to GCS, triggers Cloud Run redeployment

Feature engineering lives in `dbt/gas_sim_dbt/models/`:
- `fct_training_examples.sql` — aggregates raw ticks into training rows
- `ml_export.sql` — filters and selects the 34 production features

---

## Project structure

```
src/
  engine/       Physics types, diffusion engine
  utils/        Color mapping, layout I/O, Bresenham, wind shadow, random layout
  components/   Canvas, control panels, sensor stats
  hooks/        useSimulation, useInference, useTrainButton
  workers/      Data generator Web Worker

api/
  main.py       FastAPI inference service (34-feature XGBoost)
  requirements.txt

dbt/gas_sim_dbt/
  models/
    staging/    stg_simulation_ticks
    features/   fct_training_examples, fct_training_chained
    marts/      ml_export, ml_export_multileak

notebooks/
  train.ipynb   13-cell training notebook

functions/
  ingest-http/  Cloud Function — browser → BigQuery upload
  deploy/       Cloud Function — auto-deploy on registry update
```

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features including:
- Multi-leak detection (chained prediction model)
- Wall segment geometry features
- In-browser ONNX inference (zero Cloud Run cost)
- Automated nightly retraining

---

## Physics notes

- Diffusion coefficient `D` hard-clamped to `0.124` (von Neumann stability limit)
- Wind velocity clamped to `±0.9 cells/tick` (CFL condition)
- Wind shadow recomputed only on layout or wind changes via `useMemo`
- Zero-flux Neumann boundary conditions at walls
