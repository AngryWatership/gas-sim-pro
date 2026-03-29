# Project status
> Update this file at the end of every session. Nothing else. 2 minutes max.

---

## Now

| Field | Value |
|---|---|
| **Active ENV** | V2 — Full Automation |
| **Current task** | V2.13 — overnight data generation · Optuna · multi-leak experiment |
| **Blocked by** | nothing |
| **Last Git tag** | v2.0.0 |
| **Last session** | 2026-03-29 |

---

## Next session starts with

V2.13 — start overnight generation · run Optuna (Cell 6b) · tag v2.1.0

---

## ENV progress

| ENV | Name | State |
|---|---|---|
| **A** | Simulator + data factory | ✅ Gates passed |
| **B** | Data engineering (GCP) | ✅ Gates passed |
| **C** | ML — Google Colab | ✅ Gates passed |
| **D** | Cloud serving | ✅ Gates passed |
| **E** | MLOps loop | ✅ Gates passed — pipeline healthy, all 7 layers green |
| **V2** | Architecture v2 — full automation | 🔵 In progress |
| **Integration** | Full pipeline wiring | ⚪ Not started |

---

## Gates passed

- [x] P0–P1 — Simulator core · v1.0.x · v1.1.0
- [x] P2 — Full ENV A · configurable generator · batch · TRAIN button · v1.2.0
- [x] P3 — Full ENV B · Cloud Function · BigQuery · dbt · Parquet · v1.3.0
- [x] P3 — GCS CORS configured · no-cache registry
- [x] P4 — ENV C complete · Colab trained · joblib in GCS · MAE 0.003
- [x] P5 — Cloud Run live · /health 200 · /predict returns polygon · CORS ok
- [x] P6 — useInference wired · status indicator · build clean
- [x] GCS rate limit diagnosed — threshold n=8, recovery 14-110s, separate file = 13/13 ✅
- [x] All 7 diagnostic layers passing
- [x] diagnostics.sh built — self-healing, layered, responsibility attribution
- [x] P7 — deploy function fires · MAE gate correct · separate file architecture working
- [x] ARCHITECTURE-V2.md written · EXPERIMENT-MULTILEAK.md written
- [x] v1.5.0 tagged
- [x] V2.1 — GitHub Pages live · deploy.yml green · simulator at github.io
- [x] V2.2 — GitHub Secrets configured · GCP service account created
- [x] V2.3 — train.yml · train.yml permissions fixed · fsspec missing (deferred)
- [ ] V2.4 — incremental XGBoost (DualBooster) · drop MultiOutputRegressor
- [x] V2.5 — ingest-http deployed · direct browser→BQ upload working ✅
- [x] V2.6 — App.tsx updated · NDJSON POSTs directly to cloud · fallback to download
- [ ] V2.7 — Pyodide training worker (after V2.8)
- [x] V2.8 — TRAIN button GCS-only · deployed/rejected flash states · immediate grey on click
- [x] train.ipynb rebuilt clean · W&B offline · gate advisory · GATE_STATUS flag · last_training_result.json
- [x] V2.9 — 1.16M rows generated · full pipeline loop confirmed end to end · v2.0.0
- [x] V2.10 — full feature engineering pipeline complete
        signal threshold analysis · wall/door Approach A · top3 sensors · triangulation
        forward+backward selection → 34 features · MAE 0.66 at threshold=0.15
- [x] V2.11 — dbt clean rewrite · 34 features in ml_export · wall features working
- [x] V2.12 — 34-feature model deployed · sklearn 1.6.1 · API updated · all 7 layers green
- [x] V2.13 — API rebuilt from scratch · xgboost 3.2.0 pinned · 10/10 predictions match
        wall features sent from useInference · 33/33 dbt vs compute_features match
        reading_variance fixed (var_samp not stddev_samp) · derived features baked into dbt
- [x] V2.14 — retrained 34-feature model · Optuna · MAE 0.0368 · API rebuilt xgboost 3.2.0
        all 7 diagnostics green · simulator predictions working · tagged v2.2.0
- [ ] V2.15 — data generation · multi-leak · wall segment features
- [ ] Integration — full loop timed · chaos tests passed

---

## Session log

| Date | Finished | Left open |
|---|---|---|
| 2026-03-15 | P0–P4 complete | ENV D |
| 2026-03-15 | P5 Cloud Run live · /health + /predict confirmed | P6 simulator wiring |
| 2026-03-15 | P6 useInference · status indicator · build clean · ENV D complete | P7 MLOps |
| 2026-03-15 | P7 deploy function written · ENV-E-P7-mlops.md ready | deploy + test |
| 2026-03-15 | GCS rate limit diagnosed · separate file architecture validated · 13/13 writes succeed | redeploy functions |
| 2026-03-16 | All 7 diagnostic layers green · diagnostics.sh · 15/15 tests pass · pipeline healthy | deploy function full cycle |
| 2026-03-16 | ARCHITECTURE-V2.md · EXPERIMENT-MULTILEAK.md · v1.5.0 tagged | V2 implementation |
| 2026-03-22 | V2.1-V2.6 complete · Pages live · ingest-http · direct upload working | V2.8 TRAIN button |
| 2026-03-22 | V2.8 complete · train.ipynb rebuilt · gate advisory · flash states | V2.9 data + retrain |
| 2026-03-23 | V2.9 — 1.16M rows · full loop confirmed · MAE worse (stale Parquet 145k) | Parquet fix + Optuna |
| 2026-03-24 | Feature engineering complete · 34 features selected · MAE 0.66 · wall features added | Colab run + deploy |
| 2026-03-25 | dbt clean rewrite · fct_training_examples rebuilt · ml_export 34 features · all joins fixed | Colab run |
| 2026-03-27 | 34-feature model live · API rewritten · sklearn 1.6.1 · all 7 diagnostic layers green | Optuna + data gen |
| 2026-03-28 | API rebuilt · xgboost 3.2.0 pinned · predictions match 10/10 · wall features in useInference | Simulator UI test + retrain |
| 2026-03-29 | 34-feature model · MAE 0.0368 · Optuna · API fixed · eraser fixed · 1 leak default · v2.2.0 | Future features |

---

## How to update

1. **Current task** → next unchecked item
2. **Last session** → today's date
3. **Next session starts with** → paste the task description
4. **ENV progress** → update state emoji if an ENV moved
5. **Gates passed** → check any gates you cleared
6. **Session log** → add one line
