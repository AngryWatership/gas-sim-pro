import { type ReactNode } from "react";
import type { ToolMode, SimParams, SimulationState, LayoutSnapshot } from "../engine/types";
import type { LoadTarget } from "../utils/layout";
import ParamsPanel from "./ParamsPanel";
import SaveLoadPanel from "./SaveLoadPanel";

export interface EraserSize { w: number; h: number; }

interface Props {
  tool: ToolMode;
  running: boolean;
  lightMode: boolean;
  params: SimParams;
  simState: SimulationState;
  showShadow: boolean;
  eraserSize: EraserSize;
  onEraserSizeChange: (s: EraserSize) => void;
  onShowShadowToggle: () => void;
  onToolChange: (t: ToolMode) => void;
  onToggle: () => void;
  onReset: () => void;
  onLightModeToggle: () => void;
  onParamsChange: (p: SimParams) => void;
  onLoad: (snapshot: LayoutSnapshot, target: LoadTarget) => void;
}

interface ToolBtn {
  mode: ToolMode;
  label: string;
  icon: ReactNode;
  color: string;
  description: string;
}

const tools: ToolBtn[] = [
  {
    mode: "gas_leak",
    label: "Leak Source",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
        <circle cx="12" cy="12" r="4" fill="currentColor" opacity="0.3"/>
        <circle cx="12" cy="12" r="9"/>
        <line x1="12" y1="3" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="21"/>
        <line x1="3" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="21" y2="12"/>
      </svg>
    ),
    color: "#ff4b6e",
    description: "Click to place leak sources (multiple allowed)",
  },
  {
    mode: "sensor",
    label: "Sensor",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
        <polygon points="12,2 15,9 22,9 16,14 18,21 12,17 6,21 8,14 2,9 9,9" fill="currentColor" opacity="0.3"/>
        <polygon points="12,2 15,9 22,9 16,14 18,21 12,17 6,21 8,14 2,9 9,9"/>
      </svg>
    ),
    color: "#ffdd00",
    description: "Place detection sensors",
  },
  {
    mode: "wall",
    label: "Wall",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
        <rect x="3" y="6" width="18" height="4" fill="currentColor" opacity="0.3"/>
        <rect x="3" y="6" width="18" height="4"/>
        <rect x="3" y="14" width="18" height="4" fill="currentColor" opacity="0.3"/>
        <rect x="3" y="14" width="18" height="4"/>
      </svg>
    ),
    color: "#e8a040",
    description: "Drag to draw. Shift+drag = straight line",
  },
  {
    mode: "door",
    label: "Door",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
        <rect x="3" y="2" width="13" height="20" rx="1" fill="currentColor" opacity="0.3"/>
        <rect x="3" y="2" width="13" height="20" rx="1"/>
        <circle cx="14" cy="12" r="1" fill="currentColor"/>
      </svg>
    ),
    color: "#2ecc71",
    description: "Click near walls to open passages",
  },
  {
    mode: "eraser",
    label: "Eraser",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
        <path d="M20 20H7L3 16l10-10 7 7-3.5 3.5"/>
        <path d="M6.07 7.07 3 10l4 4"/>
      </svg>
    ),
    color: "#a0a0c0",
    description: "Drag to erase walls, doors, leaks, sensors",
  },
];

const DEFAULT_ERASER: EraserSize = { w: 1, h: 1 };
const MAX_ERASER = 20;
const MIN_ERASER = 1;

