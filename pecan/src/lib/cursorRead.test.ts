import { describe, expect, it } from "vitest";
import { dataStore } from "./DataStore";
import { readLatest, readHistory } from "./cursorRead";

/**
 * cursorRead is the single chokepoint every panel routes through so timeline
 * scrubbing is universal: live → newest sample, paused → value at the cursor.
 * The DataStore is cleared between tests by src/test-setup.ts.
 *
 * Timestamps are anchored near Date.now() so samples stay inside the DataStore
 * retention window (it prunes samples older than the window vs. wall-clock).
 */
function ingest(msgID: string, reading: number, raw: string, timestamp: number) {
  dataStore.ingestMessage({
    msgID,
    messageName: "Scrub",
    data: { v: { sensorReading: reading, unit: "" } },
    rawData: raw,
    timestamp,
  });
}

describe("readLatest", () => {
  it("returns the newest sample in live mode", () => {
    const t0 = Date.now() - 4000;
    ingest("0xC01", 10, "0a", t0);
    ingest("0xC01", 20, "14", t0 + 1000);
    ingest("0xC01", 30, "1e", t0 + 2000);

    expect(readLatest("0xC01", "live", t0 + 1000)?.rawData).toBe("1e");
  });

  it("returns the sample at-or-before the cursor when paused", () => {
    const t0 = Date.now() - 4000;
    ingest("0xC02", 10, "0a", t0);
    ingest("0xC02", 20, "14", t0 + 1000);
    ingest("0xC02", 30, "1e", t0 + 2000);

    // Cursor between the 2nd and 3rd samples → 2nd sample.
    expect(readLatest("0xC02", "paused", t0 + 1500)?.rawData).toBe("14");
    // Cursor exactly on the newest → newest.
    expect(readLatest("0xC02", "paused", t0 + 2000)?.rawData).toBe("1e");
  });

  it("returns undefined when the cursor predates the first sample", () => {
    const t0 = Date.now() - 4000;
    ingest("0xC03", 10, "0a", t0);
    expect(readLatest("0xC03", "paused", t0 - 1)).toBeUndefined();
  });
});

describe("readHistory", () => {
  it("returns the newest-anchored window in live mode", () => {
    const t0 = Date.now() - 4000;
    ingest("0xC10", 1, "01", t0);
    ingest("0xC10", 2, "02", t0 + 1000);
    ingest("0xC10", 3, "03", t0 + 2000);

    const hist = readHistory("0xC10", 5000, "live", t0 + 1000);
    expect(hist).toHaveLength(3);
    expect(hist[hist.length - 1].rawData).toBe("03");
  });

  it("clips the window to the cursor when paused", () => {
    const t0 = Date.now() - 4000;
    ingest("0xC11", 1, "01", t0);
    ingest("0xC11", 2, "02", t0 + 1000);
    ingest("0xC11", 3, "03", t0 + 2000);

    // Window 5000ms ending at the cursor (t0+1000) → excludes the t0+2000 sample.
    const hist = readHistory("0xC11", 5000, "paused", t0 + 1000);
    expect(hist.map((s) => s.rawData)).toEqual(["01", "02"]);
  });

  it("respects a narrow window ending at the cursor when paused", () => {
    const t0 = Date.now() - 4000;
    ingest("0xC12", 1, "01", t0);
    ingest("0xC12", 2, "02", t0 + 1000);
    ingest("0xC12", 3, "03", t0 + 2000);

    // Only [t0+1900, t0+2000] → just the newest sample.
    const hist = readHistory("0xC12", 100, "paused", t0 + 2000);
    expect(hist.map((s) => s.rawData)).toEqual(["03"]);
  });

  it("still clips at the cursor when no explicit window is given (paused)", () => {
    const t0 = Date.now() - 4000;
    ingest("0xC13", 1, "01", t0);
    ingest("0xC13", 2, "02", t0 + 1000);
    ingest("0xC13", 3, "03", t0 + 2000);

    // Default window is the retention window, but it must still end at the cursor.
    const hist = readHistory("0xC13", undefined, "paused", t0 + 1000);
    expect(hist.map((s) => s.rawData)).toEqual(["01", "02"]);
  });
});
