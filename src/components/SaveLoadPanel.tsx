import { useRef } from "react";
import type { SimulationState, LayoutSnapshot } from "../engine/types";
import type { LoadTarget } from "../utils/layout";
import { downloadLayout, parseLayoutFile } from "../utils/layout";

interface Props {
  simState: SimulationState;
  onLoad: (snapshot: LayoutSnapshot, target: LoadTarget) => void;
}

const LOAD_TARGETS: { value: LoadTarget; label: string }[] = [
  { value: "all",     label: "All" },
  { value: "sensors", label: "Sensors only" },
  { value: "walls",   label: "Walls only" },
  { value: "doors",   label: "Doors only" },
];

export default function SaveLoadPanel({ simState, onLoad }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const targetRef = useRef<LoadTarget>("all");

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const snapshot = await parseLayoutFile(file);
      onLoad(snapshot, targetRef.current);
    } catch {
      alert("Invalid layout file.");
    }
    e.target.value = "";
  };

  const btnStyle = (color = "var(--accent)"): React.CSSProperties => ({
    padding: "8px 10px",
    borderRadius: 5,
    border: `1px solid ${color}40`,
    background: `${color}12`,
    color,
    cursor: "pointer",
    fontSize: 11,
    fontFamily: "var(--mono)",
    letterSpacing: 1,
    width: "100%",
    textAlign: "center" as const,
  });

  return (
    <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ fontSize: 10, letterSpacing: 2, color: "var(--text-dim)", marginBottom: 12 }}>
        SAVE / LOAD
      </div>

      {/* Save */}
      <button style={btnStyle("#00e5ff")} onClick={() => downloadLayout(simState)}>
        SAVE LAYOUT
      </button>

      {/* Load target selector */}
      <div style={{ display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" }}>
        {LOAD_TARGETS.map(({ value, label }) => (
          <button
            key={value}
            style={{
              padding: "5px 8px",
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 10,
              fontFamily: "var(--mono)",
              flex: "1 1 40%",
            }}
            onClick={() => {
              targetRef.current = value;
              fileRef.current?.click();
            }}
          >
            LOAD {label.toUpperCase()}
          </button>
        ))}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".json"
        style={{ display: "none" }}
        onChange={handleFile}
      />
    </div>
  );
}