function Stepper({
  label, value, onChange, color,
}: { label: string; value: number; onChange: (v: number) => void; color: string }) {
  const btnStyle: React.CSSProperties = {
    width: 20, height: 20, borderRadius: 4,
    border: `1px solid ${color}50`,
    background: `${color}18`,
    color,
    cursor: "pointer", fontSize: 13, lineHeight: 1,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "var(--mono)", flexShrink: 0,
    padding: 0,
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
      <span style={{ fontSize: 9, letterSpacing: 1, color: "var(--text-dim)" }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button style={btnStyle} onClick={() => onChange(Math.max(MIN_ERASER, value - 1))}>−</button>
        <input
          type="number"
          min={MIN_ERASER}
          max={MAX_ERASER}
          value={value}
          onChange={(e) => {
            const v = Math.round(Number(e.target.value));
            if (!isNaN(v)) onChange(Math.max(MIN_ERASER, Math.min(MAX_ERASER, v)));
          }}
          style={{
            width: 32, height: 20, textAlign: "center",
            fontFamily: "var(--mono)", fontSize: 12,
            background: "var(--bg)", color: "var(--text)",
            border: `1px solid ${color}40`, borderRadius: 4,
            outline: "none",
            MozAppearance: "textfield",
          } as React.CSSProperties}
        />
        <button style={btnStyle} onClick={() => onChange(Math.min(MAX_ERASER, value + 1))}>+</button>
      </div>
    </div>
  );
}

export default function ControlPanel({
  tool, running, lightMode, params, simState,
  showShadow, eraserSize, onEraserSizeChange,
  onShowShadowToggle, onToolChange, onToggle, onReset,
  onLightModeToggle, onParamsChange, onLoad,
}: Props) {
  const eraserColor = "#a0a0c0";

  return (
    <aside style={{
      width: 220, minWidth: 220,
      background: "var(--surface)",
      borderRight: "1px solid var(--border)",
      display: "flex", flexDirection: "column",
      fontFamily: "var(--sans)", overflowY: "auto",
    }}>
      {/* Header */}
      <div style={{ padding: "18px 18px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", letterSpacing: 3, marginBottom: 4 }}>
          GAS·SIM·PRO
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", fontWeight: 300 }}>
          Diffusion Simulator v2
        </div>
      </div>

      {/* Tools */}
      <div style={{ padding: "14px 12px 10px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--text-dim)", marginBottom: 8, paddingLeft: 4 }}>
          TOOLS
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {tools.map((t) => (
            <button
              key={t.mode}
              onClick={() => onToolChange(tool === t.mode ? "none" : t.mode)}
              title={t.description}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 10px", borderRadius: 6,
                border: tool === t.mode ? `1px solid ${t.color}40` : "1px solid transparent",
                background: tool === t.mode ? `${t.color}15` : "transparent",
                color: tool === t.mode ? t.color : "var(--text-dim)",
                cursor: "pointer", fontSize: 13, fontFamily: "var(--sans)",
                fontWeight: 400, transition: "all 0.15s ease", textAlign: "left",
              }}
            >
              <span style={{ color: tool === t.mode ? t.color : "var(--text-dim)" }}>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        {/* Eraser size controls — shown only when eraser is active */}
        {tool === "eraser" && (
          <div style={{
            marginTop: 8, padding: "10px 10px 10px",
            background: `${eraserColor}0d`,
            border: `1px solid ${eraserColor}30`,
            borderRadius: 6,
          }}>
            <div style={{ fontSize: 9, letterSpacing: 1, color: eraserColor, marginBottom: 8, textAlign: "center" }}>
              ERASER SIZE — {eraserSize.w}×{eraserSize.h} cells
            </div>
            <div style={{ display: "flex", justifyContent: "space-around", marginBottom: 8 }}>
              <Stepper
                label="WIDTH"
                value={eraserSize.w}
                onChange={(w) => onEraserSizeChange({ ...eraserSize, w })}
                color={eraserColor}
              />
              <Stepper
                label="HEIGHT"
                value={eraserSize.h}
                onChange={(h) => onEraserSizeChange({ ...eraserSize, h })}
                color={eraserColor}
              />
            </div>
            <button
              onClick={() => onEraserSizeChange(DEFAULT_ERASER)}
              style={{
                width: "100%", padding: "5px 0", borderRadius: 4,
                border: `1px solid ${eraserColor}40`,
                background: "transparent",
                color: eraserColor, cursor: "pointer",
                fontSize: 10, fontFamily: "var(--mono)", letterSpacing: 1,
              }}
            >
              RESET 1×1
            </button>
          </div>
        )}
      </div>

      {/* Simulation controls */}
      <div style={{ padding: "14px 12px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--text-dim)", marginBottom: 8, paddingLeft: 4 }}>
          SIMULATION
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <button
            onClick={onToggle}
            style={{
              padding: "9px 12px", borderRadius: 6,
              border: running ? "1px solid #ff4b6e60" : "1px solid #00e5ff60",
              background: running ? "#ff4b6e18" : "#00e5ff18",
              color: running ? "#ff4b6e" : "#00e5ff",
              cursor: "pointer", fontSize: 13, fontFamily: "var(--mono)", letterSpacing: 1,
              display: "flex", alignItems: "center", gap: 8,
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: running ? "#ff4b6e" : "#00e5ff",
              boxShadow: running ? "0 0 8px #ff4b6e" : "0 0 8px #00e5ff",
              animation: running ? "pulse 1s infinite" : "none", flexShrink: 0,
            }}/>
            {running ? "STOP" : "START"}
          </button>
          <button
            onClick={onReset}
            style={{
              padding: "9px 12px", borderRadius: 6,
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-dim)", cursor: "pointer", fontSize: 13,
              fontFamily: "var(--mono)", letterSpacing: 1,
            }}
          >
            RESET
          </button>
          <button
            onClick={onLightModeToggle}
            style={{
              padding: "9px 12px", borderRadius: 6,
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-dim)", cursor: "pointer", fontSize: 12,
              fontFamily: "var(--mono)", letterSpacing: 1,
            }}
          >
            {lightMode ? "◐ DARK MODE" : "◑ LIGHT MODE"}
          </button>
        </div>
      </div>

      {/* Parameters */}
      <ParamsPanel params={params} showShadow={showShadow} onShowShadowToggle={onShowShadowToggle} onChange={onParamsChange} />

      {/* Save / Load */}
      <SaveLoadPanel simState={simState} onLoad={onLoad} />
    </aside>
  );
}

