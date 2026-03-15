/**
 * useTrainButton.ts
 * Hook that manages the TRAIN button active/greyed state.
 *
 * Logic:
 *   - Fetches model_registry.json from GCS on mount and every 60s
 *   - Button is ACTIVE when localStorage lastExportTimestamp > registry last_deployed
 *   - Button is GREYED when model is current or no data has been exported yet
 *   - Button shows hint when VITE_GCS_REGISTRY_URL is not configured
 *   - On click: opens Colab notebook URL in new tab
 */

import { useState, useEffect, useCallback } from "react";

const COLAB_URL =
  import.meta.env.VITE_COLAB_NOTEBOOK_URL ??
  "https://colab.research.google.com/github/AngryWatership/gas-sim-pro/blob/main/notebooks/train.ipynb";

const REGISTRY_URL: string | undefined = import.meta.env.VITE_GCS_REGISTRY_URL;

const POLL_INTERVAL_MS = 60_000;

// All fields nullable — matches the initial placeholder registry
interface Registry {
  last_trained:     string | null;
  last_deployed:    string | null;
  last_data_upload: string | null;
  latest_version:   string | null;
  mae:              number | null;
  previous_mae:     number | null;
}

export type TrainButtonState =
  | "active"       // new data exported since last model deploy
  | "current"      // model is up to date, or no data exported yet
  | "no_registry"  // VITE_GCS_REGISTRY_URL not set in .env.local
  | "loading";     // initial fetch in progress

export interface UseTrainButton {
  state:        TrainButtonState;
  modelVersion: string | null;
  lastMae:      number | null;
  onTrain:      () => void;
}

// Safe date comparison — returns true only when both are valid non-null dates
// and a is strictly after b
function isAfter(a: string | null, b: string | null): boolean {
  if (!a) return false;
  const dateA = new Date(a).getTime();
  const dateB = b ? new Date(b).getTime() : 0;
  return !isNaN(dateA) && dateA > dateB;
}

export function useTrainButton(): UseTrainButton {
  const [btnState,     setBtnState]     = useState<TrainButtonState>("loading");
  const [modelVersion, setModelVersion] = useState<string | null>(null);
  const [lastMae,      setLastMae]      = useState<number | null>(null);

  const checkRegistry = useCallback(async () => {
    // No registry URL configured — ENV B not set up yet
    if (!REGISTRY_URL) {
      setBtnState("no_registry");
      return;
    }

    try {
      const res = await fetch(REGISTRY_URL, { cache: "no-store" });

      if (!res.ok) {
        setBtnState("no_registry");
        return;
      }

      const reg: Registry = await res.json();

      // Update display values — both may be null in initial registry
      setModelVersion(reg.latest_version ?? null);
      setLastMae(typeof reg.mae === "number" ? reg.mae : null);

      const lastExport = localStorage.getItem("lastExportTimestamp");

      // No data exported from this browser yet — show greyed
      if (!lastExport) {
        setBtnState("current");
        return;
      }

      // Active only when export is strictly newer than last deployment
      // isAfter handles null last_deployed safely (treats as epoch)
      setBtnState(
        isAfter(lastExport, reg.last_deployed) ? "active" : "current"
      );

    } catch (err) {
      // Network error or JSON parse error — do not show hint, show greyed
      // so the button degrades silently rather than showing a confusing message
      console.warn("useTrainButton: registry fetch failed", err);
      setBtnState("current");
    }
  }, []);

  useEffect(() => {
    checkRegistry();
    const id = setInterval(checkRegistry, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [checkRegistry]);

  const onTrain = useCallback(() => {
    window.open(COLAB_URL, "_blank", "noopener,noreferrer");
  }, []);

  return { state: btnState, modelVersion, lastMae, onTrain };
}
