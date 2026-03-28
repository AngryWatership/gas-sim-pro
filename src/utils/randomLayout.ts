import type { LayoutSnapshot, SimParams, GasLeak, Sensor } from "../engine/types";
import {
  type GeneratorConfig,
  defaultConfig,
  lockedConfig,
} from "./generatorConfig";

const ROWS = 100;
const COLS = 100;
const BOUNDARY = 5;

// ── Seeded PRNG (Mulberry32) ──────────────────────────────────────────────
function makePrng(seed: number) {
  let s = seed >>> 0;
  return {
    next(): number {
      s += 0x6d2b79f5;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 0xffffffff;
    },
    int(lo: number, hi: number): number {
      return lo + Math.floor(this.next() * (hi - lo + 1));
    },
    pick<T>(arr: T[]): T {
      return arr[this.int(0, arr.length - 1)];
    },
  };
}

type Rng = ReturnType<typeof makePrng>;

// ── config_hash ───────────────────────────────────────────────────────────
// Stable 6-char hex hash of which dimensions are randomised.
// Same config always produces the same hash — used for BigQuery filtering.
function computeConfigHash(cfg: GeneratorConfig): string {
  const key = [
    cfg.randomiseWalls     ? "W" : "w",
    cfg.randomiseDoors     ? "D" : "d",
    cfg.randomiseLeaks     ? "L" : "l",
    cfg.randomiseSensors   ? "S" : "s",
    cfg.randomiseWind      ? "N" : "n",
    cfg.randomiseDiffusion ? "F" : "f",
    cfg.randomiseDecay     ? "C" : "c",
    cfg.randomiseInjection ? "I" : "i",
  ].join("");
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h) ^ key.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16).padStart(6, "0").slice(0, 6);
}

// ── Helpers ───────────────────────────────────────────────────────────────
function idx(r: number, c: number): number { return r * COLS + c; }

function cellsOfSegment(
  r0: number, c0: number,
  r1: number, c1: number,
): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  let r = r0, c = c0;
  const dr = Math.abs(r1 - r0), dc = Math.abs(c1 - c0);
  const sr = r0 < r1 ? 1 : -1, sc = c0 < c1 ? 1 : -1;
  let err = dr - dc;
  for (;;) {
    cells.push([r, c]);
    if (r === r1 && c === c1) break;
    const e2 = 2 * err;
    if (e2 > -dc) { err -= dc; r += sr; }
    if (e2 <  dr) { err += dr; c += sc; }
  }
  return cells;
}

// ── Wall generation ───────────────────────────────────────────────────────
interface WallSegment {
  cells: Array<[number, number]>;
  isHoriz: boolean;
}

function generateWalls(
  rng: Rng,
  cfg: GeneratorConfig,
  fixedWalls?: number[],
): { blocked: Set<number>; segments: WallSegment[] } {
  if (!cfg.randomiseWalls && fixedWalls) {
    const blocked = new Set(fixedWalls);
    const cells = fixedWalls.map(i => [Math.floor(i / COLS), i % COLS] as [number, number]);
    return { blocked, segments: [{ cells, isHoriz: true }] };
  }

  const blocked = new Set<number>();
  const segments: WallSegment[] = [];
  const count = rng.int(cfg.wallCountMin, cfg.wallCountMax);
  const MAX_ATTEMPTS = 60;

  for (let w = 0; w < count; w++) {
    let placed = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const isHoriz = rng.next() > 0.5;
      const length  = rng.int(cfg.wallLengthMin, cfg.wallLengthMax);

      let r0: number, c0: number, r1: number, c1: number;
      if (isHoriz) {
        r0 = rng.int(BOUNDARY, ROWS - BOUNDARY - 1);
        c0 = rng.int(BOUNDARY, COLS - BOUNDARY - length);
        r1 = r0; c1 = c0 + length - 1;
      } else {
        r0 = rng.int(BOUNDARY, ROWS - BOUNDARY - length);
        c0 = rng.int(BOUNDARY, COLS - BOUNDARY - 1);
        r1 = r0 + length - 1; c1 = c0;
      }

      const cells = cellsOfSegment(r0, c0, r1, c1);
      const overlaps = cells.filter(([r, c]) => blocked.has(idx(r, c))).length;
      if (overlaps > 2) continue;

      const tooClose = cells.some(([r, c]) => {
        for (let dr = -2; dr <= 2; dr++)
          for (let dc = -2; dc <= 2; dc++) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS) continue;
            if (blocked.has(idx(nr, nc)) && !cells.some(([cr, cc]) => cr === nr && cc === nc))
              return true;
          }
        return false;
      });
      if (tooClose) continue;

      cells.forEach(([r, c]) => blocked.add(idx(r, c)));
      segments.push({ cells, isHoriz });
      placed = true;
      break;
    }

    if (!placed) {
      const r0 = rng.int(BOUNDARY + 5, ROWS - BOUNDARY - 15);
      const c0 = rng.int(BOUNDARY + 5, COLS - BOUNDARY - 15);
      const len = rng.int(cfg.wallLengthMin, Math.min(cfg.wallLengthMin + 10, cfg.wallLengthMax));
      const cells = cellsOfSegment(r0, c0, r0, c0 + len - 1);
      cells.forEach(([r, c]) => {
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS) blocked.add(idx(r, c));
      });
      segments.push({ cells, isHoriz: true });
    }
  }

  return { blocked, segments };
}

