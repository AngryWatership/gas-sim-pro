import type { SimulationState, LayoutSnapshot } from "../engine/types";

export type LoadTarget = "all" | "sensors" | "walls" | "doors";

export function exportLayout(state: SimulationState): LayoutSnapshot {
  const walls: number[] = [];
  const doors: number[] = [];
  state.blockedCells.forEach((v, i) => { if (v && !state.doorCells[i]) walls.push(i); });
  state.doorCells.forEach((v, i) => { if (v) doors.push(i); });
  return {
    version: 1,
    sensors: state.sensors,
    walls,
    doors,
    gasLeaks: state.gasLeaks,
  };
}

export function downloadLayout(state: SimulationState, filename = "layout.json") {
  const blob = new Blob([JSON.stringify(exportLayout(state), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function parseLayoutFile(file: File): Promise<LayoutSnapshot> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (data.version !== 1) throw new Error("Unknown layout version");
        // Back-compat: old files have gasLeak (single), migrate to gasLeaks array
        if (!data.gasLeaks && data.gasLeak) {
          data.gasLeaks = [{ ...data.gasLeak, id: `leak-migrated-0` }];
        }
        if (!data.gasLeaks) data.gasLeaks = [];
        resolve(data as LayoutSnapshot);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

