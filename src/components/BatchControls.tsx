/**
 * BatchControls.tsx
 * Batch generation UI — progress bar, row counter, start/stop.
 * Rendered inside ControlPanel below the RANDOM button.
 *
 * Props are passed down from App.tsx which owns the worker lifecycle.
 */

interface Props {
  isGenerating: boolean;
  rowsGenerated: number;
  targetRows: number;
  layoutsGenerated: number;
  onStart: () => void;
  onStop: () => void;
  onTargetChange: (n: number) => void;
}

const COLOR = "#00e5ff";
const TARGETS = [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export default function BatchControls({
  isGenerating, rowsGenerated, targetRows, layoutsGenerated,
  onStart, onStop, onTargetChange,
}: Props) {
  const pct = targetRows > 0 ? Math.min(1, rowsGenerated / targetRows) : 0;

  return (
    <div style={{
      padding: "12px 12px 14px",
      borderBottom: "1px solid var(--border)",
    }}>
      <div style={{
        fontSize: 10, letterSpacing: 2,
        color: "var(--text-dim)", marginBottom: 8, paddingLeft: 4,
      }}>
        BATCH GENERATE
      </div>

      {/* Target row selector */}
      <div style={{ marginBottom: 8 }}>
        <div style={{
          fontSize: 9, letterSpacing: 1,
          color: "var(--text-dim)", marginBottom: 4,
        }}>
          TARGET ROWS
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {TARGETS.map(t => (
            <button
              key={t}
              onClick={() => onTargetChange(t)}
              disabled={isGenerating}
              style={{
                padding: "3px 7px", borderRadius: 4, fontSize: 10,
                fontFamily: "var(--mono)", cursor: isGenerating ? "not-allowed" : "pointer",
                border: `1px solid ${targetRows === t ? COLOR + "80" : "var(--border)"}`,
                background: targetRows === t ? COLOR + "18" : "transparent",
                color: targetRows === t ? COLOR : "var(--text-dim)",
                opacity: isGenerating ? 0.5 : 1,
              }}
            >
              {fmt(t)}
            </button>
          ))}
        </div>
      </div>

      {/* Progress bar — visible once started */}
      {(isGenerating || rowsGenerated > 0) && (
        <div style={{ marginBottom: 8 }}>
          <div style={{
            height: 4, borderRadius: 2,
            background: "var(--border)", overflow: "hidden",
          }}>
            <div style={{
              height: "100%", borderRadius: 2,
              width: `${pct * 100}%`,
              background: isGenerating
                ? `linear-gradient(90deg, ${COLOR}, #a855f7)`
                : "#3dba6e",
              transition: "width 0.3s ease",
            }} />
          </div>
          <div style={{
            display: "flex", justifyContent: "space-between",
            marginTop: 4, fontSize: 9,
            fontFamily: "var(--mono)", color: "var(--text-dim)",
          }}>
            <span>{fmt(rowsGenerated)} / {fmt(targetRows)} rows</span>
            <span>{layoutsGenerated} layouts</span>
          </div>
        </div>
      )}

      {/* Start / Stop */}
      <button
        onClick={isGenerating ? onStop : onStart}
        style={{
          width: "100%", padding: "9px 12px", borderRadius: 6,
          border: isGenerating ? "1px solid #ff4b6e60" : `1px solid ${COLOR}60`,
          background: isGenerating ? "#ff4b6e18" : `${COLOR}18`,
          color: isGenerating ? "#ff4b6e" : COLOR,
          cursor: "pointer", fontSize: 13,
          fontFamily: "var(--mono)", letterSpacing: 1,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        }}
      >
        <span style={{ fontSize: 11 }}>{isGenerating ? "■" : "▶"}</span>
        {isGenerating ? "STOP" : "GENERATE"}
      </button>
    </div>
  );
}
