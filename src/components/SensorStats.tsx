import { useRef, useEffect, useState, useCallback } from "react";
import type { SimulationState } from "../engine/types";
import type { EstimationResult } from "../engine/triangulation";
import { ACCENT_COLOR, SENSOR_COLOR } from "./SimulationCanvas";

interface Props {
  simState: SimulationState;
  estimation: EstimationResult | null;
}

function Bar({ value, color }: { value: number; color?: string }) {
  const c = color ?? (value > 0.6 ? "#ff4b6e" : value > 0.2 ? "#ffb347" : "#00e5ff");
  return (
    <div style={{ flex: 1, height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
      <div style={{
        height: "100%", width: `${Math.min(100, value * 100)}%`,
        background: c, borderRadius: 2, transition: "width 0.1s ease",
      }}/>
    </div>
  );
}

// ── 3D isometric chart (draggable rotation) ────────────────────────────────
const ROWS = 100;
const COLS = 100;
const CW = 188, CH = 200;

interface ChartProps {
  simState: SimulationState;
  useRelative: boolean;
}

function SensorChart3D({ simState, useRelative }: ChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Rotation state: azimuth (horizontal) and elevation (vertical) in radians
  const azimuthRef   = useRef<number>(Math.PI / 4);   // 45° default
  const elevationRef = useRef<number>(Math.PI / 6);   // 30° default
  const dragRef      = useRef<{ x: number; y: number } | null>(null);
  const [, forceRedraw] = useState(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(0, 0, CW, CH);

    const { sensors, grid, dimensions } = simState;
    if (sensors.length === 0) {
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.font = "10px 'Share Tech Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No sensors placed", CW / 2, CH / 2);
      return;
    }

    const readings = sensors.map((s) => ({
      sensor: s,
      value: grid[s.row * dimensions.cols + s.col],
    }));

    const maxVal = useRelative
      ? Math.max(...readings.map((r) => r.value), 0.001)
      : 1.0;

    const az  = azimuthRef.current;
    const el  = elevationRef.current;
    const cosAz = Math.cos(az), sinAz = Math.sin(az);
    const cosEl = Math.cos(el), sinEl = Math.sin(el);

    // 3D → 2D: isometric-ish with user-controlled rotation
    // World: x=col, y=row, z=height. Screen: right=x-axis, down=y-axis.
    function project(wx: number, wy: number, wz: number): [number, number] {
      // Rotate around vertical axis (azimuth)
      const rx = wx * cosAz - wy * sinAz;
      const ry = wx * sinAz + wy * cosAz;
      // Project with elevation
      const sx = CW / 2 + rx * 1.2;
      const sy = CH * 0.65 - ry * cosEl * 0.7 - wz * sinEl * 1.5;
      return [sx, sy];
    }

    // Normalise sensor coords to [-40, 40] range for projection
    function wp(col: number, row: number): [number, number] {
      return [(col / COLS - 0.5) * 80, (row / ROWS - 0.5) * 80];
    }

    // Draw grid floor
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 0.5;
    const STEPS = 4;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const [ax, ay] = project((t - 0.5) * 80, -40, 0);
      const [bx, by] = project((t - 0.5) * 80,  40, 0);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      const [cx2, cy] = project(-40, (t - 0.5) * 80, 0);
      const [dx, dy] = project( 40, (t - 0.5) * 80, 0);
      ctx.beginPath(); ctx.moveTo(cx2, cy); ctx.lineTo(dx, dy); ctx.stroke();
    }

    // Sort back-to-front based on projected y of base
    const sorted = readings
      .map((r) => {
        const [wx, wy] = wp(r.sensor.col, r.sensor.row);
        const [, sy] = project(wx, wy, 0);
        return { ...r, sortY: sy };
      })
      .sort((a, b) => b.sortY - a.sortY);

    const barMaxH = 50;

    sorted.forEach(({ sensor, value }) => {
      const normVal = value / maxVal;
      const wh = normVal * barMaxH;
      const [wx, wy] = wp(sensor.col, sensor.row);
      const bsize = 6;

      const [bx, by] = project(wx, wy, 0);
      const [tx, ty] = project(wx, wy, wh);

      // 4 corners of bar top and bottom
      const corners: Array<[number, number, number]> = [
        [wx - bsize, wy - bsize, 0], [wx + bsize, wy - bsize, 0],
        [wx + bsize, wy + bsize, 0], [wx - bsize, wy + bsize, 0],
      ];
      const proj0 = corners.map(([x, y, z]) => project(x, y, z));
      const proj1 = corners.map(([x, y, z]) => project(x, y, z + wh));

      if (wh > 0.5) {
        // Left face
        ctx.beginPath();
        ctx.moveTo(...proj0[0]); ctx.lineTo(...proj0[3]);
        ctx.lineTo(...proj1[3]); ctx.lineTo(...proj1[0]); ctx.closePath();
        ctx.fillStyle = `rgba(255,70,110,0.35)`; ctx.fill();

        // Right face
        ctx.beginPath();
        ctx.moveTo(...proj0[1]); ctx.lineTo(...proj0[2]);
        ctx.lineTo(...proj1[2]); ctx.lineTo(...proj1[1]); ctx.closePath();
        ctx.fillStyle = `rgba(255,70,110,0.25)`; ctx.fill();

        // Front face (nearest based on az)
        ctx.beginPath();
        ctx.moveTo(...proj0[2]); ctx.lineTo(...proj0[3]);
        ctx.lineTo(...proj1[3]); ctx.lineTo(...proj1[2]); ctx.closePath();
        ctx.fillStyle = `rgba(255,70,110,0.45)`; ctx.fill();
      }

      // Top face
      ctx.beginPath();
      ctx.moveTo(...proj1[0]); ctx.lineTo(...proj1[1]);
      ctx.lineTo(...proj1[2]); ctx.lineTo(...proj1[3]); ctx.closePath();
      ctx.fillStyle = ACCENT_COLOR; ctx.fill();

      // Base dot
      ctx.beginPath(); ctx.arc(bx, by, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,77,110,0.5)"; ctx.fill();

      // Value label above bar
      if (wh > 6) {
        ctx.font = "8px 'Share Tech Mono', monospace";
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(`${(value * 100).toFixed(0)}%`, tx, ty - 3);
      }

      // Sensor label at base
      const idx = simState.sensors.indexOf(sensor);
      ctx.font = "8px 'Share Tech Mono', monospace";
      ctx.fillStyle = SENSOR_COLOR;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(`S${String(idx + 1).padStart(2, "0")}`, bx, by + 3);
    });

    // Drag hint
    ctx.font = "8px 'Share Tech Mono', monospace";
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText("drag to rotate", CW / 2, CH - 3);

  }, [simState, useRelative]);

  // Redraw when state changes
  useEffect(() => { draw(); }, [draw]);

  // Mouse drag for rotation
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragRef.current || e.buttons !== 1) { dragRef.current = null; return; }
    const dx = e.clientX - dragRef.current.x;
    const dy = e.clientY - dragRef.current.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    azimuthRef.current   += dx * 0.012;
    elevationRef.current  = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, elevationRef.current - dy * 0.012));
    forceRedraw((n) => n + 1);
  }, []);

  const onMouseUp = useCallback(() => { dragRef.current = null; }, []);

  return (
    <canvas
      ref={canvasRef}
      width={CW} height={CH}
      style={{ display: "block", width: "100%", borderRadius: 6, cursor: "grab" }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    />
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────
export default function SensorStats({ simState, estimation }: Props) {
  const { sensors, grid, dimensions, gasLeaks } = simState;
  const [useRelative, setUseRelative] = useState(false);
  const [sensorsExpanded, setSensorsExpanded] = useState(true);

  return (
    <aside style={{
      width: 220, minWidth: 220,
      background: "var(--surface)",
      borderLeft: "1px solid var(--border)",
      display: "flex", flexDirection: "column",
      fontFamily: "var(--sans)", overflowY: "auto",
    }}>

      {/* Estimation */}
      <div style={{ padding: "20px 16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--text-dim)", marginBottom: 12 }}>
          ESTIMATION
        </div>
        {estimation ? (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
              {[{ label: "ROW", value: estimation.row.toFixed(1) }, { label: "COL", value: estimation.col.toFixed(1) }].map(({ label, value }) => (
                <div key={label} style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px" }}>
                  <div style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: 1, marginBottom: 3 }}>{label}</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 15, color: "#00b4ff" }}>{value}</div>
                </div>
              ))}
            </div>
            {estimation.error !== null ? (
              <div style={{ padding: "10px 12px", background: "var(--bg)", borderRadius: 6, border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: 1, marginBottom: 6 }}>POSITION ERROR</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 18, color: estimation.error < 5 ? "#2ecc71" : estimation.error < 15 ? "#ffb347" : "#ff4b6e", marginBottom: 6 }}>
                  {estimation.error.toFixed(2)} <span style={{ fontSize: 11, color: "var(--text-dim)" }}>cells</span>
                </div>
                <Bar value={Math.min(1, estimation.error / 30)} color={estimation.error < 5 ? "#2ecc71" : estimation.error < 15 ? "#ffb347" : "#ff4b6e"} />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <span style={{ fontSize: 9, color: "var(--text-dim)" }}>GOOD</span>
                  <span style={{ fontSize: 9, color: "var(--text-dim)" }}>POOR</span>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "var(--text-dim)", fontStyle: "italic" }}>No leak placed — error unavailable</div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>
            {sensors.length < 2 ? "Place ≥2 sensors to enable estimation" : "Waiting for gas to reach sensors..."}
          </div>
        )}
      </div>

      {/* Leak sources */}
      {gasLeaks.length > 0 && (
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--text-dim)", marginBottom: 8 }}>
            LEAK SOURCES ({gasLeaks.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {gasLeaks.map((leak) => (
              <div key={leak.id} style={{
                display: "grid", gridTemplateColumns: "auto 1fr 1fr", gap: 6,
                background: "var(--bg)", border: `1px solid ${ACCENT_COLOR}30`,
                borderRadius: 6, padding: "7px 10px", alignItems: "center",
              }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: ACCENT_COLOR, boxShadow: `0 0 4px ${ACCENT_COLOR}` }} />
                <div>
                  <div style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: 1 }}>ROW</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: ACCENT_COLOR }}>{leak.row}</div>
                </div>
                <div>
                  <div style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: 1 }}>COL</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: ACCENT_COLOR }}>{leak.col}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3D Sensor Chart */}
      <div style={{ padding: "14px 12px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--text-dim)" }}>3D SENSOR MAP</div>
          <button
            onClick={() => setUseRelative((r) => !r)}
            style={{
              fontSize: 9, letterSpacing: 1, fontFamily: "var(--mono)",
              padding: "2px 7px", borderRadius: 4,
              border: `1px solid ${useRelative ? "#00e5ff60" : "var(--border)"}`,
              background: useRelative ? "#00e5ff15" : "transparent",
              color: useRelative ? "#00e5ff" : "var(--text-dim)", cursor: "pointer",
            }}
          >{useRelative ? "REL" : "ABS"}</button>
        </div>
        <SensorChart3D simState={simState} useRelative={useRelative} />
        <div style={{ fontSize: 9, color: "var(--text-dim)", textAlign: "center", marginTop: 4 }}>
          {useRelative ? "scaled to highest reading" : "scaled to absolute max (100%)"}
        </div>
      </div>

      {/* Sensor list — collapsible */}
      <div style={{ flex: 1 }}>
        <button
          onClick={() => setSensorsExpanded((e) => !e)}
          style={{
            width: "100%", padding: "11px 16px",
            background: "transparent", border: "none",
            borderBottom: sensorsExpanded ? "1px solid var(--border)" : "none",
            cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center",
          }}
        >
          <span style={{ fontSize: 10, letterSpacing: 2, color: "var(--text-dim)" }}>
            SENSORS ({sensors.length})
          </span>
          <span style={{ fontSize: 12, color: "var(--text-dim)", transition: "transform 0.2s", display: "inline-block", transform: sensorsExpanded ? "rotate(0deg)" : "rotate(-90deg)" }}>▼</span>
        </button>

        {sensorsExpanded && (
          <div style={{ padding: "10px 16px 14px" }}>
            {sensors.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>No sensors placed</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {sensors.map((s, i) => {
                  const conc = grid[s.row * dimensions.cols + s.col];
                  return (
                    <div key={s.id} style={{
                      background: "var(--bg)",
                      border: `1px solid ${conc > 0.01 ? `${SENSOR_COLOR}40` : "var(--border)"}`,
                      borderRadius: 6, padding: "9px 11px",
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                        <span style={{ fontSize: 10, color: SENSOR_COLOR, fontFamily: "var(--mono)" }}>
                          S{String(i + 1).padStart(2, "0")}
                        </span>
                        <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>
                          {s.row},{s.col}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Bar value={conc} color={SENSOR_COLOR} />
                        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text)", minWidth: 36, textAlign: "right" }}>
                          {(conc * 100).toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

