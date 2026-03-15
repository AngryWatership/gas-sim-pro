/**
 * useInference.ts
 * Replaces the triangulation heuristic with Cloud Run ML inference.
 *
 * - Calls POST /predict on the Cloud Run service
 * - Falls back to triangulation if Cloud Run is unreachable
 * - Debounces calls — one in-flight request at a time
 * - Returns EstimationResult so existing canvas + stats panel need no changes
 * - Sets inferenceStatus: 'online' | 'offline' | 'loading' for the UI indicator
 */

import { useState, useRef, useCallback } from "react";
import type { SimulationState, SimParams } from "../engine/types";
import { getSensorReadings, estimateLeakPosition } from "../engine/triangulation";
import type { EstimationResult } from "../engine/triangulation";

const CLOUD_RUN_URL = import.meta.env.VITE_CLOUD_RUN_URL as string | undefined;
const TIMEOUT_MS    = 3_000; // fall back to triangulation after 3s

export type InferenceStatus = "online" | "offline" | "loading" | "unconfigured";

export interface UseInference {
  estimation:      EstimationResult | null;
  inferenceStatus: InferenceStatus;
  runInference:    (state: SimulationState, params: SimParams) => void;
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
    if (inFlightRef.current) return; // skip if previous call still running
    inFlightRef.current = true;

    const readings = getSensorReadings(
      state.sensors, state.grid, state.dimensions
    );

    // Always compute triangulation fallback — used if Cloud Run fails
    const actualLeak = state.gasLeaks?.[0] ?? null;
    const fallback   = estimateLeakPosition(readings, actualLeak);

    // No Cloud Run URL configured — use triangulation silently
    if (!CLOUD_RUN_URL) {
      setEstimation(fallback);
      setInferenceStatus("unconfigured");
      inFlightRef.current = false;
      return;
    }

    // Need at least 3 sensors with non-zero readings
    const activeSensors = readings.filter(r => r.concentration > 1e-6);
    if (activeSensors.length < 3) {
      setEstimation(fallback);
      inFlightRef.current = false;
      return;
    }

    try {
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const body = {
        sensor_readings: activeSensors.map(r => ({
          row:     r.sensor.row,
          col:     r.sensor.col,
          reading: r.concentration,
        })),
        wind_x:         params.windX,
        wind_y:         params.windY,
        diffusion_rate: params.diffusionRate,
        decay_factor:   params.decayFactor,
        leak_injection: params.leakInjection,
      };

      const res = await fetch(`${CLOUD_RUN_URL}/predict`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const polygon: { row: number; col: number }[] = data.predicted_polygon;

      if (!polygon?.length) throw new Error("Empty polygon");

      // Use centroid of polygon as the point estimate
      const row = polygon.reduce((s, p) => s + p.row, 0) / polygon.length;
      const col = polygon.reduce((s, p) => s + p.col, 0) / polygon.length;

      // Compute error against actual leak if known
      const error = actualLeak
        ? Math.sqrt((row - actualLeak.row) ** 2 + (col - actualLeak.col) ** 2)
        : null;

      setEstimation({ row, col, error });
      setInferenceStatus("online");

    } catch {
      // Network error or timeout — fall back to triangulation
      setEstimation(fallback);
      setInferenceStatus("offline");
    }

    inFlightRef.current = false;
  }, []);

  return { estimation, inferenceStatus, runInference };
}
