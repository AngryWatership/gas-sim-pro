/**
 * useTrainButton.ts
 * Hook that manages the TRAIN button active/greyed state.
 *
 * Logic:
 *   - Fetches model_registry.json from GCS on mount and every 60s
 *   - Button is ACTIVE when localStorage lastExportTimestamp > registry last_deployed
 *   - Button is GREYED when model is current or registry is unreachable
 *   - On click: opens Colab notebook URL in new tab
 *
 * Environment variables (in .env.local):
 *   VITE_GCS_REGISTRY_URL   = full public URL to model_registry.json
 *   VITE_COLAB_NOTEBOOK_URL = Colab notebook URL (defaults to GitHub URL below)
 */

import { useState, useEffect, useCallback } from "react";

const COLAB_URL =
  import.meta.env.VITE_COLAB_NOTEBOOK_URL ??
  "https://colab.research.google.com/github/AngryWatership/gas-sim-pro/blob/main/notebooks/train.ipynb";

const REGISTRY_URL: string | undefined = import.meta.env.VITE_GCS_REGISTRY_URL;

const POLL_INTERVAL_MS = 60_000;

interface Registry {
  last_trained:     string;
  last_deployed:    string;
  last_data_upload: string;
  latest_version:   string;
  mae:              number;
}

export type TrainButtonState =
  | "active"          // new data available, retrain needed
  | "current"         // model is up to date
  | "no_registry"     // ENV B not set up yet
  | "loading";        // initial fetch in progress

export interface UseTrainButton {
  state:        TrainButtonState;
  modelVersion: string | null;
  lastMae:      number | null;
  onTrain:      () => void;
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
      if (!res.ok) { setBtnState("no_registry"); return; }

      const reg: Registry = await res.json();
      setModelVersion(reg.latest_version ?? null);
      setLastMae(reg.mae ?? null);

      const lastExport   = localStorage.getItem("lastExportTimestamp");
      const lastDeployed = reg.last_deployed;

      if (!lastExport) {
        // No data ever exported from this browser — button greyed
        setBtnState("current");
        return;
      }

      // Active when new data exists that the current model hasn't seen
      const exportNewer = new Date(lastExport) > new Date(lastDeployed ?? 0);
      setBtnState(exportNewer ? "active" : "current");

    } catch {
      setBtnState("no_registry");
    }
  }, []);

  // Poll on mount and every 60s
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
