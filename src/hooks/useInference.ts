/**
 * useInference.ts
 * Calls POST /predict with sensor readings + wall features computed from state.
 * Wall features match training pipeline exactly (Cell 4 of train.ipynb).
 */

import { useState, useRef, useCallback } from "react";
import type { SimulationState, SimParams } from "../engine/types";
import { getSensorReadings, estimateLeakPosition } from "../engine/triangulation";
import type { EstimationResult } from "../engine/triangulation";

const CLOUD_RUN_URL = import.meta.env.VITE_CLOUD_RUN_URL as string | undefined;
const TIMEOUT_MS    = 5_000;
const GRID_SIZE     = 100;

export type InferenceStatus = "online" | "offline" | "loading" | "unconfigured";

export interface UseInference {
  estimation:      EstimationResult | null;
  inferenceStatus: InferenceStatus;
  runInference:    (state: SimulationState, params: SimParams) => void;
}

// ── Wall feature computation ───────────────────────────────────────────────
function computeWallFeatures(blockedCells: Uint8Array, doorCells: Uint8Array) {
  let nWalls = 0, nDoors = 0;
  let wallSumRow = 0, wallSumRowSq = 0, wallSpreadRow = 0;
  let wallsQ1 = 0, wallsQ2 = 0, wallsQ3 = 0, wallsQ4 = 0;

  for (let idx = 0; idx < blockedCells.length; idx++) {
    if (blockedCells[idx]) {
      const r = Math.floor(idx / GRID_SIZE);
      const c = idx % GRID_SIZE;
      nWalls++;
      wallSumRow   += r;
      wallSumRowSq += r * r;
      if (r < 50 && c < 50)  wallsQ1++;
      else if (r < 50)        wallsQ2++;
      else if (c < 50)        wallsQ3++;
      else                    wallsQ4++;
    }
  }
  for (let idx = 0; idx < doorCells.length; idx++) {
    if (doorCells[idx]) nDoors++;
  }

  if (nWalls > 1) {
    const mean = wallSumRow / nWalls;
    wallSpreadRow = Math.sqrt(wallSumRowSq / nWalls - mean * mean);
  }

  const gridTotal = GRID_SIZE * GRID_SIZE;
  return {
    nWalls,
    nDoors,
    wallDensity:      nWalls / gridTotal,
    openRatio:        (gridTotal - nWalls - nDoors) / gridTotal,
    wallSpreadRow,
    wallsQ1, wallsQ2, wallsQ3, wallsQ4,
    wallAsymmetryCol: wallsQ1 + wallsQ3 - wallsQ2 - wallsQ4,
    wallAsymmetryRow: wallsQ1 + wallsQ2 - wallsQ3 - wallsQ4,
  };
}

function computeWallsBlockingTop1(
  blockedCells: Uint8Array,
  top1Row: number, top1Col: number,
  centroidRow: number, centroidCol: number,
): number {
  const midRow = (top1Row + centroidRow) / 2;
  const midCol = (top1Col + centroidCol) / 2;
  let count = 0;
  for (let idx = 0; idx < blockedCells.length; idx++) {
    if (blockedCells[idx]) {
      const r = Math.floor(idx / GRID_SIZE);
      const c = idx % GRID_SIZE;
      if ((r - midRow) ** 2 + (c - midCol) ** 2 <= 25) count++;
    }
  }
  return count;
}

export function useInference(): UseInference {
  const [estimation,      setEstimation]      = useState<EstimationResult | null>(null);
  const [inferenceStatus, setInferenceStatus] = useState<InferenceStatus>(
    CLOUD_RUN_URL ? "loading" : "unconfigured"
  );
  const inFlightRef = useRef(false);

  const runInference = useCallback(async (
    state:  SimulationState,
    params: SimParams,
  ) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const readings   = getSensorReadings(state.sensors, state.grid, state.dimensions);
    const actualLeak = state.gasLeaks?.[0] ?? null;
    const fallback   = estimateLeakPosition(readings, actualLeak);

    if (!CLOUD_RUN_URL) {
      setEstimation(fallback);
      setInferenceStatus("unconfigured");
      inFlightRef.current = false;
      return;
    }

    const activeSensors = readings.filter(r => r.concentration > 1e-6);
    if (activeSensors.length < 3) {
      setEstimation(fallback);
      inFlightRef.current = false;
      return;
    }

    try {
      // ── Sensor centroid for walls_blocking_top1 ───────────────────────
      const sVals  = activeSensors.map(r => r.concentration);
      const total  = sVals.reduce((a, b) => a + b, 0) || 1e-9;
      const cRow   = activeSensors.reduce((s, r, i) => s + r.sensor.row * sVals[i], 0) / total;
      const cCol   = activeSensors.reduce((s, r, i) => s + r.sensor.col * sVals[i], 0) / total;

      // Top-1 sensor for walls_blocking_top1
      const top1 = activeSensors.reduce((best, r) =>
        r.concentration > best.concentration ? r : best, activeSensors[0]);

      // ── Wall features ─────────────────────────────────────────────────
      const wf = computeWallFeatures(state.blockedCells, state.doorCells);
      const wallsBlocking = computeWallsBlockingTop1(
        state.blockedCells, top1.sensor.row, top1.sensor.col, cRow, cCol);

      // ── Request body ──────────────────────────────────────────────────
      const body = {
        sensor_readings: activeSensors.map(r => ({
          row:     r.sensor.row,
          col:     r.sensor.col,
          reading: r.concentration,
        })),
        wind_x:          params.windX,
        wind_y:          params.windY,
        diffusion_rate:  params.diffusionRate,
        decay_factor:    params.decayFactor,
        leak_injection:  params.leakInjection,
        n_walls:             wf.nWalls,
        n_doors:             wf.nDoors,
        wall_density:        wf.wallDensity,
        open_path_ratio:     wf.openRatio,
        wall_spread_row:     wf.wallSpreadRow,
        walls_q1:            wf.wallsQ1,
        walls_q2:            wf.wallsQ2,
        walls_q3:            wf.wallsQ3,
        walls_q4:            wf.wallsQ4,
        walls_blocking_top1: wallsBlocking,
        wall_asymmetry_col:  wf.wallAsymmetryCol,
        wall_asymmetry_row:  wf.wallAsymmetryRow,
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(`${CLOUD_RUN_URL}/predict`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data    = await res.json() as { predicted_polygon: { row: number; col: number }[] };
      const polygon = data.predicted_polygon;
      if (!polygon?.length) throw new Error("Empty polygon");

      const row   = polygon.reduce((s, p) => s + p.row, 0) / polygon.length;
      const col   = polygon.reduce((s, p) => s + p.col, 0) / polygon.length;
      const error = actualLeak
        ? Math.sqrt((row - actualLeak.row) ** 2 + (col - actualLeak.col) ** 2)
        : null;

      setEstimation({ row, col, error });
      setInferenceStatus("online");

    } catch {
      setEstimation(fallback);
      setInferenceStatus("offline");
    }

    inFlightRef.current = false;
  }, []);

  return { estimation, inferenceStatus, runInference };
}
