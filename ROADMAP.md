# gas-sim-pro · Future Features Roadmap

**Current state (v2.2.0):** MAE 0.037 cells · 34 features · single-leak · all diagnostics green

---

## 🔬 Model Improvements

### Data Generation
- Generate 500k+ rows overnight at `sensor_delta >= 0.15` threshold
- More high-quality rows → lower MAE without changing architecture
- Run: simulator batch generation → ingest-http → dbt → Colab retrain

### Hyperparameter Search
- Run Optuna with `N_TRIALS = 100` on larger dataset
- Current best params from 40 trials — more trials expected to push MAE below 0.025
- Enable `RUN_OPTUNA = True` in Cell 6b

### Wall Segment Features (Approach C)
- Currently using aggregate wall statistics (density, quadrant counts)
- Next level: detect top-3 wall segments as line objects
- Features per segment: `center_row`, `center_col`, `length`, `angle` (0° or 90°)
- Implementation: Python during Colab feature engineering (not dbt — easier contiguity logic)
- Expected improvement: significant for complex walled layouts

### Normalisation Strategy
- Current: raw readings fed to model
- Future: per-row normalisation by `top1_reading` to make predictions time-invariant
- Requires retraining — do after more data is available

---

## 🧪 Multi-Leak Experiment

### Infrastructure (already built)
- `fct_training_chained.sql` — chained training samples in repo
- `ml_export_multileak.sql` — multi-leak export query
- `EXPERIMENT-MULTILEAK.md` — full experiment spec

### Steps to activate
1. Set `leakCountMax: 3` in `generatorConfig.ts` (currently 1)
2. Generate 200k+ multi-leak records
3. Train `train_multileak.ipynb` on experiment branch
4. Evaluate: does chained prediction outperform centroid prediction?

### Model architecture options
- **Chained:** predict leak 1, subtract its influence, predict leak 2
- **Multi-output:** predict (row1, col1, row2, col2) simultaneously
- **Count first:** predict n_leaks, then route to single/multi model

---

## 🖥️ Frontend Features

### Prediction UI
- Show prediction confidence radius (circle around predicted point)
- Show prediction history trail as gas diffuses
- Color-code prediction error when true leak position is known

### Layout Tools
- Copy/paste wall segments
- Undo/redo stack for layout edits
- Save named layouts to localStorage

### Sensor Features
- Sensor sensitivity settings (per-sensor threshold)
- Sensor failure simulation (random dropout)
- Optimal sensor placement suggestion based on model uncertainty

---

## 🔧 Infrastructure

### train.yml GitHub Actions
- Fix missing `fsspec` dependency (currently deferred)
- Enable fully automated retraining on schedule (nightly)
- Slack/email notification on gate pass/fail

### Model Versioning
- Store full feature list in registry per version
- Auto-detect feature mismatch between API and model on startup
- Rollback mechanism: keep last 3 model versions in GCS

### Monitoring
- Log prediction requests to BigQuery for drift detection
- Alert when prediction error exceeds threshold (requires ground truth feedback)
- A/B testing infrastructure for model comparison

### Multi-region
- Currently deployed in `us-central1` only
- Add EU region for lower latency from Morocco/Europe

---

## 📊 Evaluation

### Offline metrics (currently tracked)
- MAE on val set — current best: 0.037 cells
- Per-quadrant MAE breakdown (is model worse near walls?)

### Online metrics (not yet implemented)
- Real-time prediction error when user confirms leak position
- Time-to-accurate-prediction (how many ticks until error < 5 cells)
- Comparison vs triangulation heuristic baseline

---

## Priority Order

| Priority | Item | Effort | Expected Impact |
|---|---|---|---|
| 🔴 High | Generate 500k+ rows | Low | MAE → ~0.025 |
| 🔴 High | Fix train.yml fsspec | Low | Full automation |
| 🟡 Medium | Wall segment features | Medium | MAE → ~0.015 |
| 🟡 Medium | Multi-leak experiment | High | New capability |
| 🟢 Low | Prediction confidence UI | Medium | UX improvement |
| 🟢 Low | Sensor placement hints | High | New capability |
| 🟢 Low | Multi-region deploy | Low | Latency improvement |
