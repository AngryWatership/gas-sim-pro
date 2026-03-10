/**
 * Wind Shadow Mask
 *
 * Concept:
 *   Real wind is blocked by solid obstacles and creates a sheltered "shadow"
 *   zone on the downwind side. We model this by:
 *
 *   1. For every solid wall cell, cast a ray in the DOWNWIND direction
 *      (same direction as wind vector).
 *   2. Every cell hit by that ray is marked as sheltered (windShadow = 1).
 *   3. A door interrupts occlusion — the ray stops casting shadow once it
 *      exits a wall run through a door gap.
 *   4. Cells marked sheltered receive zero wind flux in the advection step.
 *
 * The mask is recomputed only when the wind vector or wall layout changes,
 * not every physics tick.
 *
 * Complexity: O(walls × max_ray_length) ≤ O(N²) worst case, fine for 100×100.
 */

export function buildWindShadow(
  blockedCells: Uint8Array,
  doorCells: Uint8Array,
  rows: number,
  cols: number,
  windX: number,
  windY: number
): Uint8Array {
  const shadow = new Uint8Array(rows * cols);

  if (windX === 0 && windY === 0) return shadow; // no wind → no shadow

  // Normalise wind to step direction (±1 or 0 per axis).
  // We step one cell at a time in the dominant wind direction.
  // For diagonal wind we alternate rows/cols proportionally using
  // Bresenham-style DDA so the shadow cone tracks the actual vector.
  const ax = Math.abs(windX);
  const ay = Math.abs(windY);
  const sx = windX > 0 ? 1 : windX < 0 ? -1 : 0;
  const sy = windY > 0 ? 1 : windY < 0 ? -1 : 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      // Only solid walls cast shadows (doors do NOT block wind)
      if (!blockedCells[idx] || doorCells[idx]) continue;

      // March downwind from this wall cell
      let cr = r + sy;
      let cc = c + sx;
      // DDA error accumulator for diagonal wind
      let err = ax - ay;

      while (cr >= 0 && cr < rows && cc >= 0 && cc < cols) {
        const cidx = cr * cols + cc;

        // Another solid wall encountered → it will cast its own shadow,
        // stop this ray (the wall itself is not in shadow)
        if (blockedCells[cidx] && !doorCells[cidx]) break;

        // Door gap → let wind through, stop the shadow here
        if (doorCells[cidx]) break;

        // Open cell — mark as shadowed
        shadow[cidx] = 1;

        // DDA step
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
  }

  return shadow;
}
