import type { CellGrid, GridDimensions, Sensor, SensorReading, GasLeak } from "./types";

export interface EstimationResult {
  row: number;
  col: number;
  error: number | null;
}

const MIN_ACTIVE_SENSORS = 2;
const ACTIVE_THRESHOLD = 1e-6;

export function getSensorReadings(
  sensors: Sensor[],
  grid: CellGrid,
  dimensions: GridDimensions
): SensorReading[] {
  return sensors.map((sensor) => ({
    sensor,
    concentration: grid[sensor.row * dimensions.cols + sensor.col],
  }));
}

export function estimateLeakPosition(
  readings: SensorReading[],
  actualLeak: GasLeak | null
): EstimationResult | null {
  const active = readings.filter((r) => r.concentration > ACTIVE_THRESHOLD);
  if (active.length < MIN_ACTIVE_SENSORS) return null;

  const total = active.reduce((sum, r) => sum + r.concentration, 0);
  const row = active.reduce((sum, r) => sum + r.sensor.row * r.concentration, 0) / total;
  const col = active.reduce((sum, r) => sum + r.sensor.col * r.concentration, 0) / total;

  const error = actualLeak
    ? Math.sqrt(Math.pow(row - actualLeak.row, 2) + Math.pow(col - actualLeak.col, 2))
    : null;

  return { row, col, error };
}
