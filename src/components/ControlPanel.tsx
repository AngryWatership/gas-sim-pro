import { type ReactNode, useState, useCallback } from "react";
import type { ToolMode, SimParams, SimulationState, LayoutSnapshot } from "../engine/types";
import type { LoadTarget } from "../utils/layout";
import type { GeneratorConfig } from "../utils/generatorConfig";
import { defaultConfig } from "../utils/generatorConfig";
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
  onRandomise: () => void;
  onConfigChange?: (cfg: GeneratorConfig) => void;
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

// ── Range row: label + slider + current value ─────────────────────────────
function RangeRow({
  label, min, max, value, onChange, color, disabled,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  color: string;
  disabled: boolean;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      opacity: disabled ? 0.35 : 1,
      pointerEvents: disabled ? "none" : "auto",
    }}>
      <span style={{ fontSize: 10, color: "var(--text-dim)", width: 28, flexShrink: 0 }}>{label}</span>
      <input
        type="range" min={min} max={max} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: color, cursor: "pointer" }}
      />
      <span style={{
        fontSize: 10, fontFamily: "var(--mono)", color,
        width: 22, textAlign: "right", flexShrink: 0,
      }}>{value}</span>
    </div>
  );
}

// ── Toggle row: dimension checkbox + label ────────────────────────────────
function DimToggle({
  label, checked, onChange, color,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  color: string;
}) {
  return (
    <label style={{
      display: "flex", alignItems: "center", gap: 7,
      cursor: "pointer", userSelect: "none",
      fontSize: 11, color: checked ? color : "var(--text-dim)",
      transition: "color 0.15s",
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ accentColor: color, cursor: "pointer", width: 12, height: 12 }}
      />
      {label}
    </label>
  );
}

