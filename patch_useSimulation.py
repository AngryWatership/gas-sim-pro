"""
Patches useSimulation.ts to use useInference instead of direct estimateLeakPosition.
Run from repo root: python3 patch_useSimulation.py
"""
import re, sys

path = "src/hooks/useSimulation.ts"
try:
    with open(path) as f:
        src = f.read()
except FileNotFoundError:
    print(f"ERROR: {path} not found — run from repo root")
    sys.exit(1)

original = src

# ── Patch 1: swap imports ─────────────────────────────────────────────────
src = src.replace(
    'import { getSensorReadings, estimateLeakPosition } from "../engine/triangulation";\n'
    'import type { EstimationResult } from "../engine/triangulation";',
    'import { useInference } from "./useInference";'
)

# ── Patch 2: also remove if they appear separately ───────────────────────
src = re.sub(r'import \{ getSensorReadings[^}]*\} from "[^"]*triangulation";\n', '', src)
src = re.sub(r'import type \{ EstimationResult \} from "[^"]*";\n', '', src)

# ── Patch 3: replace useState(estimation) with useInference ──────────────
src = src.replace(
    '  const [estimation, setEstimation] = useState<EstimationResult | null>(null);',
    '  const { estimation, inferenceStatus, runInference } = useInference();'
)

# ── Patch 4: remove pendingEstRef declaration ─────────────────────────────
src = re.sub(r'  const pendingEstRef\s*=\s*useRef[^;]+;\n', '', src)

# ── Patch 5: replace estimateLeakPosition call with runInference ──────────
src = re.sub(
    r'if \(tickCountRef\.current % ESTIMATION_EVERY_N_TICKS === 0\) \{[^}]+getSensorReadings[^}]+estimateLeakPosition[^}]+\}',
    '''if (tickCountRef.current % ESTIMATION_EVERY_N_TICKS === 0) {
          runInference(
            { ...stateRef.current, grid: next.grid },
            paramsRef.current,
          );
        }''',
    src,
    flags=re.DOTALL
)

# ── Patch 6: remove pendingEstRef drain block ─────────────────────────────
src = re.sub(
    r'\s*if \(pendingEstRef\.current !== undefined\) \{[^}]+\}',
    '\n      // estimation state managed by useInference',
    src,
    flags=re.DOTALL
)

# ── Patch 7: remove setEstimation(null) from reset ───────────────────────
src = src.replace(
    'setRunning(false); setEstimation(null); dispatch({ type: "RESET" });',
    'setRunning(false); dispatch({ type: "RESET" });'
)

# ── Patch 8: add inferenceStatus to return value ──────────────────────────
src = src.replace(
    '    simState, windShadow,\n    running, tool, setTool, estimation,',
    '    simState, windShadow,\n    running, tool, setTool, estimation, inferenceStatus,'
)

if src == original:
    print("WARNING: no changes made — file may already be patched or targets not found")
else:
    with open(path, "w") as f:
        f.write(src)
    print("useSimulation.ts patched successfully")
    print("  ✓ Import: useInference replaces estimateLeakPosition")
    print("  ✓ useState(estimation) replaced with useInference()")
    print("  ✓ pendingEstRef removed")
    print("  ✓ Physics loop calls runInference()")
    print("  ✓ pendingEstRef drain removed")
    print("  ✓ setEstimation(null) removed from reset")
    print("  ✓ inferenceStatus added to return value")
