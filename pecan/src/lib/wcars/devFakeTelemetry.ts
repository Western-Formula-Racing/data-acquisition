import { dataStore } from "../DataStore";
import { SD_SIGNALS } from "./sdSignals";

/** Dev-only: inject fake decoded samples into DataStore so SD synoptics render.
 *  Active only when the page loads with ?fakesd=1. Returns a stop function.
 *
 *  The injected values mirror a real "car powered, on track" situation as
 *  defined by the WFR25 DBC: 1-bit safety/relay flags read closed/healthy,
 *  enum state signals carry their DBC label (decoder puts the label in `unit`),
 *  and analog channels sweep sinusoidally within their configured range. */

/** Enum state signals: steady value + the matching WFR25 DBC VAL_ label. */
const ENUM_STATE: Record<string, { value: number; label: string }> = {
  PackStatus: { value: 3, label: "Active" }, // VAL_ 1056 PackStatus 3 "Active"
  State:      { value: 4, label: "DRIVE" },  // VAL_ 2002 State 4 "DRIVE"
};

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
    for (const [msgId, sigs] of byMsg) {
      const data: Record<string, { sensorReading: number; unit: string }> = {};
      for (const { signal, range } of sigs) {
        const enumState = ENUM_STATE[signal];
        if (enumState) {
          data[signal] = { sensorReading: enumState.value, unit: enumState.label };
          continue;
        }
        const [min, max] = range;
        // 1-bit boolean (relays, safety-loop flags): healthy / energized = 1.
        if (min === 0 && max === 1) {
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
