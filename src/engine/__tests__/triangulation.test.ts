import { describe, it, expect } from "vitest";
import { estimateLeakPosition, getSensorReadings } from "../triangulation";
import type { SensorReading } from "../types";

describe("estimateLeakPosition", () => {
  it("returns null when fewer than 2 active sensors", () => {
    const readings: SensorReading[] = [
      { sensor: { id: "s1", row: 5, col: 5 }, concentration: 0.5 },
    ];
    expect(estimateLeakPosition(readings, null)).toBeNull();
  });

  it("returns centroid of two equal-concentration sensors", () => {
    const readings: SensorReading[] = [
      { sensor: { id: "s1", row: 0, col: 0 }, concentration: 1 },
      { sensor: { id: "s2", row: 10, col: 10 }, concentration: 1 },
    ];
    const result = estimateLeakPosition(readings, null);
    expect(result?.row).toBeCloseTo(5);
    expect(result?.col).toBeCloseTo(5);
  });

  it("weights estimate toward higher-concentration sensor", () => {
    const readings: SensorReading[] = [
      { sensor: { id: "s1", row: 0, col: 0 }, concentration: 3 },
      { sensor: { id: "s2", row: 10, col: 10 }, concentration: 1 },
    ];
    const result = estimateLeakPosition(readings, null);
    expect(result?.row).toBeLessThan(5);
  });

  it("ignores sensors below active threshold", () => {
    const readings: SensorReading[] = [
      { sensor: { id: "s1", row: 0, col: 0 }, concentration: 0.5 },
      { sensor: { id: "s2", row: 10, col: 10 }, concentration: 0 },
    ];
    expect(estimateLeakPosition(readings, null)).toBeNull();
  });

  it("computes correct euclidean error vs actual leak", () => {
    const readings: SensorReading[] = [
      { sensor: { id: "s1", row: 0, col: 0 }, concentration: 1 },
      { sensor: { id: "s2", row: 10, col: 0 }, concentration: 1 },
    ];
    const result = estimateLeakPosition(readings, { id: "actual", row: 0, col: 0 });
    expect(result?.error).toBeCloseTo(5, 1);
  });

  it("returns null error when no actual leak provided", () => {
    const readings: SensorReading[] = [
      { sensor: { id: "s1", row: 0, col: 0 }, concentration: 1 },
      { sensor: { id: "s2", row: 10, col: 10 }, concentration: 1 },
    ];
    expect(estimateLeakPosition(readings, null)?.error).toBeNull();
  });
});

describe("getSensorReadings", () => {
  it("reads correct concentration from flat grid", () => {
    const grid = new Float32Array(100);
    grid[3 * 10 + 7] = 0.42;
    const readings = getSensorReadings(
      [{ id: "s1", row: 3, col: 7 }],
      grid,
      { rows: 10, cols: 10 }
    );
    expect(readings[0].concentration).toBeCloseTo(0.42);
  });
});
