export type CellGrid = Float32Array;

export interface GridDimensions {
  rows: number;
  cols: number;
}

export interface GasLeak {
  id: string;
  row: number;
  col: number;
}

export interface Sensor {
  id: string;
  row: number;
  col: number;
}

export interface SensorReading {
  sensor: Sensor;
  concentration: number;
}

export type ToolMode = "gas_leak" | "sensor" | "wall" | "door" | "eraser" | "none";

export interface SimParams {
  /**
   * Base diffusion coefficient D (per tick).
   * Stability limit: D <= 0.124. Engine hard-clamps to prevent oscillation.
   */
  diffusionRate: number;
  /** Ventilation / absorption per tick (1.0 = none, 0.95 = moderate). */
  decayFactor: number;
  /** Concentration injected at leak source per tick. */
  leakInjection: number;
  /** Simulation loop interval in ms. */
  tickMs: number;
  /** Wind velocity X (cols/tick, positive = rightward). */
  windX: number;
  /** Wind velocity Y (rows/tick, positive = downward). */
  windY: number;
}

export const DEFAULT_PARAMS: SimParams = {
  diffusionRate: 0.1,
  decayFactor: 0.99,
  leakInjection: 8,
  tickMs: 30,
  windX: 0,
  windY: 0,
};

export interface SimulationState {
  grid: CellGrid;
  blockedCells: Uint8Array;
  doorCells: Uint8Array;
  gasLeaks: GasLeak[];
  sensors: Sensor[];
  dimensions: GridDimensions;
}

export interface LayoutSnapshot {
  version: 1;
  sensors: Sensor[];
  walls: number[];
  doors: number[];
  gasLeaks: GasLeak[];
}

