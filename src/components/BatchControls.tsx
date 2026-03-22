/**
 * BatchControls.tsx
 * Batch generation UI — progress bar, row counter, start/stop, TRAIN button.
 * Rendered inside ControlPanel below the RANDOM button.
 */

import { useTrainButton } from "../hooks/useTrainButton";

interface Props {
  isGenerating:      boolean;
  rowsGenerated:     number;
  targetRows:        number;
  layoutsGenerated:  number;
  onStart:           () => void;
  onStop:            () => void;
  onTargetChange:    (n: number) => void;
}

const GEN_COLOR   = "#00e5ff";
const TRAIN_COLOR = "#a855f7";
const TARGETS     = [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export default function BatchControls({
  isGenerating, rowsGenerated, targetRows, layoutsGenerated,
  onStart, onStop, onTargetChange,
}: Props) {
  const pct   = targetRows > 0 ? Math.min(1, rowsGenerated / targetRows) : 0;
  const train = useTrainButton();

  // ── TRAIN button appearance ───────────────────────────────────────────
  const trainActive   = train.state === "active";
  const trainLoading  = train.state === "loading";
  const trainTraining = train.state === "training";
  const trainDeployed = train.state === "deployed";
  const trainRejected = train.state === "rejected";
  const trainError    = train.state === "error";
  const IS_DEV        = import.meta.env.VITE_IS_DEVELOPER === "true";

  const trainLabel = trainLoading  ? "⟳ TRAIN …"
                   : trainTraining ? (IS_DEV ? "⟳ TRAINING…" : "⟳ TRAIN")
                   : trainDeployed ? "✓ DEPLOYED"
                   : trainRejected ? "⚠ REJECTED"
                   : "⟳ TRAIN";

  const trainTitle = train.state === "no_registry"
    ? "Registry not configured — set VITE_GCS_REGISTRY_URL in .env.local"
    : train.state === "current"
      ? `Model is current · version ${train.modelVersion ?? "?"} · MAE ${train.lastMae?.toFixed(2) ?? "?"}`
      : train.state === "active"
        ? "New data available — click to open Colab and retrain"
      : train.state === "training"
        ? IS_DEV ? "Training in progress via GitHub Actions…" : "Model is current"
      : train.state === "deployed"
        ? `New model deployed · MAE ${train.lastMae?.toFixed(4) ?? "?"}`
      : train.state === "rejected"
        ? `Model not deployed — gate failed · MAE ${train.lastMae?.toFixed(4) ?? "?"} did not beat previous`
      : train.state === "error"
        ? `Gate or build failed — ${train.gateStatus ?? "check logs"}`
        : "Checking registry…";

  // Colour: purple=active, green=deployed, yellow=rejected/error, grey=all others
  const trainColor = trainActive   ? "var(--accent)"
                   : trainDeployed ? "#2ecc71"
                   : trainRejected ? "#ffb347"
                   : trainError    ? "#ffb347"
                   : "var(--text-dim)";

  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>

      {/* ── BATCH GENERATE ─────────────────────────────────────────────── */}
      <div style={{ padding: "12px 12px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{
          fontSize: 10, letterSpacing: 2,
          color: "var(--text-dim)", marginBottom: 8, paddingLeft: 4,
        }}>
          BATCH GENERATE
        </div>

        {/* Target row selector */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 9, letterSpacing: 1, color: "var(--text-dim)", marginBottom: 4 }}>
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
                  fontFamily: "var(--mono)",
                  cursor: isGenerating ? "not-allowed" : "pointer",
                  border: `1px solid ${targetRows === t ? GEN_COLOR + "80" : "var(--border)"}`,
                  background: targetRows === t ? GEN_COLOR + "18" : "transparent",
                  color: targetRows === t ? GEN_COLOR : "var(--text-dim)",
                  opacity: isGenerating ? 0.5 : 1,
                }}
              >
                {fmt(t)}
              </button>
            ))}
          </div>
        </div>

        {/* Progress bar */}
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
                  ? `linear-gradient(90deg, ${GEN_COLOR}, #a855f7)`
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

        {/* Generate / Stop */}
        <button
          onClick={isGenerating ? onStop : onStart}
          style={{
            width: "100%", padding: "9px 12px", borderRadius: 6,
            border: isGenerating
              ? "1px solid #ff4b6e60"
              : `1px solid ${GEN_COLOR}60`,
            background: isGenerating ? "#ff4b6e18" : `${GEN_COLOR}18`,
            color: isGenerating ? "#ff4b6e" : GEN_COLOR,
            cursor: "pointer", fontSize: 13,
            fontFamily: "var(--mono)", letterSpacing: 1,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}
        >
          <span style={{ fontSize: 11 }}>{isGenerating ? "■" : "▶"}</span>
          {isGenerating ? "STOP" : "GENERATE"}
        </button>
      </div>

      {/* ── TRAIN ──────────────────────────────────────────────────────── */}
      <div style={{ padding: "12px 12px 14px" }}>
        <div style={{
          fontSize: 10, letterSpacing: 2,
          color: "var(--text-dim)", marginBottom: 8, paddingLeft: 4,
        }}>
          MODEL
        </div>

        {/* Version + MAE — shown when registry is reachable */}
        {(train.modelVersion || train.lastMae !== null) && (
          <div style={{
            fontSize: 9, fontFamily: "var(--mono)",
            color: "var(--text-dim)", marginBottom: 6,
            display: "flex", justifyContent: "space-between",
          }}>
            <span>{train.modelVersion ?? "—"}</span>
            {train.lastMae !== null && (
              <span>MAE {train.lastMae.toFixed(2)}</span>
            )}
          </div>
        )}

        {/* Active state indicator dot */}
        {trainActive && (
          <div style={{
            fontSize: 9, color: TRAIN_COLOR,
            marginBottom: 6, display: "flex", alignItems: "center", gap: 5,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: TRAIN_COLOR,
              boxShadow: `0 0 6px ${TRAIN_COLOR}`,
              flexShrink: 0,
            }} />
            New data available
          </div>
        )}

        <button
          onClick={trainActive ? train.onTrain : undefined}
          disabled={!trainActive || trainLoading}
          title={trainTitle}
          style={{
            width: "100%", padding: "9px 12px", borderRadius: 6,
            border: trainActive
              ? `1px solid ${TRAIN_COLOR}60`
              : "1px solid var(--border)",
            background: trainActive ? `${TRAIN_COLOR}15` : "transparent",
            color: trainColor,
            cursor: trainActive ? "pointer" : "not-allowed",
            fontSize: 13, fontFamily: "var(--mono)", letterSpacing: 1,
            opacity: trainLoading ? 0.5 : 1,
            transition: "all 0.2s ease",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}
        >
          {trainLabel}
        </button>

        {/* Training indicator — visible to all users */}
        {trainTraining && (
          <div style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: 1, marginTop: 4, textAlign: "center" }}>
            {IS_DEV ? "⟳ training in progress" : "· updating ·"}
          </div>
        )}

        {/* Error indicator — developer only */}
        {trainError && IS_DEV && (
          <div style={{ fontSize: 9, color: "#ffb347", letterSpacing: 1, marginTop: 4, textAlign: "center" }}>
            ⚠ {train.gateStatus ?? "check actions"}
          </div>
        )}

        {/* No registry hint */}
        {train.state === "no_registry" && (
          <div style={{
            marginTop: 6, fontSize: 9,
            color: "var(--text-dim)", lineHeight: 1.4,
          }}>
            Set <code style={{ fontFamily: "var(--mono)" }}>VITE_GCS_REGISTRY_URL</code> in{" "}
            <code style={{ fontFamily: "var(--mono)" }}>.env.local</code> after ENV B is ready.
          </div>
        )}
      </div>
    </div>
  );
}
