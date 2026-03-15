import { useState, useCallback } from "react";
import ControlPanel from "./components/ControlPanel";
import type { EraserSize } from "./components/ControlPanel";
import SensorStats from "./components/SensorStats";
import SimulationCanvas from "./components/SimulationCanvas";
import { useSimulation } from "./hooks/useSimulation";
import { generateRandomLayout } from "./utils/randomLayout";
import { defaultConfig } from "./utils/generatorConfig";
import type { GeneratorConfig } from "./utils/generatorConfig";

export default function App() {
  const {
    simState, windShadow,
    running, tool, setTool, estimation,
    params, setParams, lightMode, toggleLightMode,
    reset, toggleRunning, handleCellsInteract, handleLoad,
  } = useSimulation();

  const [showShadow, setShowShadow] = useState(false);
  const [eraserSize, setEraserSize] = useState<EraserSize>({ w: 1, h: 1 });
  const [genConfig, setGenConfig] = useState<GeneratorConfig>(defaultConfig);

  const handleRandomise = useCallback(() => {
    const { snapshot, params: rndParams } = generateRandomLayout(
      undefined,
      genConfig,
      {
        walls:   [...simState.blockedCells].reduce<number[]>((a, v, i) => (v ? [...a, i] : a), []),
        doors:   [...simState.doorCells].reduce<number[]>((a, v, i) => (v ? [...a, i] : a), []),
        leaks:   simState.gasLeaks ?? [],
        sensors: simState.sensors,
        params,
      },
    );
    reset();
    setTimeout(() => {
      handleLoad(snapshot, "all");
      setParams(rndParams);
    }, 0);
  }, [genConfig, simState, params, reset, handleLoad, setParams]);

  const toolHints: Partial<Record<typeof tool, string>> = {
    wall:     "DRAG to draw · SHIFT+DRAG = straight line",
    door:     "CLICK near walls to open passages (AoE)",
    sensor:   "CLICK to place sensors",
    gas_leak: "CLICK to place leak sources · multiple allowed",
    eraser:   `DRAG to erase · ${eraserSize.w}×${eraserSize.h} cell area`,
  };

  return (
    <div style={{ display: "flex", height: "100vh", width: "100vw", overflow: "hidden", background: "var(--bg)" }}>
      <ControlPanel
        tool={tool} running={running} lightMode={lightMode}
        params={params} simState={simState}
        showShadow={showShadow} onShowShadowToggle={() => setShowShadow((s) => !s)}
        eraserSize={eraserSize} onEraserSizeChange={setEraserSize}
        onToolChange={setTool} onToggle={toggleRunning} onReset={reset}
        onLightModeToggle={toggleLightMode} onParamsChange={setParams} onLoad={handleLoad}
        onRandomise={handleRandomise}
        onConfigChange={setGenConfig}
      />

      <main style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
        background: lightMode ? "#e8eaf0" : "var(--bg)",
        position: "relative", overflow: "hidden",
        transition: "background 0.3s ease",
      }}>
        {["0,0", "99,99"].map((label, i) => (
          <div key={label} style={{
            position: "absolute",
            ...(i === 0 ? { top: 12, left: 12 } : { bottom: 12, right: 12 }),
            fontFamily: "var(--mono)", fontSize: 10,
            color: lightMode ? "#aaa" : "var(--text-dim)",
            letterSpacing: 1, pointerEvents: "none",
          }}>{label}</div>
        ))}

        {tool !== "none" && toolHints[tool] && (
          <div style={{
            position: "absolute", bottom: 14, left: "50%", transform: "translateX(-50%)",
            fontFamily: "var(--mono)", fontSize: 11,
            color: lightMode ? "#555" : "var(--accent)",
            background: lightMode ? "#fff" : "var(--surface)",
            border: `1px solid ${lightMode ? "#ddd" : "var(--border)"}`,
            borderRadius: 4, padding: "4px 14px", letterSpacing: 1,
            pointerEvents: "none", whiteSpace: "nowrap",
          }}>{toolHints[tool]}</div>
        )}

        <div style={{
          width:  "min(calc(100vh - 40px), calc(100vw - 480px))",
          height: "min(calc(100vh - 40px), calc(100vw - 480px))",
          border: `1px solid ${lightMode ? "#ccc" : "var(--border)"}`,
          borderRadius: 4, overflow: "hidden",
          boxShadow: lightMode
            ? "0 2px 20px rgba(0,0,0,0.1)"
            : "0 0 40px rgba(0,229,255,0.03)",
        }}>
          <SimulationCanvas
            simState={simState} tool={tool} estimation={estimation}
            lightMode={lightMode} windShadow={windShadow} showShadow={showShadow}
            eraserSize={eraserSize}
            onCellsInteract={handleCellsInteract}
          />
        </div>
      </main>

      <SensorStats simState={simState} estimation={estimation} />
    </div>
  );
}
