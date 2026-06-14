// pecan/src/lib/wcars/devFakeTelemetry.ts
//
// Dev-only: inject fake decoded samples into DataStore so SD synoptics render.
// Active only when the page loads with ?fakesd=1. Returns a stop function.
//
// The injected values mirror a real WFR25 situation as defined in the
// DBC: 1-bit flags read closed/healthy, enum state signals carry their
// VAL_ label (decoder puts the label in `unit`), analog channels sweep
// sinusoidally within their configured range, and per-cell voltages are
// generated for every TORCH_M{n}_V{m} frame so usePackAggregates() sums
// to a believable pack voltage.

import { dataStore } from "../DataStore";
import { SD_SIGNALS } from "./sdSignals";

/** Enum state signals: steady value + the matching WFR25 DBC VAL_ label. */
const ENUM_STATE: Record<string, { value: number; label: string }> = {
  PackStatus: { value: 3, label: "Active" }, // VAL_ 1056 PackStatus 3 "Active"
  State:      { value: 4, label: "DRIVE" },  // VAL_ 2002 State 4 "DRIVE"
};

/** TORCH_M{n}_V{m} frames: 5 modules × 5 frames × 4 cells = 100 cells. */
const TORCH_V_FRAMES: { msgId: string; module: number; frame: number }[] = [];
for (let m = 1; m <= 5; m++) {
  for (let f = 1; f <= 5; f++) {
    const id = 0x3EE + (m - 1) * 5 + (f - 1);
    TORCH_V_FRAMES.push({
      msgId: `0x${id.toString(16).toUpperCase().padStart(3, "0")}`,
      module: m,
      frame: f,
    });
  }
}

/** TORCH_M{n}_T{m} frames: 5 modules × 5 frames, 4+4+4+4+2 = 18 therms. */
const TORCH_T_FRAMES: { msgId: string; module: number; frame: number; count: number }[] = [];
for (let m = 1; m <= 5; m++) {
  for (let f = 1; f <= 5; f++) {
    const id = 0x407 + (m - 1) * 5 + (f - 1);
    TORCH_T_FRAMES.push({
      msgId: `0x${id.toString(16).toUpperCase().padStart(3, "0")}`,
      module: m,
      frame: f,
      count: f === 5 ? 2 : 4,
    });
  }
}

/** Generate plausible per-cell voltages centered on 3.78 V (50% SoC) with a
 *  small per-cell offset so the spread/min/max reads honestly. */
function fakeCellVoltages(module: number, frame: number, t: number): Record<string, { sensorReading: number; unit: string }> {
  const out: Record<string, { sensorReading: number; unit: string }> = {};
  for (let c = 1; c <= 4; c++) {
    const cellIdx = (frame - 1) * 4 + c;
    // slow sine of the whole pack + per-cell phase so the spread is alive
    const base = 3.78 + 0.05 * Math.sin(t / 2000 + module + cellIdx * 0.31);
    out[`M${module}_Cell${cellIdx}_Voltage`] = {
      sensorReading: Math.round(base * 1e4) / 1e4,
      unit: "V",
    };
  }
  return out;
}

/** Generate plausible thermistor temperatures centered on 30 °C with a
 *  small per-sensor offset so the pack mean is real and the spread reads. */
function fakeThermistorTemps(module: number, frame: number, count: number, t: number): Record<string, { sensorReading: number; unit: string }> {
  const out: Record<string, { sensorReading: number; unit: string }> = {};
  for (let c = 1; c <= count; c++) {
    const idx = (frame - 1) * 4 + c;
    const base = 30 + 1.2 * Math.sin(t / 3000 + module * 0.7 + idx * 0.21);
    out[`M${module}_Thermistor${idx}`] = {
      sensorReading: Math.round(base * 10) / 10,
      unit: "C",
    };
  }
  return out;
}

export function startFakeSdTelemetry(): () => void {
  // Group signal keys by msgId so each tick writes one sample per message.
  const byMsg = new Map<string, { signal: string; range: [number, number] }[]>();
  for (const def of Object.values(SD_SIGNALS)) {
    const arr = byMsg.get(def.msgId) ?? [];
    arr.push({ signal: def.signal, range: def.range });
    byMsg.set(def.msgId, arr);
  }

  const tick = () => {
    const now = Date.now();
    // Write per-cell voltage frames first so the pack-aggregate hook has
    // fresh data every tick.
    for (const { msgId, module, frame } of TORCH_V_FRAMES) {
      dataStore.ingestMessage({
        msgID: msgId,
        messageName: `FAKE_TORCH_M${module}_V${frame}`,
        data: fakeCellVoltages(module, frame, now),
        rawData: "",
        timestamp: now,
        source: "live",
      });
    }
    for (const { msgId, module, frame, count } of TORCH_T_FRAMES) {
      dataStore.ingestMessage({
        msgID: msgId,
        messageName: `FAKE_TORCH_M${module}_T${frame}`,
        data: fakeThermistorTemps(module, frame, count, now),
        rawData: "",
        timestamp: now,
        source: "live",
      });
    }
    for (const [msgId, sigs] of byMsg) {
      const data: Record<string, { sensorReading: number; unit: string }> = {};
      for (const { signal, range } of sigs) {
        const enumState = ENUM_STATE[signal];
        if (enumState) {
          data[signal] = { sensorReading: enumState.value, unit: enumState.label };
          continue;
        }
        const [min, max] = range;
        // 1-bit boolean: healthy / energized / closed = 1.
        if (min === 0 && max === 1) {
          data[signal] = { sensorReading: 1, unit: "" };
          continue;
        }
        // AIR_Positive_Relay is 3 bits; healthy state is closed = any non-zero.
        if (signal === "AIR_Positive_Relay") {
          data[signal] = { sensorReading: 1, unit: "" };
          continue;
        }
        // Analog channel: sweep within range.
        const mid = (min + max) / 2;
        const amp = (max - min) / 4;
        data[signal] = {
          sensorReading: Math.round((mid + amp * Math.sin(now / 1500)) * 10) / 10,
          unit: "",
        };
      }
      dataStore.ingestMessage({
        msgID: msgId,
        messageName: `FAKE_${msgId}`,
        data,
        rawData: "",
        timestamp: now,
        source: "live",
      });
    }
  };

  const handle = window.setInterval(tick, 200);
  tick();
  return () => window.clearInterval(handle);
}
