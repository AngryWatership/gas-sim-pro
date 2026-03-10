/** Returns all grid cells on the line from (r0,c0) to (r1,c1) */
export function bresenhamLine(
  r0: number, c0: number,
  r1: number, c1: number
): Array<{ row: number; col: number }> {
  const cells: Array<{ row: number; col: number }> = [];
  let dr = Math.abs(r1 - r0);
  let dc = Math.abs(c1 - c0);
  const sr = r0 < r1 ? 1 : -1;
  const sc = c0 < c1 ? 1 : -1;
  let err = dr - dc;
  let r = r0, c = c0;

  while (true) {
    cells.push({ row: r, col: c });
    if (r === r1 && c === c1) break;
    const e2 = 2 * err;
    if (e2 > -dc) { err -= dc; r += sr; }
    if (e2 < dr)  { err += dr; c += sc; }
  }
  return cells;
}

/** Snaps endpoint to straight H/V line (Shift+click behaviour) */
export function snapToAxis(
  r0: number, c0: number,
  r1: number, c1: number
): { row: number; col: number } {
  if (Math.abs(r1 - r0) >= Math.abs(c1 - c0)) {
    return { row: r1, col: c0 }; // vertical
  }
  return { row: r0, col: c1 }; // horizontal
}
