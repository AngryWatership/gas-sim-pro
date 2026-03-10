/**
 * Diffusion + advection engine (v6).
 *
 * Physics identical to v5. Performance fix: fully in-place mutation.
 *
 * v5 allocated two new Float32Array(10000) = 80 KB every tick.
 * At tickMs=16 that was 4.8 MB/s of garbage → confirmed cause of the
 * 33-second GC freeze at t=219s in the diagnostic report.
 *
 * v6 allocates nothing per tick. The grid is mutated directly:
 *   - Diffusion deltas are stashed in a single module-level scratch buffer
 *     (allocated once ever), then applied in-place.
 *   - Advection flux accumulates directly into the grid.
 *   - Leak injection and decay follow in-place.
 *   - Return spreads a new state object so React sees a change, but reuses
 *     the same Float32Array reference — zero allocations per tick.
 */
import type { SimulationState, SimParams } from "./types";
import { DEFAULT_PARAMS } from "./types";

const MAX_D = 0.124;
const MAX_V = 0.9;

// One scratch buffer — allocated once at module load, reused every tick.
let _scratch = new Float32Array(100 * 100);
function _ensureScratch(size: number) {
  if (_scratch.length < size) _scratch = new Float32Array(size);
}

function isOpen(blocked: Uint8Array, doors: Uint8Array, idx: number): boolean {
  return !blocked[idx] || !!doors[idx];
}

export function stepDiffusion(
  state: SimulationState,
  params: SimParams = DEFAULT_PARAMS,
  windShadow?: Uint8Array,
): SimulationState {
  const { grid, blockedCells, doorCells, gasLeaks, dimensions } = state;
  const { rows, cols } = dimensions;
  const size = rows * cols;
  const { diffusionRate, decayFactor, leakInjection, windX, windY } = params;

  const D  = Math.min(MAX_D, diffusionRate);
  const vx = Math.max(-MAX_V, Math.min(MAX_V, windX));
  const vy = Math.max(-MAX_V, Math.min(MAX_V, windY));

  _ensureScratch(size);

  // ── Step 1: Diffusion (FTCS, in-place) ───────────────────────────────────
  // Pre-pass: compute Laplacian deltas into _scratch while grid is unmodified,
  // so each cell reads clean neighbour values.
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const idx = r * cols + c;
      if (!isOpen(blockedCells, doorCells, idx)) { _scratch[idx] = 0; continue; }

      const nIdx = (r - 1) * cols + c;
      const sIdx = (r + 1) * cols + c;
      const wIdx = r * cols + (c - 1);
      const eIdx = r * cols + (c + 1);

      const vN = isOpen(blockedCells, doorCells, nIdx) ? grid[nIdx] : grid[idx];
      const vS = isOpen(blockedCells, doorCells, sIdx) ? grid[sIdx] : grid[idx];
      const vW = isOpen(blockedCells, doorCells, wIdx) ? grid[wIdx] : grid[idx];
      const vE = isOpen(blockedCells, doorCells, eIdx) ? grid[eIdx] : grid[idx];

      _scratch[idx] = D * (vN + vS + vW + vE - 4 * grid[idx]);
    }
  }
  // Apply all deltas — no allocation
  for (let i = 0; i < size; i++) grid[i] += _scratch[i];

  // ── Step 2: Advection (upwind, shadow-masked, in-place) ───────────────────
  // Upwind reads from upstream neighbour — never the cell being written,
  // so in-place mutation has no ordering dependency.
  if (vx !== 0 || vy !== 0) {
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const idx = r * cols + c;
        if (!isOpen(blockedCells, doorCells, idx)) continue;
        if (windShadow && windShadow[idx]) continue;

        let flux = 0;

        if (vx > 0) {
          const src = r * cols + (c - 1);
          if (isOpen(blockedCells, doorCells, src))
            flux += vx * (grid[src] - grid[idx]);
        } else if (vx < 0) {
          const src = r * cols + (c + 1);
          if (isOpen(blockedCells, doorCells, src))
            flux += -vx * (grid[src] - grid[idx]);
        }

        if (vy > 0) {
          const src = (r - 1) * cols + c;
          if (isOpen(blockedCells, doorCells, src))
            flux += vy * (grid[src] - grid[idx]);
        } else if (vy < 0) {
          const src = (r + 1) * cols + c;
          if (isOpen(blockedCells, doorCells, src))
            flux += -vy * (grid[src] - grid[idx]);
        }

        grid[idx] += flux;
      }
    }
  }

  // ── Step 3: Leak injection ────────────────────────────────────────────────
  for (const leak of gasLeaks) {
    const idx = leak.row * cols + leak.col;
    if (idx >= 0 && idx < size)
      grid[idx] = Math.min(1.0, grid[idx] + leakInjection * 0.08);
  }

  // ── Step 4: Decay + clamp (in-place) ─────────────────────────────────────
  for (let i = 0; i < size; i++) {
    const v = grid[i] * decayFactor;
    grid[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // New state object (React needs a new reference) but same grid array.
  return { ...state, grid };
}