/**
 * useTrainButton.ts
 * Manages TRAIN button state.
 *
 * Reads from two GCS sources to avoid rate-limiting model_registry.json:
 *   model_registry.json        — written by Colab + deploy function
 *   registry/last_data_upload.txt — written by ingest function
 *
 * Button is ACTIVE when max(last_data_upload from either source) > last_deployed
 */

import { useState, useEffect, useCallback } from "react";

const COLAB_URL =
  import.meta.env.VITE_COLAB_NOTEBOOK_URL ??
  "https://colab.research.google.com/github/AngryWatership/gas-sim-pro/blob/main/notebooks/train.ipynb";

const REGISTRY_URL: string | undefined = import.meta.env.VITE_GCS_REGISTRY_URL;
const POLL_INTERVAL_MS = 60_000;

interface Registry {
  last_trained:     string | null;
  last_deployed:    string | null;
  last_data_upload: string | null;
  latest_version:   string | null;
  mae:              number | null;
}

export type TrainButtonState =
  | "active"
  | "current"
  | "no_registry"
  | "loading";

export interface UseTrainButton {
  state:        TrainButtonState;
  modelVersion: string | null;
  lastMae:      number | null;
  onTrain:      () => void;
}

function isAfter(a: string | null, b: string | null): boolean {
  if (!a) return false;
  const dateA = new Date(a).getTime();
  const dateB = b ? new Date(b).getTime() : 0;
  return !isNaN(dateA) && dateA > dateB;
}

// Derive bucket base URL from registry URL
function registryFileUrl(filename: string): string | null {
  if (!REGISTRY_URL) return null;
  const base = REGISTRY_URL.replace("/model_registry.json", "");
  return `${base}/registry/${filename}`;
}

export function useTrainButton(): UseTrainButton {
  const [btnState,     setBtnState]     = useState<TrainButtonState>("loading");
  const [modelVersion, setModelVersion] = useState<string | null>(null);
  const [lastMae,      setLastMae]      = useState<number | null>(null);

  const checkRegistry = useCallback(async () => {
    if (!REGISTRY_URL) { setBtnState("no_registry"); return; }

    try {
      // Fetch all sources in parallel — separate files avoid rate-limiting model_registry.json
      const [regRes, uploadRes, deployedRes] = await Promise.all([
        fetch(`${REGISTRY_URL}?${Date.now()}`, { cache: "no-store" }),
        fetch(`${registryFileUrl("last_data_upload.txt")}?${Date.now()}`, { cache: "no-store" })
          .catch(() => null),
        fetch(`${registryFileUrl("last_deployed.txt")}?${Date.now()}`, { cache: "no-store" })
          .catch(() => null),
      ]);

      if (!regRes.ok) { setBtnState("no_registry"); return; }

      const regText = await regRes.text();
      if (!regText.trim()) { setBtnState("no_registry"); return; }

      let reg: Registry;
      try { reg = JSON.parse(regText); }
      catch { setBtnState("no_registry"); return; }
      setModelVersion(reg.latest_version ?? null);
      setLastMae(typeof reg.mae === "number" ? reg.mae : null);

      // Get timestamps from both registry JSON and separate lightweight files
      const regUpload      = reg.last_data_upload;
      const fileUpload     = uploadRes?.ok ? await uploadRes.text().then(t => t.trim()) : null;
      const lastUpload     = isAfter(fileUpload, regUpload) ? fileUpload : regUpload;

      const regDeployed    = reg.last_deployed;
      const fileDeployed   = deployedRes?.ok ? await deployedRes.text().then(t => t.trim()) : null;
      const lastDeployed   = isAfter(fileDeployed, regDeployed) ? fileDeployed : regDeployed;

      const lastExport     = localStorage.getItem("lastExportTimestamp");

      // Active when new data exists that hasn't been trained + deployed yet
      const gcsHasNewData     = isAfter(lastUpload,  lastDeployed);
      const browserHasNewData = lastExport ? isAfter(lastExport, lastDeployed ?? null) : false;

      setBtnState(gcsHasNewData || browserHasNewData ? "active" : "current");

    } catch (err) {
      console.warn("useTrainButton: fetch failed", err);
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
