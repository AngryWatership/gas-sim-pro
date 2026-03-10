import { useReducer, useEffect, useRef, useCallback, useState, useMemo, startTransition } from "react";
import type {
  SimulationState, ToolMode, GasLeak, Sensor, SimParams, LayoutSnapshot,
} from "../engine/types";
import { DEFAULT_PARAMS } from "../engine/types";
import { getSensorReadings, estimateLeakPosition } from "../engine/triangulation";
import type { EstimationResult } from "../engine/triangulation";
import { stepDiffusion } from "../engine/diffusion";
import { buildWindShadow } from "../utils/windShadow";
import type { LoadTarget } from "../utils/layout";

const ROWS = 100;
const COLS = 100;

// How many physics ticks between triangulation updates (expensive JS)
const ESTIMATION_EVERY_N_TICKS = 10;

function makeInitialState(): SimulationState {
  return {
    grid: new Float32Array(ROWS * COLS),
    blockedCells: new Uint8Array(ROWS * COLS),
    doorCells: new Uint8Array(ROWS * COLS),
    gasLeaks: [],
    sensors: [],
    dimensions: { rows: ROWS, cols: COLS },
  };
}

type Action =
  | { type: "SET_GRID"; grid: Float32Array }
  | { type: "ADD_LEAK"; leak: GasLeak }
  | { type: "REMOVE_LEAK"; id: string }
  | { type: "ADD_SENSOR"; sensor: Sensor }
  | { type: "REMOVE_SENSOR"; id: string }
  | { type: "SET_WALL"; indices: number[] }
  | { type: "SET_DOOR"; indices: number[] }
  | { type: "ERASE"; indices: number[] }
  | { type: "LOAD_LAYOUT"; snapshot: LayoutSnapshot; target: LoadTarget }
  | { type: "RESET" };

function reducer(state: SimulationState, action: Action): SimulationState {
  switch (action.type) {
    case "SET_GRID":
      return { ...state, grid: action.grid };
    case "ADD_LEAK": {
      if (state.gasLeaks.some((l) => l.row === action.leak.row && l.col === action.leak.col))
        return state;
      return { ...state, gasLeaks: [...state.gasLeaks, action.leak] };
    }
    case "REMOVE_LEAK":
      return { ...state, gasLeaks: state.gasLeaks.filter((l) => l.id !== action.id) };
    case "ADD_SENSOR":
      return { ...state, sensors: [...state.sensors, action.sensor] };
    case "REMOVE_SENSOR":
      return { ...state, sensors: state.sensors.filter((s) => s.id !== action.id) };
    case "SET_WALL": {
      const next = new Uint8Array(state.blockedCells);
      action.indices.forEach((i) => { next[i] = 1; });
      return { ...state, blockedCells: next };
    }
    case "SET_DOOR": {
      const blocked = new Uint8Array(state.blockedCells);
      const doors = new Uint8Array(state.doorCells);
      action.indices.forEach((i) => { blocked[i] = 0; doors[i] = 1; });
      return { ...state, blockedCells: blocked, doorCells: doors };
    }
    case "ERASE": {
      const indexSet = new Set(action.indices);
      const blocked = new Uint8Array(state.blockedCells);
      const doors = new Uint8Array(state.doorCells);
      action.indices.forEach((i) => { blocked[i] = 0; doors[i] = 0; });
      const gasLeaks = state.gasLeaks.filter((l) => {
        const idx = l.row * state.dimensions.cols + l.col;
        return !indexSet.has(idx);
      });
      const sensors = state.sensors.filter((s) => {
        const idx = s.row * state.dimensions.cols + s.col;
        return !indexSet.has(idx);
      });
      return { ...state, blockedCells: blocked, doorCells: doors, gasLeaks, sensors };
    }
    case "LOAD_LAYOUT": {
      const { snapshot, target } = action;
      if (target === "all" || target === "walls") {
        const blocked = new Uint8Array(state.blockedCells);
        snapshot.walls.forEach((i) => { blocked[i] = 1; });
        state = { ...state, blockedCells: blocked };
      }
      if (target === "all" || target === "doors") {
        const blocked = new Uint8Array(state.blockedCells);
        const doors = new Uint8Array(state.doorCells);
        snapshot.doors.forEach((i) => { blocked[i] = 0; doors[i] = 1; });
        state = { ...state, blockedCells: blocked, doorCells: doors };
      }
      if (target === "all" || target === "sensors") {
        state = { ...state, sensors: [...state.sensors, ...snapshot.sensors] };
      }
      if (target === "all" && snapshot.gasLeaks?.length) {
        state = { ...state, gasLeaks: [...state.gasLeaks, ...snapshot.gasLeaks] };
      }
      return state;
    }
    case "RESET":
      return makeInitialState();
    default:
      return state;
  }
}

