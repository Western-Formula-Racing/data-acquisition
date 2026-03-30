import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { dataStore } from "./DataStore";
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
    expect(result.current.totalSamples).toBe(0);

    await act(async () => {
      dataStore.ingestMessage({ msgID: "0x401", messageName: "S", data: {}, rawData: "00" });
    });

    expect(result.current.totalMessages).toBe(1);
    expect(result.current.totalSamples).toBe(1);
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
