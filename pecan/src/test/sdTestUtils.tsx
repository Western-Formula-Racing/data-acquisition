// pecan/src/test/sdTestUtils.tsx
import { vi } from "vitest";

/** Mutable map of "msgId:signal" -> sensorReading. Set before/within a test. */
export const signalMap = new Map<string, { sensorReading: number; unit: string }>();

export function setSignal(msgId: string, signal: string, sensorReading: number, unit = "") {
  signalMap.set(`${msgId}:${signal}`, { sensorReading, unit });
}
export function clearSignals() {
  signalMap.clear();
}

// Mock useSignal so useSdValue (and synoptics) read from signalMap.
vi.mock("../lib/useDataStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/useDataStore")>();
  return {
    ...actual,
    useSignal: (msgId: string, signal: string) => signalMap.get(`${msgId}:${signal}`),
  };
});
