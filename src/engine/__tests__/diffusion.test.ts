import { describe, it, expect } from "vitest";
import { stepDiffusion } from "../diffusion";
import { DEFAULT_PARAMS } from "../types";
import type { SimulationState } from "../types";

const ROWS = 10;
const COLS = 10;

function makeEmptyState(): SimulationState {
  return {
    grid: new Float32Array(ROWS * COLS),
    blockedCells: new Uint8Array(ROWS * COLS),
    doorCells: new Uint8Array(ROWS * COLS),
    gasLeaks: [],
    sensors: [],
    dimensions: { rows: ROWS, cols: COLS },
  };
}

describe("stepDiffusion — stability", () => {
  it("never produces negative values even at high diffusion rates", () => {
    const state = makeEmptyState();
    state.gasLeaks = [{ id: "l1", row: 5, col: 5 }];
    let s: SimulationState = state;
    for (let i = 0; i < 100; i++)
      s = stepDiffusion(s, { ...DEFAULT_PARAMS, diffusionRate: 0.4 });
    expect(Math.min(...Array.from(s.grid))).toBeGreaterThanOrEqual(0);
  });

  it("clamps values to [0,1] at high diffusion rates", () => {
    const state = makeEmptyState();
    state.gasLeaks = [{ id: "l1", row: 5, col: 5 }];
    let s: SimulationState = state;
    for (let i = 0; i < 50; i++) s = stepDiffusion(s);
    expect(Math.max(...Array.from(s.grid))).toBeLessThanOrEqual(1.0);
  });
});

describe("stepDiffusion — diffusion", () => {
  it("injects concentration at leak cell", () => {
    const state = { ...makeEmptyState(), gasLeaks: [{ id: "l1", row: 5, col: 5 }] };
    expect(stepDiffusion(state).grid[5 * COLS + 5]).toBeGreaterThan(0);
  });

  it("injects concentration at multiple leak cells", () => {
    const state = {
      ...makeEmptyState(),
      gasLeaks: [
        { id: "l1", row: 2, col: 2 },
        { id: "l2", row: 7, col: 7 },
      ],
    };
    const next = stepDiffusion(state);
    expect(next.grid[2 * COLS + 2]).toBeGreaterThan(0);
    expect(next.grid[7 * COLS + 7]).toBeGreaterThan(0);
  });

  it("does not spread into blocked cells", () => {
    const state = makeEmptyState();
    state.blockedCells[5 * COLS + 5] = 1;
    state.grid[5 * COLS + 5] = 0.5;
    expect(stepDiffusion(state).grid[5 * COLS + 5]).toBeLessThanOrEqual(0.5);
  });

  it("diffusion rate 0 keeps gas at source only", () => {
    const base = { ...makeEmptyState(), gasLeaks: [{ id: "l1", row: 5, col: 5 }] };
    const next = stepDiffusion(base, { ...DEFAULT_PARAMS, diffusionRate: 0 });
    expect(next.grid[4 * COLS + 5]).toBe(0);
    expect(next.grid[6 * COLS + 5]).toBe(0);
  });
});

describe("stepDiffusion — wind advection", () => {
  it("positive windX shifts concentration rightward", () => {
    const state = makeEmptyState();
    state.grid[5 * COLS + 2] = 0.8;
    let s = state;
    for (let i = 0; i < 20; i++)
      s = stepDiffusion(s, { ...DEFAULT_PARAMS, diffusionRate: 0, windX: 0.5, windY: 0 });
    const left  = Array.from(s.grid.slice(5 * COLS, 5 * COLS + 3)).reduce((a, b) => a + b, 0);
    const right = Array.from(s.grid.slice(5 * COLS + 3, 5 * COLS + 8)).reduce((a, b) => a + b, 0);
    expect(right).toBeGreaterThan(left);
  });

  it("wind shadow mask prevents advection in sheltered cells", () => {
    // Gas starts at col 4, shadow covers cols 5-9 on row 5.
    // We run only 5 ticks so the gas is just beginning to cross the shadow
    // boundary — the difference between shadowed and unshadowed is clear
    // and well above floating-point noise.
    const params = { ...DEFAULT_PARAMS, diffusionRate: 0, windX: 0.5, windY: 0 };

    const shadow = new Uint8Array(ROWS * COLS);
    for (let c = 5; c < COLS; c++) shadow[5 * COLS + c] = 1;

    const base = makeEmptyState();
    base.grid[5 * COLS + 4] = 0.8;

    let withShadow: SimulationState    = { ...base, grid: new Float32Array(base.grid) };
    let withoutShadow: SimulationState = { ...base, grid: new Float32Array(base.grid) };

    for (let i = 0; i < 5; i++) {
      withShadow    = stepDiffusion(withShadow,    params, shadow);
      withoutShadow = stepDiffusion(withoutShadow, params);
    }

    const sumShadowed   = Array.from(withShadow.grid.slice(5*COLS+5, 5*COLS+9)).reduce((a,b)=>a+b,0);
    const sumUnshadowed = Array.from(withoutShadow.grid.slice(5*COLS+5, 5*COLS+9)).reduce((a,b)=>a+b,0);

    // Unshadowed must have meaningfully more gas past the boundary.
    // Using a 10% margin so floating-point near-equality cannot cause a false pass.
    expect(sumUnshadowed).toBeGreaterThan(sumShadowed * 1.1);
  });

  it("upwind advection never introduces negative values", () => {
    const state = makeEmptyState();
    state.grid[5 * COLS + 5] = 0.5;
    let s = state;
    for (let i = 0; i < 30; i++)
      s = stepDiffusion(s, { ...DEFAULT_PARAMS, diffusionRate: 0, windX: 0.8, windY: 0.8 });
    expect(Math.min(...Array.from(s.grid))).toBeGreaterThanOrEqual(0);
  });
});
