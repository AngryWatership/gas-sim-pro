/**
 * Wind Shadow Mask — v3
 *
 * Rules:
 *   1. A contiguous run of (wall OR door) cells forms one segment — doors
 *      do not break a wall into separate pieces.
 *   2. Rays are cast only from the outermost SOLID WALL cells of each segment
 *      (not from door cells, even if a door is at the physical end of a run).
 *      Walking inward from the raw extremity until we hit a solid cell gives
 *      the correct anchor.
 *   3. Every unvisited solid wall cell also casts individually (handles
 *      isolated cells, L-corners, diagonal walls).
 *   4. Rays travel all the way to the canvas boundary — no early exit on
 *      hitting another wall. The total mask is the union of all rays, so
 *      overlapping rays are harmless (shadow[i]=1 twice = shadow[i]=1).
 */

export function buildWindShadow(
  blockedCells: Uint8Array,
  doorCells: Uint8Array,
  rows: number,
  cols: number,
  windX: number,
  windY: number,
): Uint8Array {
  const shadow = new Uint8Array(rows * cols);
  if (windX === 0 && windY === 0) return shadow;

  const ax = Math.abs(windX);
  const ay = Math.abs(windY);
  const sx = windX > 0 ? 1 : windX < 0 ? -1 : 0;
  const sy = windY > 0 ? 1 : windY < 0 ? -1 : 0;

  // Cast from (r,c) all the way to the canvas boundary, marking every cell.
  function castRay(r: number, c: number) {
    let cr = r + sy;
    let cc = c + sx;
    let err = ax - ay;
    while (cr >= 0 && cr < rows && cc >= 0 && cc < cols) {
      shadow[cr * cols + cc] = 1;
      if (ax === 0) {
        cr += sy;
      } else if (ay === 0) {
        cc += sx;
      } else {
        const e2 = 2 * err;
        if (e2 > -ay) { err -= ay; cc += sx; }
        if (e2 <  ax) { err += ax; cr += sy; }
      }
    }
  }

  // Given the raw start/end indices of a segment, find the innermost solid
  // wall cell by stepping inward. Returns -1 if no solid cell exists (pure
  // door segment — no ray cast).
  function solidExtremity(
    fixed: number,        // the row (horiz) or col (vert) that doesn't change
    a: number,            // one end of the segment (col or row index)
    b: number,            // other end
    isHoriz: boolean,
  ): [number, number] | null {
    // Walk from a toward b until we find a solid wall cell
    const step = a <= b ? 1 : -1;
    for (let i = a; i !== b + step; i += step) {
      const idx = isHoriz ? fixed * cols + i : i * cols + fixed;
      if (blockedCells[idx] && !doorCells[idx]) return isHoriz ? [fixed, i] : [i, fixed];
    }
    return null;
  }

  const visited = new Uint8Array(rows * cols);

  // Helper: cast from the solid extremity of a segment and mark visited.
  function castFromExtremity(r: number, c: number) {
    visited[r * cols + c] = 1;
    castRay(r, c);
  }

  // ── Horizontal segments (scan by row) ──────────────────────────────────
  for (let r = 0; r < rows; r++) {
    let segStart = -1;
    for (let c = 0; c <= cols; c++) {
      // Doors count as wall material for continuity — they don't break segments
      const isWallMaterial = c < cols && !!(blockedCells[r * cols + c]);
      if (isWallMaterial && segStart === -1) {
        segStart = c;
      } else if (!isWallMaterial && segStart !== -1) {
        const c0 = segStart, c1 = c - 1;
        // Cast from the outermost SOLID cell on each end (skip if door is at extremity)
        const left  = solidExtremity(r, c0, c1, true);
        const right = solidExtremity(r, c1, c0, true);
        if (left)  castFromExtremity(left[0],  left[1]);
        if (right && !(right[0] === left?.[0] && right[1] === left?.[1]))
          castFromExtremity(right[0], right[1]);
        segStart = -1;
      }
    }
  }

  // ── Vertical segments (scan by col) ────────────────────────────────────
  for (let c = 0; c < cols; c++) {
    let segStart = -1;
    for (let r = 0; r <= rows; r++) {
      const isWallMaterial = r < rows && !!(blockedCells[r * cols + c]);
      if (isWallMaterial && segStart === -1) {
        segStart = r;
      } else if (!isWallMaterial && segStart !== -1) {
        const r0 = segStart, r1 = r - 1;
        const top    = solidExtremity(c, r0, r1, false);
        const bottom = solidExtremity(c, r1, r0, false);
        if (top)    castFromExtremity(top[0],    top[1]);
        if (bottom && !(bottom[0] === top?.[0] && bottom[1] === top?.[1]))
          castFromExtremity(bottom[0], bottom[1]);
        segStart = -1;
      }
    }
  }

  // ── Individual solid wall cells (unvisited: isolated cells, corners) ────
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!blockedCells[idx] || doorCells[idx]) continue; // solid walls only
      if (visited[idx]) continue;
      castRay(r, c);
    }
  }

  return shadow;
}