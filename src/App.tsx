import { useState, useCallback, useRef } from "react";
import ControlPanel from "./components/ControlPanel";
import type { EraserSize } from "./components/ControlPanel";
import BatchControls from "./components/BatchControls";
import SensorStats from "./components/SensorStats";
import SimulationCanvas from "./components/SimulationCanvas";
import { useSimulation } from "./hooks/useSimulation";
import { generateRandomLayout } from "./utils/randomLayout";
import { defaultConfig } from "./utils/generatorConfig";
import type { GeneratorConfig } from "./utils/generatorConfig";

// ── NDJSON download helper ────────────────────────────────────────────────
function downloadNdjson(ndjson: string, configHash: string, batchIndex: number) {
  const ts   = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = `synthetic-${configHash}-${ts}-${batchIndex}.ndjson`;
  const blob = new Blob([ndjson], { type: "application/x-ndjson" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const {
    simState, windShadow,
    running, tool, setTool, estimation, inferenceStatus,
    params, setParams, lightMode, toggleLightMode,
    reset, toggleRunning, handleCellsInteract, handleLoad,
  } = useSimulation();

  const [showShadow,   setShowShadow]   = useState(false);
  const [eraserSize,   setEraserSize]   = useState<EraserSize>({ w: 1, h: 1 });
  const [genConfig,    setGenConfig]    = useState<GeneratorConfig>(defaultConfig);

  // ── Batch generation state ───────────────────────────────────────────────
  const [isGenerating,       setIsGenerating]       = useState(false);
  const [rowsGenerated,      setRowsGenerated]       = useState(0);
  const [targetRows,         setTargetRows]          = useState(50_000);
  const [layoutsGenerated,   setLayoutsGenerated]    = useState(0);
  const workerRef  = useRef<Worker | null>(null);
  const batchIndex = useRef(0);
  const configHash = useRef("xxxxxxxx");

  // ── RANDOM button ─────────────────────────────────────────────────────────
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

  // ── Batch generation ──────────────────────────────────────────────────────
  const handleStartGenerate = useCallback(() => {
    if (isGenerating) return;

    // Compute config_hash for filename — mirrors computeConfigHash in randomLayout
    const key = [
      genConfig.randomiseWalls     ? "W" : "w",
      genConfig.randomiseDoors     ? "D" : "d",
      genConfig.randomiseLeaks     ? "L" : "l",
      genConfig.randomiseSensors   ? "S" : "s",
      genConfig.randomiseWind      ? "N" : "n",
      genConfig.randomiseDiffusion ? "F" : "f",
      genConfig.randomiseDecay     ? "C" : "c",
      genConfig.randomiseInjection ? "I" : "i",
    ].join("");
    let h = 5381;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) + h) ^ key.charCodeAt(i);
      h = h >>> 0;
    }
    configHash.current = h.toString(16).padStart(6, "0").slice(0, 6);

    setRowsGenerated(0);
    setLayoutsGenerated(0);
    batchIndex.current = 0;
    setIsGenerating(true);

    const worker = new Worker(
      new URL("./workers/generator.worker.ts", import.meta.url),
      { type: "module" },
    );
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;

      if (msg.type === "progress") {
        setRowsGenerated(msg.rowsGenerated);
        setLayoutsGenerated(msg.layoutsGenerated);
      }

      if (msg.type === "flush") {
        setRowsGenerated(r => r + msg.rowCount);
        batchIndex.current++;
        downloadNdjson(msg.ndjson, configHash.current, batchIndex.current);
      }

      if (msg.type === "done") {
        setRowsGenerated(msg.totalRows);
        setLayoutsGenerated(msg.totalLayouts);
        setIsGenerating(false);
        worker.terminate();
        workerRef.current = null;
        // Store last export timestamp for TRAIN button logic
        localStorage.setItem("lastExportTimestamp", new Date().toISOString());
      }

      if (msg.type === "error") {
        console.error("Generator worker error:", msg.message);
        setIsGenerating(false);
        worker.terminate();
        workerRef.current = null;
      }
    };

    worker.postMessage({ type: "start", config: genConfig, targetRows });
  }, [isGenerating, genConfig, targetRows]);

  const handleStopGenerate = useCallback(() => {
    workerRef.current?.postMessage({ type: "stop" });
    setIsGenerating(false);
  }, []);

  // ── Tool hints ────────────────────────────────────────────────────────────
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
        showShadow={showShadow} onShowShadowToggle={() => setShowShadow(s => !s)}
        eraserSize={eraserSize} onEraserSizeChange={setEraserSize}
        onToolChange={setTool} onToggle={toggleRunning} onReset={reset}
        onLightModeToggle={toggleLightMode} onParamsChange={setParams} onLoad={handleLoad}
        onRandomise={handleRandomise}
        onConfigChange={setGenConfig}
      >
        {/* BatchControls rendered as a child so it slots into the sidebar */}
        <BatchControls
          isGenerating={isGenerating}
          rowsGenerated={rowsGenerated}
          targetRows={targetRows}
          layoutsGenerated={layoutsGenerated}
          onStart={handleStartGenerate}
          onStop={handleStopGenerate}
          onTargetChange={setTargetRows}
        />
      </ControlPanel>

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

        {/* Inference status indicator */}
        <div style={{
          position: "absolute", top: 14, right: 14,
          display: "flex", alignItems: "center", gap: 5,
          fontFamily: "var(--mono)", fontSize: 9,
          color: "var(--text-dim)", letterSpacing: 1,
          pointerEvents: "none",
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
            background: inferenceStatus === "online"       ? "#2ecc71"
                      : inferenceStatus === "offline"      ? "#ffb347"
                      : inferenceStatus === "loading"      ? "#00e5ff"
                      : "var(--text-dim)",
            boxShadow: inferenceStatus === "online" ? "0 0 6px #2ecc71" : "none",
          }}/>
          {inferenceStatus === "online"       ? "ML · online"
         : inferenceStatus === "offline"      ? "ML · offline · triangulation"
         : inferenceStatus === "loading"      ? "ML · connecting"
         : inferenceStatus === "unconfigured" ? "triangulation"
         : ""}
        </div>

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
