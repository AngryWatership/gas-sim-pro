/**
 * Maps gas concentration (0–1) to a hex color.
 * Dark mode: deep blue → cyan → white
 * Light mode: transparent → light orange → deep red
 */
export function concentrationToHex(value: number, lightMode = false): string {
  if (value <= 0) return "";
  const v = Math.min(1, value);
  if (lightMode) {
      // Dark mode: blue-tinted cyan
      const r = Math.round(v * v * 180);
      const g = Math.round(v * 220);
      const b = Math.round(80 + v * 175);
      return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }


  // Warm tones on white: pale yellow → orange → red
  const r = Math.round(255);
  const g = Math.round(220 - v * 180);
  const b = Math.round(180 - v * 180);
  const alpha = Math.round(40 + v * 200);
  return `rgba(${r},${g},${b},${alpha / 255})`;
}
