import { useRef, useCallback } from "react";
import type { SimParams } from "../engine/types";

interface Props {
  params: SimParams;
  showShadow: boolean;
  onShowShadowToggle: () => void;
  onChange: (p: SimParams) => void;
}

function Slider({ label, value, min, max, step, fmt, onChange }: {
  label: string; value: number; min: number; max: number;
  step: number; fmt: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)" }}>{fmt(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ accentColor: "var(--accent)" }} />
    </div>
  );
}

function WindJoystick({ windX, windY, onChange }: {
  windX: number; windY: number;
  onChange: (x: number, y: number) => void;
}) {
  const padRef = useRef<HTMLDivElement>(null);
  const SIZE = 104;
  const R = SIZE / 2;

  const getVel = useCallback((e: MouseEvent | React.MouseEvent) => {
    const rect = padRef.current!.getBoundingClientRect();
    const dx = Math.max(-R, Math.min(R, e.clientX - rect.left - R));
    const dy = Math.max(-R, Math.min(R, e.clientY - rect.top  - R));
    return {
      x: parseFloat((dx / R * 0.9).toFixed(2)),
      y: parseFloat((dy / R * 0.9).toFixed(2)),
    };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = getVel(e);
    onChange(x, y);
    const onMove = (ev: MouseEvent) => { const v = getVel(ev); onChange(v.x, v.y); };
    const onUp   = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup",   onUp);
  }, [getVel, onChange]);

  const active = windX !== 0 || windY !== 0;
  const dotX = (windX / 0.9) * R;
  const dotY = (windY / 0.9) * R;

  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--text-dim)", marginBottom: 8 }}>WIND</div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
        <span style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>↑ N</span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>W ←</span>
          <div ref={padRef} onMouseDown={handleMouseDown} onDoubleClick={() => onChange(0, 0)}
            title="Drag to set wind · Double-click to calm"
            style={{
              width: SIZE, height: SIZE, borderRadius: "50%", position: "relative",
              border: "1px solid var(--border)", background: "var(--bg)",
              cursor: "crosshair", flexShrink: 0,
              boxShadow: active ? "0 0 10px rgba(0,229,255,0.12)" : "none",
            }}>
            <div style={{ position:"absolute", left:"50%", top:0, bottom:0, width:1,
              background:"rgba(255,255,255,0.04)", transform:"translateX(-50%)" }}/>
            <div style={{ position:"absolute", top:"50%", left:0, right:0, height:1,
              background:"rgba(255,255,255,0.04)", transform:"translateY(-50%)" }}/>
            {/* Wind direction arrow */}
            {active && (() => {
              const len = Math.hypot(dotX, dotY);
              const nx = dotX / len, ny = dotY / len;
              const x1 = R, y1 = R;
              const x2 = R + dotX, y2 = R + dotY;
              const ax = x2 - nx * 6 - ny * 4, ay = y2 - ny * 6 + nx * 4;
              const bx = x2 - nx * 6 + ny * 4, by = y2 - ny * 6 - nx * 4;
              return (
                <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none" }}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--accent)" strokeWidth="1.5" strokeOpacity="0.5"/>
                  <polygon points={`${x2},${y2} ${ax},${ay} ${bx},${by}`} fill="var(--accent)" fillOpacity="0.7"/>
                </svg>
              );
            })()}
            <div style={{
              position:"absolute", left: R + dotX - 5, top: R + dotY - 5,
              width: 10, height: 10, borderRadius: "50%",
              background: active ? "var(--accent)" : "var(--text-dim)",
              boxShadow: active ? "0 0 6px var(--accent)" : "none",
              pointerEvents: "none",
            }}/>
          </div>
          <span style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>→ E</span>
        </div>
        <span style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>S ↓</span>
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          {[{ label: "X →", v: windX }, { label: "Y ↓", v: windY }].map(({ label, v }) => (
            <div key={label} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 9, color: "var(--text-dim)" }}>{label}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)" }}>
                {(v >= 0 ? "+" : "") + v.toFixed(2)}
              </div>
            </div>
          ))}
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 9, color: "var(--text-dim)" }}>calm</div>
            <button onClick={() => onChange(0, 0)}
              style={{ fontFamily:"var(--mono)", fontSize:10, color:"var(--text-dim)",
                background:"none", border:"1px solid var(--border)", borderRadius:3,
                cursor:"pointer", padding:"1px 5px" }}>✕</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ParamsPanel({ params, showShadow, onShowShadowToggle, onChange }: Props) {
  return (
    <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--text-dim)", marginBottom: 10 }}>
        PARAMETERS
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
        <Slider label="Diffusion Rate" value={params.diffusionRate}
          min={0.005} max={0.124} step={0.005} fmt={(v) => v.toFixed(3)}
          onChange={(v) => onChange({ ...params, diffusionRate: v })} />
        <Slider label="Ventilation" value={params.decayFactor}
          min={0.90} max={0.999} step={0.001} fmt={(v) => v.toFixed(3)}
          onChange={(v) => onChange({ ...params, decayFactor: v })} />
        <Slider label="Leak Rate" value={params.leakInjection}
          min={0.5} max={20} step={0.5} fmt={(v) => v.toFixed(1)}
          onChange={(v) => onChange({ ...params, leakInjection: v })} />
        <Slider label="Tick Interval" value={params.tickMs}
          min={16} max={200} step={4} fmt={(v) => `${v}ms`}
          onChange={(v) => onChange({ ...params, tickMs: v })} />
      </div>
      <WindJoystick windX={params.windX} windY={params.windY}
        onChange={(x, y) => onChange({ ...params, windX: x, windY: y })} />
      {/* Shadow overlay toggle */}
      <button onClick={onShowShadowToggle}
        style={{
          marginTop: 12, width: "100%", padding: "6px 0",
          border: `1px solid ${showShadow ? "var(--accent)" : "var(--border)"}`,
          borderRadius: 4, background: showShadow ? "rgba(0,229,255,0.07)" : "transparent",
          color: showShadow ? "var(--accent)" : "var(--text-dim)",
          fontFamily: "var(--mono)", fontSize: 11, cursor: "pointer", letterSpacing: 1,
        }}>
        {showShadow ? "◉ HIDE WIND SHADOW" : "◎ SHOW WIND SHADOW"}
      </button>
    </div>
  );
}