export function useSimulation() {
  const [simState, dispatch] = useReducer(reducer, undefined, makeInitialState);
  const [running, setRunning] = useState(false);
  const [tool, setTool] = useState<ToolMode>("none");
  const [estimation, setEstimation] = useState<EstimationResult | null>(null);
  const [params, setParams] = useState<SimParams>(DEFAULT_PARAMS);
  const [lightMode, setLightMode] = useState(false);

  const stateRef = useRef(simState);
  stateRef.current = simState;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const windX = params.windX;
  const windY = params.windY;
  const { blockedCells, doorCells } = simState;

  const windShadow = useMemo(
    () => buildWindShadow(blockedCells, doorCells, ROWS, COLS, windX, windY),
    [blockedCells, doorCells, windX, windY],
  );
  const windShadowRef = useRef<Uint8Array>(windShadow);
  windShadowRef.current = windShadow;

  // ── Deadlock-safe physics loop ─────────────────────────────────────────
  // Problem: calling dispatch(SET_GRID) inside rAF causes React to schedule
  // a synchronous re-render that blocks the browser's input event queue.
  // After enough ticks the event queue starves — clicks register in the DOM
  // but React's synthetic event handlers never fire.
  //
  // Solution: MessageChannel. The rAF does pure physics work and writes the
  // result to a ref (pendingGridRef). It then posts a MessageChannel message,
  // which the browser delivers as a low-priority macrotask — AFTER any
  // pending input events. The port1 handler drains the pending ref and calls
  // dispatch/setState, so React renders never block input.
  const rafRef      = useRef<number>(0);
  const lastTickRef = useRef<number>(0);
  const tickCountRef = useRef<number>(0);
  const pendingGridRef = useRef<Float32Array | null>(null);

  // ── DIAG: remove this entire block when done ────────────────────────────
  const __DIAG__ = true;

  // Rolling event log — last 200 entries kept, each entry stamped with
  // elapsed seconds since simulation start so the report is self-contained.
  type _DiagEvent = {
    t: number;          // elapsed seconds
    kind: "gc" | "drop" | "slow_physics" | "slow_drain" | "slow_canvas" | "freeze";
    ms?: number;        // duration that triggered the event
    detail?: string;
  };
  const _diag = useRef({
    physMs:   0,        // EMA of stepDiffusion duration
    drainMs:  0,        // EMA of MessageChannel drain duration
    canvasMs: 0,        // EMA of canvas draw duration (fed from canvas via window)
    gcHits:   0,        // GC pause counter (reset each 5s window)
    drops:    0,        // frame-drop counter (reset each 5s window)
    report:   0,        // timestamp of last periodic log
    prev:     0,        // timestamp of last tick (for gap detection)
    startTs:  0,        // simulation start time
    events:   [] as _DiagEvent[],
    frozen:   false,    // true once a freeze report has been filed this session
  });
  // ── END DIAG ────────────────────────────────────────────────────────────
  const pendingEstRef  = useRef<EstimationResult | null | undefined>(undefined);

  useEffect(() => {
    if (!running) {
      cancelAnimationFrame(rafRef.current);
      return;
    }

    // ── Drain function — called via setTimeout(0) so it runs as a plain
    // macrotask, completely separate from React 18's own MessageChannel
    // scheduler (which also uses MessageChannel internally and would collide).
    // startTransition marks the grid update as interruptible/low-priority so
    // React never blocks input events to finish it.
    function drain() {
      const _drain0 = __DIAG__ ? performance.now() : 0; // DIAG
      const grid = pendingGridRef.current;
      if (grid !== null) {
        pendingGridRef.current = null;
        startTransition(() => {
          dispatch({ type: "SET_GRID", grid });
        });
      }
      if (pendingEstRef.current !== undefined) {
        const est = pendingEstRef.current;
        pendingEstRef.current = undefined;
        startTransition(() => { setEstimation(est); });
      }
      // DIAG ────────────────────────────────────────────────────────────────
      if (__DIAG__) {
        const _drainMs = performance.now() - _drain0;
        const _d = _diag.current;
        _d.drainMs = _drainMs * 0.1 + _d.drainMs * 0.9;
        if (_drainMs > 5) {
          console.warn(`[gas-sim drain] ${_drainMs.toFixed(1)}ms — React render slow`);
          const _elapsedS = _d.startTs ? (performance.now() - _d.startTs) / 1000 : 0;
          _d.events.push({ t: _elapsedS, kind: "slow_drain", ms: _drainMs,
            detail: `dispatch+setState took ${_drainMs.toFixed(1)}ms` });
          if (_d.events.length > 200) _d.events.shift();
        }
      }
      // END DIAG ─────────────────────────────────────────────────────────────
    }

    lastTickRef.current = performance.now();
    tickCountRef.current = 0;

    function tick(now: number) {
      const interval = paramsRef.current.tickMs;
      if (now - lastTickRef.current >= interval) {
        lastTickRef.current = now;
        tickCountRef.current++;

        // DIAG ──────────────────────────────────────────────────────────────
        const _t0 = __DIAG__ ? performance.now() : 0;
        const next = stepDiffusion(stateRef.current, paramsRef.current, windShadowRef.current);
        if (__DIAG__) {
          const _physMs = performance.now() - _t0;
          const _d = _diag.current;
          if (_d.startTs === 0) _d.startTs = now;
          const _elapsedS = (now - _d.startTs) / 1000;

          // Exponential moving averages
          _d.physMs = _physMs * 0.1 + _d.physMs * 0.9;

          // Gap since last tick — large gap = GC pause or main-thread block
          const _gap = now - (_d.prev || now);
          _d.prev = now;

          const _push = (e: (typeof _d.events)[0]) => {
            _d.events.push(e);
            if (_d.events.length > 200) _d.events.shift();
          };

          if (_gap > interval * 3) {
            _d.gcHits++;
            _push({ t: _elapsedS, kind: "gc", ms: _gap,
              detail: `gap ${_gap.toFixed(0)}ms >> 3× interval ${interval}ms` });
          }
          if (_gap > 33) {
            _d.drops++;
            _push({ t: _elapsedS, kind: "drop", ms: _gap,
              detail: `frame ${_gap.toFixed(0)}ms > 33ms budget` });
          }
          if (_physMs > 4) {
            _push({ t: _elapsedS, kind: "slow_physics", ms: _physMs,
              detail: `stepDiffusion took ${_physMs.toFixed(1)}ms` });
          }

          // Periodic console summary every 5 s
          if (now - _d.report > 5000) {
            _d.report = now;
            console.groupCollapsed(
              `[gas-sim diag] t=${_elapsedS.toFixed(0)}s  tick=${tickCountRef.current}`
            );
            console.table({
              "physics EMA (ms)":    _d.physMs.toFixed(2),
              "GC pauses suspected": _d.gcHits,
              "frame drops >33ms":   _d.drops,
              "log entries":         _d.events.length,
            });
            console.groupEnd();
            _d.gcHits = 0;
            _d.drops  = 0;
          }

          // ── Freeze detection ──────────────────────────────────────────────
          // A freeze looks like: a sudden very large gap (>500ms) right after
          // a stretch of slow drains or slow canvas draws. We fire once per
          // session so we don't spam reports.
          if (!_d.frozen && _gap > 500) {
            _d.frozen = true;
            _push({ t: _elapsedS, kind: "freeze", ms: _gap,
              detail: `main thread blocked ${_gap.toFixed(0)}ms` });
            // Give React one more tick to settle, then write the report
            setTimeout(() => {
              (window as any).__diagReport(_d, tickCountRef.current, paramsRef.current);
            }, 100);
          }
        }
        // END DIAG ──────────────────────────────────────────────────────────
        pendingGridRef.current = next.grid;

        if (tickCountRef.current % ESTIMATION_EVERY_N_TICKS === 0) {
          const readings = getSensorReadings(
            stateRef.current.sensors,
            next.grid,
            stateRef.current.dimensions,
          );
          pendingEstRef.current = estimateLeakPosition(
            readings,
            stateRef.current.gasLeaks[0] ?? null,
          );
        }

        setTimeout(drain, 0);
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "visible") lastTickRef.current = performance.now();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);


  const handleCellsInteract = useCallback(
    (cells: Array<{ row: number; col: number }>, activeTool: ToolMode) => {
      const { dimensions } = stateRef.current;
      if (activeTool === "gas_leak" && cells.length === 1) {
        const { row, col } = cells[0];
        dispatch({ type: "ADD_LEAK", leak: { id: `leak-${Date.now()}-${row}-${col}`, row, col } });
        return;
      }
      if (activeTool === "sensor") {
        cells.forEach(({ row, col }) => {
          if (!stateRef.current.sensors.some((s) => s.row === row && s.col === col))
            dispatch({ type: "ADD_SENSOR", sensor: { id: `s-${Date.now()}-${row}-${col}`, row, col } });
        });
        return;
      }
      if (activeTool === "wall") {
        dispatch({ type: "SET_WALL", indices: cells.map(({ row, col }) => row * dimensions.cols + col) });
        return;
      }
      if (activeTool === "door") {
        dispatch({ type: "SET_DOOR", indices: cells.map(({ row, col }) => row * dimensions.cols + col) });
        return;
      }
      if (activeTool === "eraser") {
        // Canvas pre-computes the exact W×H cell footprint; just dispatch directly.
        dispatch({ type: "ERASE", indices: cells.map(({ row, col }) => row * dimensions.cols + col) });
      }
    }, []
  );

  const handleLoad = useCallback((snapshot: LayoutSnapshot, target: LoadTarget) => {
    dispatch({ type: "LOAD_LAYOUT", snapshot, target });
  }, []);

  const toggleRunning = useCallback(() => setRunning((r) => !r), []);
  const toggleLightMode = useCallback(() => setLightMode((m) => !m), []);
  const reset = useCallback(() => {
    setRunning(false); setEstimation(null); dispatch({ type: "RESET" });
  }, []);

  // DIAG ──────────────────────────────────────────────────────────────────────
  // Register the global report function once. Canvas feeds its draw time via
  // window.__diagCanvasMs; freeze detector calls window.__diagReport.
  useEffect(() => {
    if (!__DIAG__) return;

    // Canvas → hook bridge: canvas posts its draw duration here each frame
    (window as any).__diagCanvasMs = (ms: number, hot: number) => {
      const _d = _diag.current;
      _d.canvasMs = ms * 0.1 + _d.canvasMs * 0.9;
      if (ms > 8) {
        const _elapsedS = _d.startTs ? (performance.now() - _d.startTs) / 1000 : 0;
        _d.events.push({ t: _elapsedS, kind: "slow_canvas", ms,
          detail: `canvas draw ${ms.toFixed(1)}ms | hot cells ${hot}/10000 (${(hot/100).toFixed(0)}%)` });
        if (_d.events.length > 200) _d.events.shift();
      }
    };

    // Report generator — called automatically on freeze, or call manually via
    // window.__diagReport() in the browser console at any time.
    (window as any).__diagReport = (
      diagOverride?: typeof _diag.current,
      ticks?: number,
      paramsOverride?: typeof params,
    ) => {
      const _d = diagOverride ?? _diag.current;
      const _p = paramsOverride ?? params;
      const _tick = ticks ?? tickCountRef.current;

      // ── Judgement ──────────────────────────────────────────────────────────
      const gcEvents      = _d.events.filter(e => e.kind === "gc");
      const dropEvents    = _d.events.filter(e => e.kind === "drop");
      const physEvents    = _d.events.filter(e => e.kind === "slow_physics");
      const drainEvents   = _d.events.filter(e => e.kind === "slow_drain");
      const canvasEvents  = _d.events.filter(e => e.kind === "slow_canvas");
      const freezeEvents  = _d.events.filter(e => e.kind === "freeze");

      const maxDrain  = drainEvents.length  ? Math.max(...drainEvents.map(e => e.ms ?? 0))  : 0;
      const maxCanvas = canvasEvents.length ? Math.max(...canvasEvents.map(e => e.ms ?? 0)) : 0;
      const maxPhys   = physEvents.length   ? Math.max(...physEvents.map(e => e.ms ?? 0))   : 0;

      const causes: string[] = [];
      const fixes:  string[] = [];

      if (gcEvents.length > 0) {
        causes.push(
          `GC pressure: ${gcEvents.length} pause(s) detected. ` +
          `stepDiffusion allocates two Float32Array(10000) = 80KB every tick. ` +
          `At tickMs=${_p.tickMs}ms that is ~${(80000 / _p.tickMs * 1000 / 1024 / 1024).toFixed(1)} MB/s of garbage.`
        );
        fixes.push("FIX A (highest impact): pre-allocate two buffers and ping-pong — zero allocations per tick, GC pressure gone entirely.");
      }

      if (maxCanvas > 8) {
        const hotPct = canvasEvents.length
          ? parseInt((canvasEvents[canvasEvents.length - 1].detail ?? "0").match(/(\d+)%/)?.[1] ?? "0")
          : 0;
        causes.push(
          `Canvas bottleneck: peak draw ${maxCanvas.toFixed(1)}ms. ` +
          `Gas coverage ~${hotPct}% — ${hotPct * 100}/10000 fillRect calls per frame. ` +
          `concentrationToHex() runs per-cell string formatting at this rate.`
        );
        fixes.push("FIX B: replace concentrationToHex loop with a 256-entry Uint32Array LUT + single putImageData call. Reduces draw from O(N) fillRect to one GPU upload.");
      }

      if (maxDrain > 5) {
        causes.push(
          `React render slow: peak drain ${maxDrain.toFixed(1)}ms. ` +
          `Every SET_GRID dispatch re-renders SimulationCanvas AND SensorStats (3D chart). ` +
          `SensorStats has no memo boundary so redraws its canvas even when sensor positions are unchanged.`
        );
        fixes.push("FIX C: wrap SensorStats in React.memo with a comparator that skips re-render when only grid changes and no sensor reading delta exceeds 0.5%.");
      }

      if (maxPhys > 4) {
        causes.push(
          `Physics too slow: peak ${maxPhys.toFixed(1)}ms per tick vs ${_p.tickMs}ms interval. ` +
          `No headroom — physics is consuming the entire tick budget leaving nothing for React + canvas.`
        );
        fixes.push("FIX D: move stepDiffusion into a Web Worker. The simulation.worker.ts file already exists in the project. Physics runs off-main-thread; main thread only renders.");
      }

      if (causes.length === 0 && freezeEvents.length > 0) {
        causes.push(
          "Freeze detected but no clear single cause from logged metrics. " +
          "The freeze may have been caused by a browser-level event (extension, DevTools, tab switch GC). " +
          "Check the event log for the sequence leading up to the freeze entry."
        );
        fixes.push("Monitor for recurrence. If freeze repeats consistently, enable all fixes A–D preemptively.");
      }

      const primaryFix = fixes.length > 0 ? fixes[0] : "No actionable fix identified — freeze may be one-off.";

      // ── Build report text ──────────────────────────────────────────────────
      const ts = new Date().toISOString();
      const uptime = _d.startTs ? ((performance.now() - _d.startTs) / 1000).toFixed(1) : "unknown";

      const lines = [
        "═══════════════════════════════════════════════════════════",
        " GAS-SIM-PRO  FREEZE / PERFORMANCE REPORT",
        `═══════════════════════════════════════════════════════════`,
        `Generated : ${ts}`,
        `Sim uptime: ${uptime}s   Total ticks: ${_tick}`,
        "",
        "── SIMULATION PARAMETERS ────────────────────────────────────",
        `  tickMs         : ${_p.tickMs}`,
        `  diffusionRate  : ${_p.diffusionRate}`,
        `  decayFactor    : ${_p.decayFactor}`,
        `  leakInjection  : ${_p.leakInjection}`,
        `  windX / windY  : ${_p.windX} / ${_p.windY}`,
        "",
        "── PERFORMANCE METRICS (exponential moving average) ─────────",
        `  physics EMA    : ${_d.physMs.toFixed(2)} ms`,
        `  drain EMA      : ${_d.drainMs.toFixed(2)} ms`,
        `  canvas EMA     : ${_d.canvasMs.toFixed(2)} ms`,
        "",
        "── EVENT COUNTS (last 200-event window) ─────────────────────",
        `  GC pauses      : ${gcEvents.length}`,
        `  Frame drops    : ${dropEvents.length}`,
        `  Slow physics   : ${physEvents.length}  (peak ${maxPhys.toFixed(1)}ms)`,
        `  Slow drain     : ${drainEvents.length}  (peak ${maxDrain.toFixed(1)}ms)`,
        `  Slow canvas    : ${canvasEvents.length}  (peak ${maxCanvas.toFixed(1)}ms)`,
        `  Freeze events  : ${freezeEvents.length}`,
        "",
        "── FREEZE EVENTS ────────────────────────────────────────────",
        ...(freezeEvents.length
          ? freezeEvents.map(e => `  t=${e.t.toFixed(1)}s  ${e.detail}`)
          : ["  none"]),
        "",
        "── DIAGNOSIS ────────────────────────────────────────────────",
        ...(causes.length ? causes.map((c, i) => `  [${i + 1}] ${c}`) : ["  No significant anomalies detected."]),
        "",
        "── RECOMMENDED FIX ──────────────────────────────────────────",
        `  ${primaryFix}`,
        ...(fixes.length > 1 ? ["", "  Additional fixes (lower priority):"] : []),
        ...(fixes.slice(1).map(f => `    • ${f}`)),
        "",
        "── FULL EVENT LOG ───────────────────────────────────────────",
        ..._d.events.map(e =>
          `  [t=${e.t.toFixed(2).padStart(7)}s] ${e.kind.padEnd(14)} ${e.detail ?? ""}`
        ),
        "",
        "═══════════════════════════════════════════════════════════",
      ];

      const reportText = lines.join("\n");
      console.log(reportText);

      // Download as .txt file
      const blob = new Blob([reportText], { type: "text/plain" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `gas-sim-report-${ts.replace(/[:.]/g, "-")}.txt`;
      a.click();
      URL.revokeObjectURL(url);

      return reportText;
    };

    return () => {
      delete (window as any).__diagReport;
      delete (window as any).__diagCanvasMs;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // ── END DIAG ─────────────────────────────────────────────────────────────

  return {
    simState, windShadow,
    running, tool, setTool, estimation,
    params, setParams, lightMode, toggleLightMode,
    reset, toggleRunning, handleCellsInteract, handleLoad,
  };
}