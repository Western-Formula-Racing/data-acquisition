import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { dataStore } from "./DataStore";
import { TimelineProvider, useTimeline } from "../context/TimelineContext";
import {
  useAllMessageIds,
  useAllSignals,
  useAllLatestMessages,
  useDataStoreControls,
  useDataStoreStats,
  useLatestMessage,
  useMessageData,
  useMessageHistory,
  useSignal,
  useTraceBuffer,
} from "./useDataStore";

describe("useDataStore hooks", () => {
  it("useLatestMessage reacts to new samples", async () => {
    const { result } = renderHook(() => useLatestMessage("0x100"));
    expect(result.current).toBeUndefined();

    await act(async () => {
      dataStore.ingestMessage({
        msgID: "0x100",
        messageName: "Test",
        data: { rpm: { sensorReading: 1000, unit: "rpm" } },
        rawData: "01 02",
      });
    });

    expect(result.current?.messageName).toBe("Test");
  });

  it("useMessageHistory returns bounded history", async () => {
    const now = Date.now();
    await act(async () => {
      dataStore.ingestMessage({ msgID: "0x101", messageName: "A", data: {}, rawData: "00", timestamp: now - 1000 });
      dataStore.ingestMessage({ msgID: "0x101", messageName: "A", data: {}, rawData: "00", timestamp: now });
    });

    const { result } = renderHook(() => useMessageHistory("0x101", 500));
    expect(result.current).toHaveLength(1);
  });

  it("useSignal returns specific signal", async () => {
    await act(async () => {
      dataStore.ingestMessage({
        msgID: "0x102",
        messageName: "Sig",
        data: { temp: { sensorReading: 88.6, unit: "C" } },
        rawData: "AA",
      });
    });

    const { result } = renderHook(() => useSignal("0x102", "temp"));
    expect(result.current).toEqual({ sensorReading: 88.6, unit: "C" });
  });

  it("useAllLatestMessages returns latest map", async () => {
    await act(async () => {
      dataStore.ingestMessage({ msgID: "0x201", messageName: "One", data: {}, rawData: "00" });
      dataStore.ingestMessage({ msgID: "0x202", messageName: "Two", data: {}, rawData: "00" });
    });

    const { result } = renderHook(() => useAllLatestMessages());
    expect(result.current.size).toBe(2);
    expect(result.current.get("0x201")?.messageName).toBe("One");
  });

  it("useAllMessageIds and useAllSignals expose current keys/signals", async () => {
    await act(async () => {
      dataStore.ingestMessage({
        msgID: "0x301",
        messageName: "SigA",
        data: { volts: { sensorReading: 12, unit: "V" } },
        rawData: "00",
      });
      dataStore.ingestMessage({
        msgID: "0x302",
        messageName: "SigB",
        data: { amps: { sensorReading: 3, unit: "A" } },
        rawData: "01",
      });
    });

    const ids = renderHook(() => useAllMessageIds());
    const signals = renderHook(() => useAllSignals());

    expect(ids.result.current.sort()).toEqual(["0x301", "0x302"]);
    expect(signals.result.current).toEqual(
      expect.arrayContaining([
        { msgID: "0x301", signalName: "volts" },
        { msgID: "0x302", signalName: "amps" },
      ])
    );
  });

  it("useDataStoreStats updates as data changes", async () => {
    const { result } = renderHook(() => useDataStoreStats());
    const initialMessages = result.current.totalMessages;

    await act(async () => {
      dataStore.ingestMessage({ msgID: "0x401", messageName: "S", data: {}, rawData: "00" });
    });

    // useDataStoreStats throttles updates via a 1s setTimeout; wait for it to fire.
    await waitFor(() => {
      expect(result.current.totalMessages).toBeGreaterThan(initialMessages);
    }, { timeout: 2000 });
  });

  it("useDataStoreControls operations mutate store", async () => {
    const { result } = renderHook(() => useDataStoreControls());

    act(() => {
      result.current.ingestMessage({ msgID: "0x500", messageName: "Ctrl", data: {}, rawData: "AA" });
    });
    expect(dataStore.getLatest("0x500")?.messageName).toBe("Ctrl");

    act(() => {
      result.current.clearMessage("0x500");
    });
    expect(dataStore.getLatest("0x500")).toBeUndefined();

    act(() => {
      result.current.ingestMessage({ msgID: "0x501", messageName: "Ctrl2", data: {}, rawData: "BB" });
      result.current.clear();
    });
    expect(dataStore.getAllMessageIds()).toHaveLength(0);
  });

  it("useMessageData returns latest and history tuple", async () => {
    const now = Date.now();
    await act(async () => {
      dataStore.ingestMessage({ msgID: "0x601", messageName: "MD", data: {}, rawData: "0", timestamp: now - 100 });
      dataStore.ingestMessage({ msgID: "0x601", messageName: "MD", data: {}, rawData: "1", timestamp: now });
    });

    const { result } = renderHook(() => useMessageData("0x601", 50));
    expect(result.current.latest?.rawData).toBe("1");
    expect(result.current.history).toHaveLength(1);
  });

  // --- Universal scrub: hooks must follow the timeline cursor when paused ---

  const timelineWrapper = ({ children }: { children: ReactNode }) =>
    createElement(TimelineProvider, null, children);

  function ingestScrub(msgID: string, reading: number, raw: string, timestamp: number) {
    dataStore.ingestMessage({
      msgID,
      messageName: "Scrub",
      data: { v: { sensorReading: reading, unit: "" } },
      rawData: raw,
      timestamp,
    });
  }

  it("useLatestMessage follows the scrub cursor when paused", async () => {
    // Recent timestamps so the samples live in the hot buffer (within retention).
    const base = Date.now() - 5000;
    await act(async () => {
      ingestScrub("0xD10", 1, "01", base);
      ingestScrub("0xD10", 2, "02", base + 1000);
      ingestScrub("0xD10", 3, "03", base + 2000);
    });

    const { result } = renderHook(
      () => ({ tl: useTimeline(), latest: useLatestMessage("0xD10") }),
      { wrapper: timelineWrapper }
    );

    // Live: newest sample.
    expect(result.current.latest?.rawData).toBe("03");

    // Scrub between the 1st and 2nd samples → value at the cursor.
    await act(async () => {
      result.current.tl.seek(base + 1500);
    });
    expect(result.current.latest?.rawData).toBe("02");

    // Returning live snaps back to the newest sample.
    await act(async () => {
      result.current.tl.goLive();
    });
    expect(result.current.latest?.rawData).toBe("03");
  });

  it("useAllLatestMessages reflects all panels at the cursor when paused", async () => {
    const base = Date.now() - 5000;
    await act(async () => {
      ingestScrub("0xD20", 10, "0a", base);
      ingestScrub("0xD20", 20, "14", base + 2000);
      ingestScrub("0xD21", 99, "63", base + 1000);
    });

    const { result } = renderHook(
      () => ({ tl: useTimeline(), all: useAllLatestMessages("live") }),
      { wrapper: timelineWrapper }
    );

    // Live: newest of each message.
    expect(result.current.all.get("0xD20")?.rawData).toBe("14");

    // Scrub before 0xD20's second sample: it reverts to the earlier value,
    // and 0xD21 (which existed by then) is still present.
    await act(async () => {
      result.current.tl.seek(base + 1500);
    });
    expect(result.current.all.get("0xD20")?.rawData).toBe("0a");
    expect(result.current.all.get("0xD21")?.rawData).toBe("63");
  });

  it("useTraceBuffer batches updates and supports clearTrace", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTraceBuffer(10));

    act(() => {
      dataStore.ingestMessage({ msgID: "0x701", messageName: "T", data: {}, rawData: "00" });
      dataStore.ingestMessage({ msgID: "0x702", messageName: "T", data: {}, rawData: "01" });
    });

    act(() => {
      vi.advanceTimersByTime(11);
    });
    expect(result.current.frames).toHaveLength(2);

    act(() => {
      result.current.clearTrace();
    });
    expect(result.current.frames).toHaveLength(0);
    vi.useRealTimers();
  });
});