// ── Door generation ───────────────────────────────────────────────────────
function generateDoors(
  rng: Rng,
  cfg: GeneratorConfig,
  segments: WallSegment[],
  blocked: Set<number>,
  fixedDoors?: number[],
): { doors: Set<number>; blocked: Set<number> } {
  if (!cfg.randomiseDoors && fixedDoors) {
    const doors = new Set(fixedDoors);
    const b = new Set(blocked);
    fixedDoors.forEach(i => b.delete(i));
    return { doors, blocked: b };
  }

  const doors = new Set<number>();
  const count = rng.int(cfg.doorCountMin, cfg.doorCountMax);

  for (let d = 0; d < count; d++) {
    const seg = rng.pick(segments);
    if (seg.cells.length < 4) continue;

    const doorWidth = rng.int(cfg.doorWidthMin, cfg.doorWidthMax);
    const maxStart = seg.cells.length - doorWidth - 1;
    if (maxStart < 2) continue;
    const start = rng.int(1, maxStart);

    for (let i = start; i < start + doorWidth; i++) {
      const [r, c] = seg.cells[i];
      const i_ = idx(r, c);
      doors.add(i_);
      blocked.delete(i_);
    }
  }

  return { doors, blocked };
}

// ── Leak generation ───────────────────────────────────────────────────────
function generateLeaks(
  rng: Rng,
  cfg: GeneratorConfig,
  blocked: Set<number>,
  doors: Set<number>,
  fixedLeaks?: GasLeak[],
): GasLeak[] {
  if (!cfg.randomiseLeaks && fixedLeaks) return fixedLeaks;

  const count = 1;  // Always generate exactly 1 leak for ML training quality
  const leaks: GasLeak[] = [];
  const MIN_APART = 8;
  const MAX_ATTEMPTS = 80;

  for (let l = 0; l < count; l++) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = rng.int(BOUNDARY, ROWS - BOUNDARY - 1);
      const c = rng.int(BOUNDARY, COLS - BOUNDARY - 1);
      const i_ = idx(r, c);

      if (blocked.has(i_) || doors.has(i_)) continue;
      const tooClose = leaks.some(
        (lk) => Math.abs(lk.row - r) + Math.abs(lk.col - c) < MIN_APART,
      );
      if (tooClose) continue;

      leaks.push({ id: `leak-rnd-${l}-${r}-${c}`, row: r, col: c });
      break;
    }
  }

  return leaks;
}

