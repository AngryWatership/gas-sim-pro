/**
 * useTrainButton.ts
 * TRAIN button state — driven exclusively by GCS timestamps.
 * No localStorage. No browser state.
 *
 * States:
 *   purple   — last_data_upload > last_trained  (new data, no model yet)
 *   grey     — last_trained >= last_data_upload  (model current)
 *   spinning — training_status.txt = "running"   (developer sees spinner, client sees grey + "updating")
 *   error    — gate_status = failed_mae_gate      (developer only)
 *   loading  — initial fetch in progress
 *   no_registry — VITE_GCS_REGISTRY_URL not set
 */

import { useState, useEffect, useCallback, useRef } from "react";

const COLAB_URL =
  import.meta.env.VITE_COLAB_NOTEBOOK_URL ??
  "https://colab.research.google.com/github/AngryWatership/gas-sim-pro/blob/main/notebooks/train.ipynb";

const REGISTRY_URL: string | undefined = import.meta.env.VITE_GCS_REGISTRY_URL;
const IS_DEVELOPER = import.meta.env.VITE_IS_DEVELOPER === "true";
const POLL_MS = 60_000;

export type TrainButtonState =
  | "active"        // purple — new data, no trained model
  | "current"       // grey   — model is current
  | "training"      // spinning (developer) / grey+updating (client)
  | "deployed"      // green flash — new model just deployed
  | "rejected"      // yellow flash — gate failed, model not deployed
  | "error"         // developer only — build/infra error
  | "no_registry"   // VITE_GCS_REGISTRY_URL not configured
  | "loading";      // initial fetch

export interface UseTrainButton {
  state:        TrainButtonState;
  modelVersion: string | null;
  lastMae:      number | null;
  isTraining:   boolean;   // true when training_status.txt = running
  gateStatus:   string | null;
  onTrain:      () => void;
}

function registryFileUrl(filename: string): string | null {
  if (!REGISTRY_URL) return null;
  return REGISTRY_URL.replace("/model_registry.json", `/registry/${filename}`);
}

function isAfter(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a) return false;
  try {
    const ta = new Date(a).getTime();
    const tb = b ? new Date(b).getTime() : 0;
    return !isNaN(ta) && ta > tb;
  } catch {
    return false;
  }
}

export function useTrainButton(): UseTrainButton {
  const [state,        setState]        = useState<TrainButtonState>("loading");
  const [modelVersion, setModelVersion] = useState<string | null>(null);
  const [lastMae,      setLastMae]      = useState<number | null>(null);
  const [isTraining,   setIsTraining]   = useState(false);
  const [gateStatus,   setGateStatus]   = useState<string | null>(null);
  const clickedAt = useRef<number | null>(null);

  const check = useCallback(async () => {
    if (!REGISTRY_URL) { setState("no_registry"); return; }

    try {
      // Fetch all GCS sources in parallel
      const [regRes, uploadRes, _trainedRes, trainingStatusRes, gateRes, trainingResultRes] =
        await Promise.all([
          fetch(`${REGISTRY_URL}?${Date.now()}`,                                     { cache: "no-store" }),
          fetch(`${registryFileUrl("last_data_upload.txt")}?${Date.now()}`,        { cache: "no-store" }).catch(() => null),
          fetch(`${registryFileUrl("last_deployed.txt")}?${Date.now()}`,           { cache: "no-store" }).catch(() => null),
          fetch(`${registryFileUrl("training_status.txt")}?${Date.now()}`,         { cache: "no-store" }).catch(() => null),
          fetch(`${registryFileUrl("gate_status.txt")}?${Date.now()}`,             { cache: "no-store" }).catch(() => null),
          fetch(`${registryFileUrl("last_training_result.json")}?${Date.now()}`,   { cache: "no-store" }).catch(() => null),
        ]);

      if (!regRes.ok) { setState("no_registry"); return; }

      const regText = await regRes.text();
      if (!regText.trim()) { setState("no_registry"); return; }

      let reg: Record<string, unknown>;
      try { reg = JSON.parse(regText); }
      catch { setState("no_registry"); return; }

      // Update display values
      setModelVersion((reg.latest_version as string) ?? null);
      setLastMae(typeof reg.mae === "number" ? reg.mae : null);

      // Read timestamps — prefer separate files, fall back to registry JSON
      const fileUpload   = uploadRes?.ok  ? (await uploadRes.text()).trim()         : null;
      const regUpload    = reg.last_data_upload as string | null;
      const lastUpload   = isAfter(fileUpload, regUpload)  ? fileUpload  : regUpload;

      const lastTrained  = reg.last_trained as string | null;

      // Training status
      const trainingStatus = trainingStatusRes?.ok
        ? (await trainingStatusRes.text()).trim()
        : null;
      const training = trainingStatus === "running";
      setIsTraining(training);

      // Gate status (developer only)
      const gate = gateRes?.ok ? (await gateRes.text()).trim() : null;
      setGateStatus(gate);

      // ── Flash states — show for 10s after click ──────────────────────────
      const FLASH_DURATION_MS = 10_000;
      const justClicked = clickedAt.current !== null &&
        Date.now() - clickedAt.current < FLASH_DURATION_MS;

      if (justClicked && trainingResultRes?.ok) {
        try {
          const result = await trainingResultRes.json();
          const trainedAt = new Date(result.trained_at).getTime();
          const isRecent  = Date.now() - trainedAt < FLASH_DURATION_MS * 6; // 60s window
          if (isRecent) {
            if (result.status === "passed" || result.status === "first_model") {
              setState("deployed"); return;
            } else if (result.status === "failed" || result.status === "marginal") {
              setState("rejected"); return;
            }
          }
        } catch { /* ignore */ }
      }

      // ── State machine ─────────────────────────────────────────────────────
      if (training) {
        // Training in progress — developer sees spinner, client sees grey+updating
        setState("training");
        return;
      }

      if (IS_DEVELOPER && gate && gate !== "passed" && gate !== "") {
        // Gate failed or build failed — developer only
        setState("error");
        return;
      }

      // Core logic: purple if new data exists that hasn't been trained on
      if (isAfter(lastUpload, lastTrained)) {
        setState("active");
      } else {
        setState("current");
      }

    } catch (err) {
      console.warn("useTrainButton: fetch failed", err);
      setState("current");  // degrade silently — never show error to client
    }
  }, []);

  useEffect(() => {
    check();
    const id = setInterval(check, POLL_MS);
    return () => clearInterval(id);
  }, [check]);

  const onTrain = useCallback(() => {
    clickedAt.current = Date.now();
    setState("current"); // grey immediately on click
    window.open(COLAB_URL, "_blank", "noopener,noreferrer");
  }, []);

  return { state, modelVersion, lastMae, isTraining, gateStatus, onTrain };
}
