/**
 * generator.worker.ts
 * Web Worker — headless batch data generation.
 *
 * Runs entirely off the main thread. Sends three message types:
 *   { type: 'progress', rowsGenerated, totalTarget, layoutsGenerated }
 *   { type: 'flush',    ndjson: string, rowCount: number }
 *   { type: 'done',     seed, totalRows, totalLayouts }
 *   { type: 'error',    message: string }
 *
 * Receives one message to start:
 *   { type: 'start', config: GeneratorConfig, targetRows: number, seed?: number }
 *
 * Receives one message to stop:
 *   { type: 'stop' }
 */

import { generateRandomLayout } from "../utils/randomLayout";
import { stepDiffusion } from "../engine/diffusion";
import { DEFAULT_PARAMS } from "../engine/types";
import type { SimulationState } from "../engine/types";
import type { GeneratorConfig } from "../utils/generatorConfig";

// ── Constants ─────────────────────────────────────────────────────────────
const ROWS = 100;
const COLS = 100;
const FLUSH_EVERY = 5_000; // rows per NDJSON flush

// ── State ─────────────────────────────────────────────────────────────────
let running = false;

// ── Message handler ───────────────────────────────────────────────────────
self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === "stop") {
    running = false;
    return;
  }

  if (msg.type === "start") {
    running = true;
    runBatch(msg.config as GeneratorConfig, msg.targetRows as number, msg.seed as number | undefined)
      .catch(err => {
        self.postMessage({ type: "error", message: String(err) });
      });
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────
function makeStateFromLayout(result: ReturnType<typeof generateRandomLayout>): SimulationState {
  const { snapshot } = result;
  const blocked = new Uint8Array(ROWS * COLS);
  const doors   = new Uint8Array(ROWS * COLS);
  snapshot.walls.forEach(i => { blocked[i] = 1; });
  snapshot.doors.forEach(i => { doors[i] = 1; blocked[i] = 0; });
  return {
    grid:         new Float32Array(ROWS * COLS),
    blockedCells: blocked,
    doorCells:    doors,
    gasLeaks:     snapshot.gasLeaks,
    sensors:      snapshot.sensors,
    dimensions:   { rows: ROWS, cols: COLS },
  };
}

function getSensorReadings(state: SimulationState): number[] {
  return state.sensors.map(s => state.grid[s.row * COLS + s.col]);
}

function buildRecord(
  result: ReturnType<typeof generateRandomLayout>,
  state: SimulationState,
  tick: number,
): string {
  const { snapshot, params, seed, config_hash, locked_dimensions } = result;
  const record = {
    source:            "synthetic",
    seed,
    layout_id:         `${seed}-${snapshot.walls.length}-${snapshot.gasLeaks.length}`,
    config_hash,
    locked_dimensions,
    tick,
    wind_x:            params.windX,
    wind_y:            params.windY,
    diffusion_rate:    params.diffusionRate,
    decay_factor:      params.decayFactor,
    leak_injection:    params.leakInjection,
    leaks:             snapshot.gasLeaks.map(l => ({ row: l.row, col: l.col })),
    sensors:           state.sensors.map((s, i) => ({
      row:     s.row,
      col:     s.col,
      reading: getSensorReadings(state)[i],
    })),
    walls: snapshot.walls,
    doors: snapshot.doors,
  };
  return JSON.stringify(record);
}

// ── Main batch loop ───────────────────────────────────────────────────────
async function runBatch(
  config: GeneratorConfig,
  targetRows: number,
  seedOverride?: number,
): Promise<void> {
  let totalRows      = 0;
  let totalLayouts   = 0;
  let buffer: string[] = [];
  let currentSeed    = seedOverride ?? ((Math.random() * 0xffffffff) >>> 0);

  while (running && totalRows < targetRows) {
    // ── Generate one layout ──────────────────────────────────────────────
    const result = generateRandomLayout(currentSeed, config);
    currentSeed = (currentSeed + 1) >>> 0; // deterministic seed sequence
    totalLayouts++;

    const { params } = result;
    let state = makeStateFromLayout(result);

    // ── Warm-up ticks — no recording ────────────────────────────────────
    for (let t = 0; t < config.warmUpTicks && running; t++) {
      state = stepDiffusion(state, params);
    }
    if (!running) break;

    // ── Record ticks ─────────────────────────────────────────────────────
    for (let t = 0; t < config.recordTicks && running; t++) {
      state = stepDiffusion(state, params);

      if (t % config.recordEvery === 0) {
        buffer.push(buildRecord(result, state, config.warmUpTicks + t));
        totalRows++;

        // Flush every FLUSH_EVERY rows
        if (buffer.length >= FLUSH_EVERY) {
          self.postMessage({
            type:     "flush",
            ndjson:   buffer.join("\n"),
            rowCount: buffer.length,
          });
          buffer = [];
        }

        // Progress update every 500 rows
        if (totalRows % 500 === 0) {
          self.postMessage({
            type:             "progress",
            rowsGenerated:    totalRows,
            totalTarget:      targetRows,
            layoutsGenerated: totalLayouts,
          });
        }

        if (totalRows >= targetRows) break;
      }
    }

    // Yield to allow stop messages to be processed between layouts
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Final flush for any remaining rows
  if (buffer.length > 0) {
    self.postMessage({
      type:     "flush",
      ndjson:   buffer.join("\n"),
      rowCount: buffer.length,
    });
  }

  self.postMessage({
    type:         "done",
    seed:         seedOverride ?? currentSeed,
    totalRows,
    totalLayouts,
  });

  running = false;
}