// ── Sensor generation ─────────────────────────────────────────────────────
function generateSensors(
  rng: Rng,
  cfg: GeneratorConfig,
  blocked: Set<number>,
  doors: Set<number>,
  leaks: GasLeak[],
  fixedSensors?: Sensor[],
): Sensor[] {
  if (!cfg.randomiseSensors && fixedSensors) return fixedSensors;

  const count = rng.int(cfg.sensorCountMin, cfg.sensorCountMax);
  const sensors: Sensor[] = [];
  const MIN_APART = 5;
  const MAX_ATTEMPTS = 100;

  const quadrants: Array<[number, number, number, number]> = [
    [BOUNDARY,     BOUNDARY,     ROWS / 2 - 1,         COLS / 2 - 1],
    [BOUNDARY,     COLS / 2,     ROWS / 2 - 1,         COLS - BOUNDARY - 1],
    [ROWS / 2,     BOUNDARY,     ROWS - BOUNDARY - 1,  COLS / 2 - 1],
    [ROWS / 2,     COLS / 2,     ROWS - BOUNDARY - 1,  COLS - BOUNDARY - 1],
  ];

  const occupied = new Set([...blocked, ...doors]);
  leaks.forEach((lk) => occupied.add(idx(lk.row, lk.col)));

  const tryPlace = (rMin: number, cMin: number, rMax: number, cMax: number): boolean => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const r = rng.int(rMin, rMax);
      const c = rng.int(cMin, cMax);
      const i_ = idx(r, c);
      if (occupied.has(i_)) continue;
      const tooClose = sensors.some(
        (s) => Math.abs(s.row - r) + Math.abs(s.col - c) < MIN_APART,
      );
      if (tooClose) continue;
      sensors.push({ id: `sensor-rnd-${r}-${c}`, row: r, col: c });
      occupied.add(i_);
      return true;
    }
    return false;
  };

  quadrants.forEach(([rMin, cMin, rMax, cMax]) => tryPlace(rMin, cMin, rMax, cMax));
  const remaining = count - sensors.length;
  for (let s = 0; s < remaining; s++) {
    tryPlace(BOUNDARY, BOUNDARY, ROWS - BOUNDARY - 1, COLS - BOUNDARY - 1);
  }

  return sensors;
}

// ── Physics params ────────────────────────────────────────────────────────
function generateParams(
  rng: Rng,
  cfg: GeneratorConfig,
  fixedParams?: Partial<SimParams>,
): SimParams {
  let windX: number, windY: number;
  if (!cfg.randomiseWind && fixedParams?.windX !== undefined && fixedParams?.windY !== undefined) {
    windX = fixedParams.windX;
    windY = fixedParams.windY;
  } else {
    do {
      windX = (rng.next() * 0.8) - 0.4;
      windY = (rng.next() * 0.8) - 0.4;
    } while (Math.sqrt(windX * windX + windY * windY) < 0.05);
  }

  const diffusionRates = [0.06, 0.08, 0.10, 0.12, 0.15, 0.18];
  const decayFactors   = [0.995, 0.997, 0.999, 0.9995, 0.9999];
  const injections     = [5, 10, 15, 20, 30, 40, 50];

  return {
    diffusionRate: cfg.randomiseDiffusion
      ? rng.pick(diffusionRates)
      : (fixedParams?.diffusionRate ?? 0.10),
    decayFactor: cfg.randomiseDecay
      ? rng.pick(decayFactors)
      : (fixedParams?.decayFactor ?? 0.999),
    leakInjection: cfg.randomiseInjection
      ? rng.pick(injections)
      : (fixedParams?.leakInjection ?? 20),
    tickMs: 30,
    windX:  Math.round(windX * 100) / 100,
    windY:  Math.round(windY * 100) / 100,
  };
}

// ── Public API ────────────────────────────────────────────────────────────
export interface RandomLayoutResult {
  snapshot: LayoutSnapshot;
  params: SimParams;
  seed: number;
  config_hash: string;
  locked_dimensions: string[];
}

/**
 * Generate a random (or partially locked) layout.
 *
 * @param seed       - Optional seed for reproducibility.
 * @param config     - Which dimensions to randomise. Defaults to all ON.
 * @param fixedState - Current layout values used when a dimension is locked.
 */
export function generateRandomLayout(
  seed?: number,
  config: GeneratorConfig = defaultConfig,
  fixedState?: {
    walls?: number[];
    doors?: number[];
    leaks?: GasLeak[];
    sensors?: Sensor[];
    params?: Partial<SimParams>;
  },
): RandomLayoutResult {
  const s = seed ?? (Math.random() * 0xffffffff) >>> 0;
  const rng = makePrng(s);

  const { blocked, segments }    = generateWalls(rng, config, fixedState?.walls);
  const { doors, blocked: blk2 } = generateDoors(rng, config, segments, blocked, fixedState?.doors);
  const leaks                    = generateLeaks(rng, config, blk2, doors, fixedState?.leaks);
  const sensors                  = generateSensors(rng, config, blk2, doors, leaks, fixedState?.sensors);
  const params                   = generateParams(rng, config, fixedState?.params);

  const snapshot: LayoutSnapshot = {
    version: 1,
    walls:    [...blk2],
    doors:    [...doors],
    gasLeaks: leaks,
    sensors,
  };

  return {
    snapshot,
    params,
    seed: s,
    config_hash: computeConfigHash(config),
    locked_dimensions: lockedConfig(config),
  };
}
