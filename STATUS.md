# Project status
> Update this file at the end of every session. Nothing else. 2 minutes max.

---

## Now

| Field | Value |
|---|---|
| **Active ENV** | V2 — Full Automation |
| **Current task** | V2.8 — TRAIN button GCS-only state logic |
| **Blocked by** | nothing |
| **Last Git tag** | v1.5.0 (v2.0.0 pending) |
| **Last session** | 2026-03-22 |

---

## Next session starts with

V2.8 — fix useTrainButton.ts to use GCS-only timestamps · remove localStorage dependency

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
- [ ] V2.8 — TRAIN button GCS-only · remove localStorage · training_status.txt states
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

---

## How to update

1. **Current task** → next unchecked item
2. **Last session** → today's date
3. **Next session starts with** → paste the task description
4. **ENV progress** → update state emoji if an ENV moved
5. **Gates passed** → check any gates you cleared
6. **Session log** → add one line
