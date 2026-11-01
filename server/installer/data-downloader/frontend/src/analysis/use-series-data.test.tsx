import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeriesMap } from "./series-cache";
import type { SeriesResponse } from "../types";
import { useSeriesData } from "./use-series-data";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function seriesResponse(
  season: string,
  signal: string,
  value: number,
): SeriesResponse {
  return {
    season,
    start: "s",
    end: "e",
    series: {
      [signal]: {
        mode: "raw",
        resolution_ms: null,
        point_count: 1,
        t: [0],
        v: [value],
      },
    },
  };
}

function rawValues(seriesBySignal: SeriesMap, signal: string): number[] | undefined {
  const series = seriesBySignal[signal];
  return series?.mode === "raw" ? series.v : undefined;
}

vi.mock("../api", () => ({
  querySeries: vi.fn(),
}));

import { querySeries } from "../api";

const querySeriesMock = vi.mocked(querySeries);

describe("useSeriesData", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    querySeriesMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("debounces three rapid ranges into one latest-only fetch after 300ms", async () => {
    querySeriesMock.mockResolvedValue(seriesResponse("wfr26", "A", 1));
    const { result } = renderHook(() => useSeriesData());

    act(() => {
      result.current.requestRange("wfr26", ["A"], 0, 1000);
      result.current.requestRange("wfr26", ["A"], 0, 2000);
      result.current.requestRange("wfr26", ["A"], 0, 3000);
    });

    expect(querySeriesMock).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(299));
    expect(querySeriesMock).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));

    expect(querySeriesMock).toHaveBeenCalledTimes(1);
    expect(querySeriesMock.mock.calls[0][0]).toMatchObject({
      season: "wfr26",
      signals: ["A"],
      start: new Date(0).toISOString(),
      end: new Date(3000).toISOString(),
    });
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([1]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("serves an exact repeated range from cache without another fetch", async () => {
    querySeriesMock.mockResolvedValue(seriesResponse("cache-hit", "A", 7));
    const { result } = renderHook(() => useSeriesData());

    act(() => result.current.requestRange("cache-hit", ["A"], 10, 20));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(querySeriesMock).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);

    act(() => result.current.requestRange("cache-hit", ["A"], 10, 20));
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(querySeriesMock).toHaveBeenCalledTimes(1);
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([7]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("suppresses an older pending response after a newer request", async () => {
    const first = deferred<SeriesResponse>();
    const second = deferred<SeriesResponse>();
    querySeriesMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useSeriesData());

    act(() => result.current.requestRange("stale", ["A"], 0, 1000));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(querySeriesMock).toHaveBeenCalledTimes(1);

    act(() => result.current.requestRange("stale", ["A"], 0, 2000));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(querySeriesMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(seriesResponse("stale", "A", 1));
      await first.promise;
    });
    expect(result.current.seriesBySignal.A).toBeUndefined();

    await act(async () => {
      second.resolve(seriesResponse("stale", "A", 2));
      await second.promise;
    });
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([2]);
    expect(result.current.loading).toBe(false);
  });

  it("does not render A when A resolves after uncached B is scheduled but before B's timer", async () => {
    const first = deferred<SeriesResponse>();
    const second = deferred<SeriesResponse>();
    querySeriesMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useSeriesData());

    act(() => result.current.requestRange("race-uncached", ["A"], 0, 1000));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(querySeriesMock).toHaveBeenCalledTimes(1);

    act(() => result.current.requestRange("race-uncached", ["A"], 0, 2000));
    await act(async () => {
      first.resolve(seriesResponse("race-uncached", "A", 1));
      await first.promise;
    });
    expect(result.current.seriesBySignal.A).toBeUndefined();
    expect(querySeriesMock).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(querySeriesMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(seriesResponse("race-uncached", "A", 2));
      await second.promise;
    });
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([2]);
    expect(result.current.loading).toBe(false);
  });

  it("does not render A when A resolves after cached B is scheduled but before cache-hit timer", async () => {
    const inflightA = deferred<SeriesResponse>();
    querySeriesMock
      .mockResolvedValueOnce(seriesResponse("race-cached", "A", 20))
      .mockReturnValueOnce(inflightA.promise);

    const { result } = renderHook(() => useSeriesData());

    act(() => result.current.requestRange("race-cached", ["A"], 0, 2000));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([20]);
    expect(querySeriesMock).toHaveBeenCalledTimes(1);

    act(() => result.current.requestRange("race-cached", ["A"], 0, 1000));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(querySeriesMock).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([20]);

    act(() => result.current.requestRange("race-cached", ["A"], 0, 2000));
    await act(async () => {
      inflightA.resolve(seriesResponse("race-cached", "A", 1));
      await inflightA.promise;
    });
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([20]);
    expect(querySeriesMock).toHaveBeenCalledTimes(2);

    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(querySeriesMock).toHaveBeenCalledTimes(2);
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([20]);
    expect(result.current.loading).toBe(false);
  });

  it("retains prior seriesBySignal while a later range is loading", async () => {
    const second = deferred<SeriesResponse>();
    querySeriesMock
      .mockResolvedValueOnce(seriesResponse("retain", "A", 11))
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useSeriesData());

    act(() => result.current.requestRange("retain", ["A"], 100, 200));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([11]);

    act(() => result.current.requestRange("retain", ["A"], 100, 300));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(result.current.loading).toBe(true);
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([11]);

    await act(async () => {
      second.resolve(seriesResponse("retain", "A", 22));
      await second.promise;
    });
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([22]);
    expect(result.current.loading).toBe(false);
  });

  it("clears stale error immediately when a new range or retry is scheduled", async () => {
    const startMs = 1_000;
    const endMs = 2_000;
    const errorText = `TimescaleDB unavailable (${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()})`;
    querySeriesMock.mockRejectedValueOnce(new Error("TimescaleDB unavailable"));

    const { result } = renderHook(() => useSeriesData());

    act(() => result.current.requestRange("clear-err", ["A"], startMs, endMs));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(result.current.error).toBe(errorText);

    act(() => result.current.requestRange("clear-err", ["A"], startMs, endMs + 1));
    expect(result.current.error).toBeNull();

    querySeriesMock.mockRejectedValueOnce(new Error("TimescaleDB unavailable"));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(result.current.error).toBe(
      `TimescaleDB unavailable (${new Date(startMs).toISOString()} to ${new Date(endMs + 1).toISOString()})`,
    );

    act(() => result.current.retry());
    expect(result.current.error).toBeNull();
  });

  it("includes the request range in errors and retry repeats the latest request", async () => {
    const startMs = 1_000;
    const endMs = 2_000;
    querySeriesMock.mockRejectedValueOnce(new Error("TimescaleDB unavailable"));

    const { result } = renderHook(() => useSeriesData());

    act(() => result.current.requestRange("retry-me", ["A"], startMs, endMs));
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(result.current.error).toBe(
      `TimescaleDB unavailable (${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()})`,
    );
    expect(result.current.loading).toBe(false);
    expect(querySeriesMock).toHaveBeenCalledTimes(1);

    querySeriesMock.mockResolvedValueOnce(seriesResponse("retry-me", "A", 99));
    act(() => result.current.retry());
    expect(result.current.error).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(querySeriesMock).toHaveBeenCalledTimes(2);
    expect(querySeriesMock.mock.calls[1][0]).toMatchObject({
      season: "retry-me",
      signals: ["A"],
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    });
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([99]);
    expect(result.current.error).toBeNull();
  });

  it("retry after success serves the cached range without another network fetch", async () => {
    querySeriesMock.mockResolvedValueOnce(seriesResponse("retry-cache", "A", 5));
    const { result } = renderHook(() => useSeriesData());

    act(() => result.current.requestRange("retry-cache", ["A"], 50, 60));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(querySeriesMock).toHaveBeenCalledTimes(1);
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([5]);
    expect(result.current.error).toBeNull();

    act(() => result.current.retry());
    await act(() => vi.advanceTimersByTimeAsync(300));

    expect(querySeriesMock).toHaveBeenCalledTimes(1);
    expect(rawValues(result.current.seriesBySignal, "A")).toEqual([5]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("clears the debounce timer on unmount so no fetch runs", async () => {
    querySeriesMock.mockResolvedValue(seriesResponse("unmount", "A", 1));
    const { result, unmount } = renderHook(() => useSeriesData());

    act(() => result.current.requestRange("unmount", ["A"], 0, 5000));
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(500));

    expect(querySeriesMock).not.toHaveBeenCalled();
  });

  it("clear drops pending work and wipes series/error/loading", async () => {
    const pending = deferred<SeriesResponse>();
    querySeriesMock.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useSeriesData());

    act(() => result.current.requestRange("clear-me", ["A"], 0, 1000));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(result.current.loading).toBe(true);

    act(() => result.current.clear());
    expect(result.current.seriesBySignal).toEqual({});
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    await act(async () => {
      pending.resolve(seriesResponse("clear-me", "A", 9));
      await pending.promise;
    });
    expect(result.current.seriesBySignal).toEqual({});
    expect(querySeriesMock).toHaveBeenCalledTimes(1);
  });
});
