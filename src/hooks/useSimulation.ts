import { useReducer, useEffect, useRef, useCallback, useState, useMemo } from "react";
import type {
  SimulationState, ToolMode, GasLeak, Sensor, SimParams, LayoutSnapshot,
} from "../engine/types";
import { DEFAULT_PARAMS } from "../engine/types";
import { useInference } from "./useInference";
import { stepDiffusion } from "../engine/diffusion";
import { buildWindShadow } from "../utils/windShadow";
import type { LoadTarget } from "../utils/layout";

const ROWS = 100;
const COLS = 100;

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
  | { type: "SET_LEAK"; leak: GasLeak }
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
    case "SET_LEAK":
      return { ...state, gasLeaks: [...state.gasLeaks, action.leak] };
    case "ADD_SENSOR":
      return { ...state, sensors: [...state.sensors, action.sensor] };
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
    case "REMOVE_LEAK":
      return { ...state, gasLeaks: state.gasLeaks.filter((l) => l.id !== action.id) };
    case "REMOVE_SENSOR":
      return { ...state, sensors: state.sensors.filter((s) => s.id !== action.id) };
    case "ERASE": {
      const blocked = new Uint8Array(state.blockedCells);
      const doors   = new Uint8Array(state.doorCells);
      action.indices.forEach((i) => { blocked[i] = 0; doors[i] = 0; });
      // Remove leaks and sensors whose cell is in the erased indices
      const erased  = new Set(action.indices);
      const gasLeaks = state.gasLeaks.filter(
        (l) => !erased.has(l.row * state.dimensions.cols + l.col)
      );
      const sensors = state.sensors.filter(
        (s) => !erased.has(s.row * state.dimensions.cols + s.col)
      );
      return { ...state, blockedCells: blocked, doorCells: doors, gasLeaks, sensors };
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
  const { estimation, inferenceStatus, runInference } = useInference();
  const [params, setParams] = useState<SimParams>(DEFAULT_PARAMS);
  const [lightMode, setLightMode] = useState(false);

  const stateRef = useRef(simState);
  stateRef.current = simState;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // Recompute wind shadow only when walls, doors, or wind vector change.
  // useMemo tracks the typed arrays by reference — they're replaced on every
  // wall/door action so the dependency is correct.
  const windShadow = useMemo(() => buildWindShadow(
    simState.blockedCells,
    simState.doorCells,
    ROWS, COLS,
    params.windX,
    params.windY,
  ), [simState.blockedCells, simState.doorCells, params.windX, params.windY]);

  const windShadowRef = useRef(windShadow);
  windShadowRef.current = windShadow;

  // rAF loop — immune to tab throttling
  const rafRef = useRef<number>(0);
  const lastTickRef = useRef<number>(0);
  const inferenceCounter = useRef(0);


  useEffect(() => {
    if (!running) { cancelAnimationFrame(rafRef.current); return; }
    lastTickRef.current = performance.now();

    function tick(now: number) {
      const interval = paramsRef.current.tickMs;
      if (now - lastTickRef.current >= interval) {
        lastTickRef.current = now;
        const next = stepDiffusion(stateRef.current, paramsRef.current, windShadowRef.current);
        dispatch({ type: "SET_GRID", grid: next.grid });
        if (inferenceCounter.current % 10 === 0) {  // every 10 ticks = 300ms
          runInference({ ...stateRef.current, grid: next.grid }, paramsRef.current);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [running]);

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
        dispatch({ type: "SET_LEAK", leak: { id: `leak-${Date.now()}`, ...cells[0] } }); return;
      }
      if (activeTool === "sensor") {
        cells.forEach(({ row, col }) => {
          if (!stateRef.current.sensors.some((s) => s.row === row && s.col === col))
            dispatch({ type: "ADD_SENSOR", sensor: { id: `s-${Date.now()}-${row}-${col}`, row, col } });
        }); return;
      }
      if (activeTool === "wall") {
        dispatch({ type: "SET_WALL", indices: cells.map(({ row, col }) => row * dimensions.cols + col) }); return;
      }
      if (activeTool === "door") {
        dispatch({ type: "SET_DOOR", indices: cells.map(({ row, col }) => row * dimensions.cols + col) }); return;
      }
      if (activeTool === "eraser") {
        dispatch({ type: "ERASE", indices: cells.map(({ row, col }) => row * dimensions.cols + col) }); return;
      }
    }, []
  );

  const handleLoad = useCallback((snapshot: LayoutSnapshot, target: LoadTarget) => {
    dispatch({ type: "LOAD_LAYOUT", snapshot, target });
  }, []);

  const toggleRunning = useCallback(() => setRunning((r) => !r), []);
  const toggleLightMode = useCallback(() => setLightMode((m) => !m), []);
  const reset = useCallback(() => {
    setRunning(false); dispatch({ type: "RESET" });
  }, []);

  return {
    simState, windShadow,
    running, tool, setTool, estimation, inferenceStatus,
    params, setParams, lightMode, toggleLightMode,
    reset, toggleRunning, handleCellsInteract, handleLoad,
  };
}