// ── Generator config panel ────────────────────────────────────────────────
function GeneratorConfigPanel({
  config, onChange,
}: {
  config: GeneratorConfig;
  onChange: (cfg: GeneratorConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const accent = "#a855f7";
  const set = useCallback(
    (patch: Partial<GeneratorConfig>) => onChange({ ...config, ...patch }),
    [config, onChange],
  );

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      {/* Collapsible header */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%", padding: "11px 12px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "transparent", border: "none",
          cursor: "pointer", color: "var(--text-dim)",
          fontSize: 10, letterSpacing: 2, fontFamily: "var(--mono)",
        }}
      >
        <span>GENERATOR CONFIG</span>
        <span style={{
          fontSize: 9, color: accent,
          transform: open ? "rotate(180deg)" : "rotate(0deg)",
          transition: "transform 0.2s",
          display: "inline-block",
        }}>▼</span>
      </button>

      {open && (
        <div style={{ padding: "0 12px 14px", display: "flex", flexDirection: "column", gap: 12 }}>

          {/* Walls */}
          <div>
            <DimToggle
              label="Randomise walls"
              checked={config.randomiseWalls}
              onChange={v => set({ randomiseWalls: v })}
              color={accent}
            />
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              <RangeRow label="min" min={1} max={config.wallCountMax} value={config.wallCountMin}
                onChange={v => set({ wallCountMin: v })} color={accent} disabled={!config.randomiseWalls} />
              <RangeRow label="max" min={config.wallCountMin} max={10} value={config.wallCountMax}
                onChange={v => set({ wallCountMax: v })} color={accent} disabled={!config.randomiseWalls} />
              <RangeRow label="len" min={5} max={config.wallLengthMax} value={config.wallLengthMin}
                onChange={v => set({ wallLengthMin: v })} color={accent} disabled={!config.randomiseWalls} />
              <RangeRow label="len↑" min={config.wallLengthMin} max={80} value={config.wallLengthMax}
                onChange={v => set({ wallLengthMax: v })} color={accent} disabled={!config.randomiseWalls} />
            </div>
          </div>

          <div style={{ height: 1, background: "var(--border)" }} />

          {/* Doors */}
          <div>
            <DimToggle
              label="Randomise doors"
              checked={config.randomiseDoors}
              onChange={v => set({ randomiseDoors: v })}
              color="#3fa8d8"
            />
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              <RangeRow label="min" min={0} max={config.doorCountMax} value={config.doorCountMin}
                onChange={v => set({ doorCountMin: v })} color="#3fa8d8" disabled={!config.randomiseDoors} />
              <RangeRow label="max" min={config.doorCountMin} max={8} value={config.doorCountMax}
                onChange={v => set({ doorCountMax: v })} color="#3fa8d8" disabled={!config.randomiseDoors} />
              <RangeRow label="w↑" min={1} max={12} value={config.doorWidthMax}
                onChange={v => set({ doorWidthMax: v })} color="#3fa8d8" disabled={!config.randomiseDoors} />
            </div>
          </div>

          <div style={{ height: 1, background: "var(--border)" }} />

          {/* Leaks */}
          <div>
            <DimToggle
              label="Randomise leaks"
              checked={config.randomiseLeaks}
              onChange={v => set({ randomiseLeaks: v })}
              color="#ff4b6e"
            />
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              <RangeRow label="min" min={1} max={config.leakCountMax} value={config.leakCountMin}
                onChange={v => set({ leakCountMin: v })} color="#ff4b6e" disabled={!config.randomiseLeaks} />
              <RangeRow label="max" min={config.leakCountMin} max={10} value={config.leakCountMax}
                onChange={v => set({ leakCountMax: v })} color="#ff4b6e" disabled={!config.randomiseLeaks} />
            </div>
          </div>

          <div style={{ height: 1, background: "var(--border)" }} />

          {/* Sensors */}
          <div>
            <DimToggle
              label="Randomise sensors"
              checked={config.randomiseSensors}
              onChange={v => set({ randomiseSensors: v })}
              color="#ffdd00"
            />
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              <RangeRow label="min" min={1} max={config.sensorCountMax} value={config.sensorCountMin}
                onChange={v => set({ sensorCountMin: v })} color="#ffdd00" disabled={!config.randomiseSensors} />
              <RangeRow label="max" min={config.sensorCountMin} max={40} value={config.sensorCountMax}
                onChange={v => set({ sensorCountMax: v })} color="#ffdd00" disabled={!config.randomiseSensors} />
            </div>
          </div>

          <div style={{ height: 1, background: "var(--border)" }} />

          {/* Physics */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <DimToggle label="Randomise wind"      checked={config.randomiseWind}      onChange={v => set({ randomiseWind: v })}      color="#2ecc71" />
            <DimToggle label="Randomise diffusion" checked={config.randomiseDiffusion} onChange={v => set({ randomiseDiffusion: v })} color="#2ecc71" />
            <DimToggle label="Randomise decay"     checked={config.randomiseDecay}     onChange={v => set({ randomiseDecay: v })}     color="#2ecc71" />
            <DimToggle label="Randomise injection" checked={config.randomiseInjection} onChange={v => set({ randomiseInjection: v })} color="#2ecc71" />
          </div>

          <div style={{ height: 1, background: "var(--border)" }} />

          {/* Recording */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10, letterSpacing: 1, color: "var(--text-dim)" }}>RECORDING</span>
            <RangeRow label="warm" min={50} max={500} value={config.warmUpTicks}
              onChange={v => set({ warmUpTicks: v })} color="#888" disabled={false} />
            <RangeRow label="rec" min={10} max={300} value={config.recordTicks}
              onChange={v => set({ recordTicks: v })} color="#888" disabled={false} />
            <RangeRow label="÷" min={1} max={20} value={config.recordEvery}
              onChange={v => set({ recordEvery: v })} color="#888" disabled={false} />
          </div>

          {/* Reset to defaults */}
          <button
            onClick={() => onChange(defaultConfig)}
            style={{
              padding: "6px 0", borderRadius: 4,
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-dim)", cursor: "pointer",
              fontSize: 10, fontFamily: "var(--mono)", letterSpacing: 1,
            }}
          >
            RESET TO DEFAULTS
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────
export default function ControlPanel({
  tool, running, lightMode, params, simState,
  showShadow, eraserSize, onEraserSizeChange,
  onShowShadowToggle, onToolChange, onToggle, onReset,
  onLightModeToggle, onParamsChange, onLoad, onRandomise,
  onConfigChange,
}: Props) {
  const eraserColor = "#a0a0c0";
  const [genConfig, setGenConfig] = useState<GeneratorConfig>(defaultConfig);

  const handleConfigChange = useCallback((cfg: GeneratorConfig) => {
    setGenConfig(cfg);
    onConfigChange?.(cfg);
  }, [onConfigChange]);

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
            onClick={onRandomise}
            title="Generate a random layout (resets current grid)"
            style={{
              padding: "9px 12px", borderRadius: 6,
              border: "1px solid #a855f740",
              background: "#a855f715",
              color: "#c084fc",
              cursor: "pointer", fontSize: 13,
              fontFamily: "var(--mono)", letterSpacing: 1,
              display: "flex", alignItems: "center", gap: 8,
            }}
          >
            <span style={{ fontSize: 15 }}>⚄</span> RANDOM
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

      {/* Batch controls slot — rendered from App.tsx */}
      {children}

      {/* Generator config — collapsible */}
      <GeneratorConfigPanel config={genConfig} onChange={handleConfigChange} />

      {/* Parameters */}
      <ParamsPanel params={params} showShadow={showShadow} onShowShadowToggle={onShowShadowToggle} onChange={onParamsChange} />

      {/* Save / Load */}
      <SaveLoadPanel simState={simState} onLoad={onLoad} />
    </aside>
  );
}
