# Demo Cost Analysis — Reducing GCS/Cloud Run Spend

## What currently costs money per user visit

### 1. Cloud Run `/predict` — HIGHEST COST
- Called every simulation tick (~33ms) while gas is diffusing
- Each call = Cloud Run CPU time + network egress
- A 60-second demo session = ~1800 predict calls
- Cloud Run pricing: $0.00002400/vCPU-second + $0.00000250/GiB-second
- **Estimated per user: ~$0.001–0.005 depending on session length**
- Scales linearly with number of concurrent users

### 2. GCS reads from useTrainButton — MEDIUM COST
- Polls GCS every 60 seconds: `model_registry.json` + 5 registry files = 6 reads/min
- GCS Class A operations: $0.05/10k operations
- Per user per hour: 360 reads = ~$0.0018
- **Low individually but adds up with many users**

### 3. Cloud Run `/health` — LOW COST
- Called by diagnostics and useTrainButton
- Minimal cost

---

## Options to reduce cost

### Option A — Rate-limit the prediction calls (EASIEST, immediate)
**Change:** Only call `/predict` every N ticks instead of every tick.
**File:** `useSimulation.ts` — add a counter to `runInference`

```typescript
// Only call API every 10 ticks (~300ms) instead of every tick (33ms)
const inferenceTickRef = useRef(0);
inferenceTickRef.current++;
if (inferenceTickRef.current % 10 === 0) {
  runInference({ ...stateRef.current, grid: next.grid }, paramsRef.current);
}
```

**Cost reduction: 90%** on Cloud Run calls with no UX degradation — predictions update every 300ms which is imperceptible to users.

---

### Option B — Cache prediction by sensor state (MEDIUM, good UX)
**Change:** Only call API when sensor readings change significantly (>5% delta from last call).
**File:** `useInference.ts` — compare current max reading to last call's max reading.

```typescript
const lastMaxReadingRef = useRef(0);
const maxReading = Math.max(...allVals);
if (Math.abs(maxReading - lastMaxReadingRef.current) / Math.max(maxReading, 1e-9) < 0.05) {
  return; // skip — readings haven't changed enough
}
lastMaxReadingRef.current = maxReading;
```

**Cost reduction: 70-85%** — early ticks have rapidly changing readings, later ticks plateau.

---

### Option C — Move model inference to the browser (ZERO Cloud Run cost)
**Change:** Export model to ONNX or TensorFlow.js, run entirely client-side.
**Effort:** High — requires model conversion pipeline.

Steps:
1. In Colab: `import onnxmltools; onnxmltools.convert_sklearn(model, ...)`
2. Serve the `.onnx` file from GitHub Pages (free)
3. In browser: use `onnxruntime-web` to run inference

**Cost reduction: 100% on Cloud Run** — only GCS polling remains.
**Tradeoff:** ~2MB WASM bundle, ~50ms inference latency in browser vs ~20ms Cloud Run.

---

### Option D — Replace GCS polling with static config (EASIEST for registry)
**Change:** Embed model version/MAE in the built JS bundle at deploy time instead of fetching from GCS.

Currently `useTrainButton` fetches 6 GCS files every 60s. For public demo users who never train, this is wasted.

```typescript
// In useTrainButton.ts — add env var check
const IS_DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

if (IS_DEMO_MODE) {
  // Return static state — no GCS polling for demo users
  setState("current");
  setModelVersion(import.meta.env.VITE_MODEL_VERSION ?? "demo");
  setLastMae(parseFloat(import.meta.env.VITE_MODEL_MAE ?? "0"));
  return;
}
```

Add to `.env.production`:
```
VITE_DEMO_MODE=true
VITE_MODEL_VERSION=v20260329-tc99xved
VITE_MODEL_MAE=0.0368
```

**Cost reduction: 100% on GCS polling** — zero reads for demo users.
**Downside:** Model version shown is stale until next build/deploy.

---

### Option E — Throttle + Demo mode together (RECOMMENDED)
Combine Options A + D:

1. **`useTrainButton`** — `VITE_DEMO_MODE=true` eliminates all GCS polling
2. **`useSimulation`** — call inference every 10 ticks (300ms) not every tick
3. **`useInference`** — skip call if max reading < 0.001 (already implemented)

**Combined cost reduction: ~95%**
**Implementation time: ~1 hour**
**No UX degradation for demo users**

---

## Recommended implementation

### Step 1 — Add VITE_DEMO_MODE to useTrainButton
```typescript
// At top of useTrainButton.ts
const IS_DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

export function useTrainButton(): UseTrainButton {
  // Short-circuit for demo mode — no GCS polling
  if (IS_DEMO_MODE) {
    return {
      state:        "current",
      modelVersion: import.meta.env.VITE_MODEL_VERSION ?? "demo",
      lastMae:      parseFloat(import.meta.env.VITE_MODEL_MAE ?? "0"),
      isTraining:   false,
      gateStatus:   null,
      onTrain:      () => window.open(COLAB_URL, "_blank"),
    };
  }
  // ... rest of hook unchanged
}
```

### Step 2 — Throttle inference calls in useSimulation
```typescript
// In the rAF tick loop
const inferenceCounter = useRef(0);

function tick(now: number) {
  if (now - lastTickRef.current >= interval) {
    lastTickRef.current = now;
    const next = stepDiffusion(...);
    dispatch({ type: "SET_GRID", grid: next.grid });

    inferenceCounter.current++;
    if (inferenceCounter.current % 10 === 0) {  // every 10 ticks = 300ms
      runInference({ ...stateRef.current, grid: next.grid }, paramsRef.current);
    }
  }
}
```

### Step 3 — Update .env.production
```
VITE_DEMO_MODE=true
VITE_MODEL_VERSION=v20260329-tc99xved
VITE_MODEL_MAE=0.0368
VITE_IS_DEVELOPER=false
```

---

## Cost estimate after changes

| Component | Before | After | Reduction |
|---|---|---|---|
| Cloud Run /predict | 1800 calls/60s session | 180 calls/60s session | 90% |
| GCS registry polling | 6 reads/min | 0 reads/min | 100% |
| Cloud Run /health | Minimal | Minimal | 0% |
| **Total per user** | **~$0.003** | **~$0.0003** | **~90%** |

At 1000 demo users/month: **$3 → $0.30/month**

---

## Long-term: full offline mode (Option C)
If traffic grows significantly, export model to ONNX and serve from GitHub Pages.
Zero Cloud Run cost for inference. Only cost is GCS for data uploads from the simulation worker.
