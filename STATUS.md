# Project status
> Update this file at the end of every session. Nothing else. 2 minutes max.

---

## Now

| Field | Value |
|---|---|
| **Active ENV** | D — Cloud Serving |
| **Current task** | P7 — redeploy both functions · verify full loop end to end |
| **Blocked by** | nothing |
| **Last Git tag** | v1.3.0 |
| **Last session** | 2026-03-15 |

---

## Next session starts with

P7 — run git.sh · redeploy ingest-ndjson + deploy-model · upload fresh NDJSON · verify TRAIN button deactivates

---

## ENV progress

| ENV | Name | State |
|---|---|---|
| **A** | Simulator + data factory | ✅ Gates passed |
| **B** | Data engineering (GCP) | ✅ Gates passed |
| **C** | ML — Google Colab | ✅ Gates passed |
| **D** | Cloud serving | ✅ Gates passed |
| **E** | MLOps loop | 🔵 In progress |
| **Polish** | P8 — model card, README, demo | ⚪ Not started |
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
- [ ] P7 — redeploy both functions · full loop confirmed · TRAIN button deactivates
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

---

## How to update

1. **Current task** → next unchecked item
2. **Last session** → today's date
3. **Next session starts with** → paste the task description
4. **ENV progress** → update state emoji if an ENV moved
5. **Gates passed** → check any gates you cleared
6. **Session log** → add one line
