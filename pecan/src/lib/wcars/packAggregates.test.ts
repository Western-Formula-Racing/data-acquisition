import { describe, expect, it, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { dataStore } from "../../lib/DataStore";
import { usePackAggregates, usePackTemp } from "./packAggregates";

function ingestFrame(module: number, frame: number, voltages: number[]) {
  const id = 0x3EE + (module - 1) * 5 + (frame - 1);
  const msgID = `0x${id.toString(16).toUpperCase().padStart(3, "0")}`;
  const data: Record<string, { sensorReading: number; unit: string }> = {};
  voltages.forEach((v, i) => {
    const cell = (frame - 1) * 4 + i + 1;
    data[`M${module}_Cell${cell}_Voltage`] = { sensorReading: v, unit: "V" };
  });
  dataStore.ingestMessage({
    msgID,
    messageName: `TORCH_M${module}_V${frame}`,
    data,
    rawData: "",
    source: "live",
  });
}

function ingestThermFrame(module: number, frame: number, count: number, temps: number[]) {
  const id = 0x407 + (module - 1) * 5 + (frame - 1);
  const msgID = `0x${id.toString(16).toUpperCase().padStart(3, "0")}`;
  const data: Record<string, { sensorReading: number; unit: string }> = {};
  for (let i = 0; i < count; i++) {
    const idx = (frame - 1) * 4 + (i + 1);
    data[`M${module}_Thermistor${idx}`] = { sensorReading: temps[i], unit: "C" };
  }
  dataStore.ingestMessage({
    msgID,
    messageName: `TORCH_M${module}_T${frame}`,
    data,
    rawData: "",
    source: "live",
  });
}

describe("usePackAggregates", () => {
  beforeEach(() => dataStore.clear());

  it("returns zero when no cells have arrived", () => {
    const { result } = renderHook(() => usePackAggregates());
    expect(result.current.cellCount).toBe(0);
    expect(result.current.packVoltage).toBe(0);
    expect(result.current.minVoltage).toBeNull();
    expect(result.current.maxVoltage).toBeNull();
  });

  it("sums 100 cells and tracks min/max once every frame is present", () => {
    for (let m = 1; m <= 5; m++) {
      for (let f = 1; f <= 5; f++) {
        ingestFrame(m, f, [3.7, 3.75, 3.8, 3.78]);
      }
    }
    const { result } = renderHook(() => usePackAggregates());
    expect(result.current.cellCount).toBe(100);
    // sum = (3.7+3.75+3.8+3.78) * 25 frames = 15.03 * 25 = 375.75
    expect(result.current.packVoltage).toBeCloseTo(375.75, 1);
    expect(result.current.minVoltage).toBeCloseTo(3.7, 5);
    expect(result.current.maxVoltage).toBeCloseTo(3.8, 5);
  });
});

describe("usePackTemp", () => {
  beforeEach(() => dataStore.clear());

  it("returns null when no thermistor frames have arrived", () => {
    const { result } = renderHook(() => usePackTemp());
    expect(result.current.tempC).toBeNull();
    expect(result.current.sensorsRead).toBe(0);
    expect(result.current.totalSensors).toBe(90);
  });

  it("averages all 90 thermistors across 5 modules", () => {
    for (let m = 1; m <= 5; m++) {
      ingestThermFrame(m, 1, 4, [25, 25, 25, 25]);
      ingestThermFrame(m, 2, 4, [25, 25, 25, 25]);
      ingestThermFrame(m, 3, 4, [25, 25, 25, 25]);
      ingestThermFrame(m, 4, 4, [25, 25, 25, 25]);
      ingestThermFrame(m, 5, 2, [25, 25]);
    }
    const { result } = renderHook(() => usePackTemp());
    expect(result.current.sensorsRead).toBe(90);
    expect(result.current.tempC).toBeCloseTo(25, 5);
  });
});
