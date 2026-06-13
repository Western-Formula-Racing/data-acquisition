import { dataStore } from "../DataStore";
import { SD_SIGNALS } from "./sdSignals";

/** Dev-only: inject fake decoded samples into DataStore so SD synoptics render.
 *  Active only when the page loads with ?fakesd=1. Returns a stop function. */
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
        const [min, max] = range;
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
