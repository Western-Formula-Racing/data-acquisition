import { afterEach, describe, expect, it, vi } from "vitest";

import type { SignalSeries } from "../types";
import { downloadSeriesCsv, seriesToCsv } from "./export-csv";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("seriesToCsv", () => {
  it("merges non-aligned raw timestamps sorted by exact numeric keys", () => {
    const seriesBySignal: Record<string, SignalSeries> = {
      A: {
        mode: "raw",
        resolution_ms: null,
        point_count: 2,
        t: [0, 1000],
        v: [1, 2],
      },
      B: {
        mode: "raw",
        resolution_ms: null,
        point_count: 1,
        t: [1000],
        v: [9],
      },
    };

    const { csv, containsEnvelope } = seriesToCsv(seriesBySignal);
    expect(containsEnvelope).toBe(false);
    expect(csv).toBe(
      [
        "time_utc,A,B",
        "1970-01-01T00:00:00.000Z,1,",
        "1970-01-01T00:00:01.000Z,2,9",
      ].join("\n"),
    );
  });

  it("emits avg/min/max envelope columns and flags containsEnvelope", () => {
    const seriesBySignal: Record<string, SignalSeries> = {
      A: {
        mode: "envelope",
        resolution_ms: 1000,
        point_count: 2,
        t: [0, 1000],
        avg: [1.5, 2.5],
        min: [1, 2],
        max: [2, 3],
      },
    };

    const { csv, containsEnvelope } = seriesToCsv(seriesBySignal);
    expect(containsEnvelope).toBe(true);
    expect(csv).toBe(
      [
        "time_utc,A_avg,A_min,A_max",
        "1970-01-01T00:00:00.000Z,1.5,1,2",
        "1970-01-01T00:00:01.000Z,2.5,2,3",
      ].join("\n"),
    );
  });

  it("escapes headers that contain commas, quotes, or newlines", () => {
    const seriesBySignal: Record<string, SignalSeries> = {
      'weird,"name"\n': {
        mode: "raw",
        resolution_ms: null,
        point_count: 1,
        t: [0],
        v: [1],
      },
    };

    const { csv } = seriesToCsv(seriesBySignal);
    // Quoted header may embed a literal newline; assert the escaped field, not split lines.
    expect(csv.startsWith('time_utc,"weird,""name""\n"\n')).toBe(true);
    expect(csv).toContain("1970-01-01T00:00:00.000Z,1");
  });
});

describe("downloadSeriesCsv", () => {
  it("creates a blob download and revokes the object URL", () => {
    const click = vi.fn();
    const revokeObjectURL = vi.fn();
    const createObjectURL = vi.fn(() => "blob:mock-url");

    vi.stubGlobal("URL", {
      createObjectURL,
      revokeObjectURL,
    });

    const anchor = {
      href: "",
      download: "",
      click,
    } as unknown as HTMLAnchorElement;
    const createElement = vi.spyOn(document, "createElement").mockReturnValue(anchor);

    downloadSeriesCsv(
      {
        A: {
          mode: "raw",
          resolution_ms: null,
          point_count: 1,
          t: [0],
          v: [1],
        },
      },
      "wfr26",
      Date.parse("2026-06-20T15:00:00.000Z"),
      Date.parse("2026-06-20T16:00:00.000Z"),
    );

    expect(createElement).toHaveBeenCalledWith("a");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchor.href).toBe("blob:mock-url");
    expect(anchor.download).toBe(
      "wfr26_2026-06-20T15-00-00.000Z_2026-06-20T16-00-00.000Z.csv",
    );
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });
});
