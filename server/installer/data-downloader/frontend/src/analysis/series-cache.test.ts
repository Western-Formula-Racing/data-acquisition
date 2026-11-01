import { describe, expect, it } from "vitest";
import { SeriesCache, seriesCacheKey, targetPointsFor } from "./series-cache";

function rawSeries(pointCount: number) {
  return {
    mode: "raw" as const,
    resolution_ms: null,
    point_count: pointCount,
    t: Array.from({ length: pointCount }, (_, i) => i),
    v: Array.from({ length: pointCount }, (_, i) => i),
  };
}

describe("series cache", () => {
  it("makes signal order irrelevant and preserves exact range", () => {
    expect(seriesCacheKey("wfr26", ["B", "A"], 1, 2, 4000)).toBe(
      seriesCacheKey("wfr26", ["A", "B"], 1, 2, 4000),
    );
  });

  it("keys differ by exact range and target", () => {
    const base = seriesCacheKey("wfr26", ["A"], 1, 2, 4000);
    expect(seriesCacheKey("wfr26", ["A"], 1, 3, 4000)).not.toBe(base);
    expect(seriesCacheKey("wfr26", ["A"], 0, 2, 4000)).not.toBe(base);
    expect(seriesCacheKey("wfr26", ["A"], 1, 2, 5000)).not.toBe(base);
  });

  it("evicts least-recently-used entries to stay under budget", () => {
    const cache = new SeriesCache(3);
    cache.set("a", { A: rawSeries(2) });
    cache.set("b", { B: rawSeries(2) });
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
  });

  it("promotes an entry to most-recently-used on read", () => {
    const cache = new SeriesCache(4);
    cache.set("a", { A: rawSeries(2) });
    cache.set("b", { B: rawSeries(2) });
    expect(cache.get("a")).toBeDefined();
    cache.set("c", { C: rawSeries(2) });
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("accounts for replacement points when updating the same key", () => {
    const cache = new SeriesCache(5);
    cache.set("a", { A: rawSeries(3) });
    cache.set("a", { A: rawSeries(1) });
    cache.set("b", { B: rawSeries(4) });
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeDefined();
  });

  it("rejects an oversize insert without mutating the cache", () => {
    const cache = new SeriesCache(3);
    cache.set("a", { A: rawSeries(2) });
    cache.set("oversize", { X: rawSeries(4) });
    expect(cache.get("a")).toEqual({ A: rawSeries(2) });
    expect(cache.get("oversize")).toBeUndefined();
  });

  it("preserves the prior same-key value when a replacement is oversize", () => {
    const cache = new SeriesCache(3);
    const prior = { A: rawSeries(2) };
    cache.set("a", prior);
    cache.set("a", { A: rawSeries(4) });
    expect(cache.get("a")).toEqual(prior);
  });

  it("shares the million-point budget across signals", () => {
    expect(targetPointsFor(1)).toBe(20_000);
    expect(targetPointsFor(12)).toBeLessThanOrEqual(Math.floor(1_000_000 / 12));
  });
});
