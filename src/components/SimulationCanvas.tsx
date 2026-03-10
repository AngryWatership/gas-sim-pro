import { useRef, useEffect, useCallback, useState } from "react";
import type { SimulationState, ToolMode } from "../engine/types";
import type { EstimationResult } from "../engine/triangulation";
import { bresenhamLine, snapToAxis } from "../utils/bresenham";

export interface EraserSize { w: number; h: number; }

interface Props {
  simState: SimulationState;
  tool: ToolMode;
  estimation: EstimationResult | null;
  lightMode: boolean;
  windShadow: Uint8Array;
  showShadow: boolean;
  eraserSize: { w: number; h: number };
  onCellsInteract: (cells: Array<{ row: number; col: number }>, tool: ToolMode) => void;
}

const CELL = 8;
const ROWS = 100;
const COLS = 100;
const W = CELL * COLS;
const H = CELL * ROWS;

// ── ImageData pixel buffer — allocated once, reused every draw ────────────
// Painting 10,000 cells via fillRect() costs ~12ms at 60% coverage.
// Writing into a Uint32Array + putImageData() costs ~0.5ms regardless of
// coverage. Each cell is CELL×CELL pixels; we write one block per grid cell.
const _pixelBuf  = new Uint8ClampedArray(W * H * 4);
const _imageData = new ImageData(_pixelBuf, W, H);

// Single unified color palette — same in canvas, legend, side panel, 3D chart
export const ACCENT_COLOR  = "#ff4b6e"; // leaks
export const SENSOR_COLOR  = "#ffdd00"; // sensors
export const WALL_COLOR_DK = "#e8a040";
export const WALL_COLOR_LT = "#555555";
export const DOOR_COLOR    = "#2ecc71";

// Tool → hover glow color
const TOOL_GLOW: Partial<Record<ToolMode, string>> = {
  gas_leak: ACCENT_COLOR,
  sensor:   SENSOR_COLOR,
  wall:     WALL_COLOR_DK,
  door:     DOOR_COLOR,
  eraser:   "#ff5555",
};

// Build the W×H footprint centred on `center` for eraser operations.
// Odd sizes centre exactly; even sizes extend one more cell to right/bottom.
function eraserFootprint(
  center: { row: number; col: number },
  size: EraserSize,
): Array<{ row: number; col: number }> {
  const halfW = Math.floor(size.w / 2);
  const halfH = Math.floor(size.h / 2);
  const r0 = center.row - halfH;
  const c0 = center.col - halfW;
  const cells: Array<{ row: number; col: number }> = [];
  for (let dr = 0; dr < size.h; dr++)
    for (let dc = 0; dc < size.w; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r >= 0 && r < ROWS && c >= 0 && c < COLS) cells.push({ row: r, col: c });
    }
  return cells;
}

export default function SimulationCanvas({
  simState, tool, estimation, lightMode, windShadow, showShadow, eraserSize, onCellsInteract,
}: Props) {
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const wallStartRef   = useRef<{ row: number; col: number } | null>(null);
  const eraserDragging = useRef(false);
  // Ref so eraserSize is always current inside useCallback closures (no stale deps)
  const eraserSizeRef  = useRef(eraserSize);
  eraserSizeRef.current = eraserSize;
  const [previewLine, setPreviewLine] = useState<Array<{ row: number; col: number }>>([]);
  const [hoverCell, setHoverCell]     = useState<{ row: number; col: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // DIAG ──────────────────────────────────────────────────────────────────
    const __DIAG__ = true;
    const _draw0 = performance.now();
    let _hotCells = 0;
    // END DIAG ───────────────────────────────────────────────────────────────

    // ── Single-pass ImageData render (gas + shadow + walls + doors) ─────────
    // Replaces 4 separate fillRect loops (~6000+ calls at 60% coverage) with
    // one putImageData call. ~20× faster at high gas coverage.
    {
      const bg   = lightMode ? [255, 255, 255] : [10, 12, 16];
      // Wall colors as [r,g,b]
      const wallRGB = lightMode ? [85, 85, 85]      : [232, 160, 64];
      const doorRGB = lightMode ? [22, 163, 74]     : [46, 204, 113];
      const shadRGB = lightMode ? [100, 100, 200]   : [60, 80, 180];
      const shadA   = lightMode ? 26 : 46; // ~0.10 and ~0.18 alpha * 255

      const buf   = _pixelBuf;
      const { grid, blockedCells, doorCells } = simState;

      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const cellIdx = r * COLS + c;

          // Determine pixel color for this grid cell
          let pr: number, pg: number, pb: number, pa = 255;

          if (blockedCells[cellIdx] && !doorCells[cellIdx]) {
            [pr, pg, pb] = wallRGB;
          } else if (doorCells[cellIdx]) {
            [pr, pg, pb] = doorRGB;
          } else {
            const val = grid[cellIdx];
            if (val > 0.003) {
              if (__DIAG__) _hotCells++; // DIAG
              const v = Math.min(1, val);
              if (lightMode) {
                // Original light mode:blue-tinted cyan on black
                pr = Math.round(v * v * 180);
                pg = Math.round(v * 220);
                pb = Math.round(80 + v * 175);
              }  else {
                // Original dark mode: warm red on white
                pr = 255;
                pg = Math.round(220 - v * 180);
                pb = Math.round(180 - v * 180);
                pa = Math.round(40 + v * 200);
              }
              // Blend wind shadow on top of gas
              if (showShadow && windShadow[cellIdx]) {
                pr = Math.round(pr * (1 - shadA / 255) + shadRGB[0] * shadA / 255);
                pg = Math.round(pg * (1 - shadA / 255) + shadRGB[1] * shadA / 255);
                pb = Math.round(pb * (1 - shadA / 255) + shadRGB[2] * shadA / 255);
              }
            } else if (showShadow && windShadow[cellIdx]) {
              pr = Math.round(bg[0] * (1 - shadA / 255) + shadRGB[0] * shadA / 255);
              pg = Math.round(bg[1] * (1 - shadA / 255) + shadRGB[1] * shadA / 255);
              pb = Math.round(bg[2] * (1 - shadA / 255) + shadRGB[2] * shadA / 255);
            } else {
              [pr, pg, pb] = bg;
            }
          }

          // Write CELL×CELL block of pixels into the buffer
          for (let pr2 = 0; pr2 < CELL; pr2++) {
            const rowBase = ((r * CELL + pr2) * W + c * CELL) * 4;
            for (let pc2 = 0; pc2 < CELL; pc2++) {
              const p = rowBase + pc2 * 4;
              buf[p]     = pr;
              buf[p + 1] = pg;
              buf[p + 2] = pb;
              buf[p + 3] = pa;
            }
          }
        }
      }

      ctx.putImageData(_imageData, 0, 0);
    }

    // ── Wall preview (Bresenham drag) ─────────────────────────────────────
    if (previewLine.length > 0) {
      ctx.fillStyle = lightMode ? "rgba(80,80,80,0.4)" : "rgba(232,160,64,0.4)";
      previewLine.forEach(({ row, col }) => ctx.fillRect(col * CELL, row * CELL, CELL, CELL));
    }

    // ── Hover glow ────────────────────────────────────────────────────────
    if (hoverCell && tool !== "none") {
      const glowColor = TOOL_GLOW[tool];
      if (glowColor) {
        const cells = tool === "eraser" ? eraserFootprint(hoverCell, eraserSizeRef.current) : [hoverCell];

        cells.forEach(({ row, col }) => {
          ctx.fillStyle = `${glowColor}28`;
          ctx.fillRect(col * CELL, row * CELL, CELL, CELL);
          ctx.strokeStyle = `${glowColor}88`;
          ctx.lineWidth = 1;
          ctx.strokeRect(col * CELL + 0.5, row * CELL + 0.5, CELL - 1, CELL - 1);
        });
      }
    }

    // ── Grid lines (every 10 cells) ───────────────────────────────────────
    ctx.strokeStyle = lightMode ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.03)";
    ctx.lineWidth = 0.5;
    for (let r = 0; r <= ROWS; r += 10) {
      ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(W, r * CELL); ctx.stroke();
    }
    for (let c = 0; c <= COLS; c += 10) {
      ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, H); ctx.stroke();
    }

    // ── Sensors ───────────────────────────────────────────────────────────
    simState.sensors.forEach((s) => {
      const x = s.col * CELL + CELL / 2;
      const y = s.row * CELL + CELL / 2;
      const conc = simState.grid[s.row * COLS + s.col];
      // Concentration halo
      if (conc > 0.01) {
        ctx.beginPath();
        ctx.arc(x, y, CELL * 0.7 + conc * 8, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,221,0,${conc * 0.4})`;
        ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, CELL * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = lightMode ? "#d4a500" : SENSOR_COLOR;
      ctx.fill();
      ctx.strokeStyle = lightMode ? "#333" : "#fff";
      ctx.lineWidth = 1; ctx.stroke();
    });

    // ── Gas leak sources — all same color ─────────────────────────────────
    simState.gasLeaks.forEach((leak, i) => {
      const x = leak.col * CELL + CELL / 2;
      const y = leak.row * CELL + CELL / 2;
      ctx.beginPath(); ctx.arc(x, y, CELL, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT_COLOR; ctx.fill();
      ctx.strokeStyle = lightMode ? "#333" : "#fff";
      ctx.lineWidth = 1.5; ctx.stroke();
      ctx.font = `bold ${CELL - 1}px 'Share Tech Mono', monospace`;
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), x, y);
    });

    // ── Estimation crosshair ──────────────────────────────────────────────
    if (estimation) {
      const x = estimation.col * CELL + CELL / 2;
      const y = estimation.row * CELL + CELL / 2;
      const r = CELL * 1.4;
      ctx.strokeStyle = "rgba(0,180,255,0.9)";
      ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x - r * 2.5, y); ctx.lineTo(x + r * 2.5, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y - r * 2.5); ctx.lineTo(x, y + r * 2.5); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,180,255,0.9)";
      ctx.lineWidth = 2; ctx.stroke();
    }

    // ── Floating legend ───────────────────────────────────────────────────
    const legendItems = [
      { color: ACCENT_COLOR,                       label: `Leak (${simState.gasLeaks.length})` },
      { color: lightMode ? "#d4a500" : SENSOR_COLOR, label: `Sensor (${simState.sensors.length})` },
      { color: lightMode ? WALL_COLOR_LT : WALL_COLOR_DK, label: "Wall" },
      { color: DOOR_COLOR,                         label: "Door" },
      { color: "#00b4ff",                          label: "Estimated pos." },
      ...(showShadow ? [{ color: "rgba(100,120,220,0.7)", label: "Wind shadow" }] : []),
    ];
    const lx = W - 122, ly = 10, lpad = 8, lh = 16;
    const lboxH = legendItems.length * lh + lpad * 2;
    ctx.fillStyle = lightMode ? "rgba(255,255,255,0.88)" : "rgba(10,12,16,0.88)";
    ctx.strokeStyle = lightMode ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(lx, ly, 116, lboxH, 5); ctx.fill(); ctx.stroke();
    ctx.font = "10px 'Share Tech Mono', monospace";
    legendItems.forEach(({ color, label }, i) => {
      const iy = ly + lpad + i * lh + lh / 2;
      ctx.fillStyle = color;
      ctx.fillRect(lx + lpad, iy - 4, 10, 8);
      ctx.fillStyle = lightMode ? "#333" : "#c8d0e0";
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillText(label, lx + lpad + 14, iy + 4);
    });

    // DIAG ──────────────────────────────────────────────────────────────────
    if (__DIAG__) {
      const _drawMs = performance.now() - _draw0;
      if (_drawMs > 8) console.warn(
        `[gas-sim canvas] ${_drawMs.toFixed(1)}ms | hot cells: ${_hotCells}/10000 (${(_hotCells/100).toFixed(0)}%) | sensors: ${simState.sensors.length}`
      );
    }
    // END DIAG ───────────────────────────────────────────────────────────────

  }, [simState, estimation, lightMode, windShadow, showShadow, previewLine, hoverCell, tool]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const getCell = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const col = Math.floor(((e.clientX - rect.left) * (W / rect.width)) / CELL);
    const row = Math.floor(((e.clientY - rect.top)  * (H / rect.height)) / CELL);
    return {
      row: Math.max(0, Math.min(ROWS - 1, row)),
      col: Math.max(0, Math.min(COLS - 1, col)),
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const cell = getCell(e);
    if (tool === "wall") {
      wallStartRef.current = cell;
      setPreviewLine([cell]);
    } else if (tool === "eraser") {
      eraserDragging.current = true;
      onCellsInteract(eraserFootprint(cell, eraserSizeRef.current), "eraser");
    }
  }, [tool, getCell, onCellsInteract]);

  const lastEraseCellRef = useRef<{ row: number; col: number } | null>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const cell = getCell(e);
    setHoverCell(cell);
    if (tool === "eraser") {
      if (eraserDragging.current && e.buttons === 1) {
        // Only dispatch when cursor moves to a different cell — prevents
        // flooding dispatch with identical erase operations on sub-cell moves
        const last = lastEraseCellRef.current;
        if (!last || last.row !== cell.row || last.col !== cell.col) {
          lastEraseCellRef.current = cell;
          onCellsInteract(eraserFootprint(cell, eraserSizeRef.current), "eraser");
        }
      }
      return;
    }
    lastEraseCellRef.current = null;
    if (tool !== "wall" || !wallStartRef.current || e.buttons !== 1) return;
    const { row: r0, col: c0 } = wallStartRef.current;
    let er = cell.row, ec = cell.col;
    if (e.shiftKey) { const s = snapToAxis(r0, c0, cell.row, cell.col); er = s.row; ec = s.col; }
    setPreviewLine(bresenhamLine(r0, c0, er, ec));
  }, [tool, getCell, onCellsInteract]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool === "eraser") { eraserDragging.current = false; lastEraseCellRef.current = null; return; }
    if (tool !== "wall" || !wallStartRef.current) return;
    const cell = getCell(e);
    const { row: r0, col: c0 } = wallStartRef.current;
    let er = cell.row, ec = cell.col;
    if (e.shiftKey) { const s = snapToAxis(r0, c0, cell.row, cell.col); er = s.row; ec = s.col; }
    onCellsInteract(bresenhamLine(r0, c0, er, ec), "wall");
    wallStartRef.current = null;
    setPreviewLine([]);
  }, [tool, getCell, onCellsInteract]);

  const handleMouseLeave = useCallback(() => {
    setHoverCell(null);
    eraserDragging.current = false;
  }, []);

  const DOOR_RADIUS = 2;
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool === "wall" || tool === "eraser") return;
    const { row, col } = getCell(e);
    if (tool === "door") {
      const cells: Array<{ row: number; col: number }> = [];
      for (let dr = -DOOR_RADIUS; dr <= DOOR_RADIUS; dr++)
        for (let dc = -DOOR_RADIUS; dc <= DOOR_RADIUS; dc++) {
          const r = row + dr, c = col + dc;
          if (r >= 0 && r < ROWS && c >= 0 && c < COLS && simState.blockedCells[r * COLS + c])
            cells.push({ row: r, col: c });
        }
      if (cells.length > 0) onCellsInteract(cells, "door");
      return;
    }
    onCellsInteract([{ row, col }], tool);
  }, [tool, getCell, onCellsInteract, simState.blockedCells]);

  const cursorMap: Record<ToolMode, string> = {
    gas_leak: "crosshair", sensor: "cell", wall: "copy",
    door: "pointer", eraser: "none", none: "default",
  };

  return (
    <canvas
      ref={canvasRef}
      width={W} height={H}
      style={{ cursor: cursorMap[tool], width: "100%", height: "100%", display: "block" }}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    />
  );
}
