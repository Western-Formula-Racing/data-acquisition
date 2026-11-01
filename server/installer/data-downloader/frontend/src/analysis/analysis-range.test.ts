import { describe, expect, it } from "vitest";
import { findSeasonWithData, runRange } from "./analysis-range";
import type { RunRecord } from "../types";

function run(partial: Partial<RunRecord> & Pick<RunRecord, "start_utc" | "end_utc">): RunRecord {
  const { start_utc, end_utc } = partial;
  return {
    bins: 1,
    timezone: "UTC",
    start_local: start_utc,
    end_local: end_utc,
    key: `${start_utc}_${end_utc}`,
    ...partial,
    start_utc,
    end_utc,
  };
}

describe("runRange", () => {
  it("converts run UTC timestamps to millisecond bounds", () => {
    const record = run({
      start_utc: "2026-04-12T10:00:00+00:00",
      end_utc: "2026-04-12T11:00:00+00:00",
    });
    expect(runRange(record)).toEqual([
      Date.parse("2026-04-12T10:00:00Z"),
      Date.parse("2026-04-12T11:00:00Z"),
    ]);
  });
});

describe("findSeasonWithData", () => {
  const runsBySeason: Record<string, RunRecord[]> = {
    wfr25: [run({ start_utc: "2025-09-09T03:00:00+00:00", end_utc: "2025-09-09T04:00:00+00:00" })],
    wfr26: [run({ start_utc: "2026-04-12T10:00:00+00:00", end_utc: "2026-04-12T11:00:00+00:00" })],
  };

  it("finds a season whose runs strictly overlap the window", () => {
    const start = Date.parse("2025-09-09T03:21:08Z");
    const end = Date.parse("2025-09-09T03:23:38Z");
    expect(findSeasonWithData(runsBySeason, start, end, "wfr26")).toBe("wfr25");
  });

  it("uses strict overlap (touching endpoints do not count)", () => {
    const start = Date.parse("2025-09-09T04:00:00Z");
    const end = Date.parse("2025-09-09T05:00:00Z");
    expect(findSeasonWithData(runsBySeason, start, end, "wfr26")).toBeNull();
  });

  it("excludes the current season even when it overlaps", () => {
    const start = Date.parse("2026-04-12T10:15:00Z");
    const end = Date.parse("2026-04-12T10:45:00Z");
    expect(findSeasonWithData(runsBySeason, start, end, "wfr26")).toBeNull();
  });

  it("returns null when the query range is invalid", () => {
    const start = Date.parse("2025-09-09T03:21:08Z");
    const end = Date.parse("2025-09-09T03:23:38Z");
    expect(findSeasonWithData(runsBySeason, Number.NaN, end, "wfr26")).toBeNull();
    expect(findSeasonWithData(runsBySeason, start, Number.NaN, "wfr26")).toBeNull();
    expect(findSeasonWithData(runsBySeason, end, start, "wfr26")).toBeNull();
    expect(findSeasonWithData(runsBySeason, start, start, "wfr26")).toBeNull();
  });

  it("skips runs with invalid timestamps and keeps scanning", () => {
    const withBad = {
      wfr25: [
        run({ key: "bad", start_utc: "not-a-date", end_utc: "also-bad" }),
        run({ start_utc: "2025-09-09T03:00:00+00:00", end_utc: "2025-09-09T04:00:00+00:00" }),
      ],
      wfr26: runsBySeason.wfr26,
    };
    const start = Date.parse("2025-09-09T03:21:08Z");
    const end = Date.parse("2025-09-09T03:23:38Z");
    expect(findSeasonWithData(withBad, start, end, "wfr26")).toBe("wfr25");
  });

  it("returns null when nothing overlaps", () => {
    const start = Date.parse("2024-01-01T00:00:00Z");
    const end = Date.parse("2024-01-02T00:00:00Z");
    expect(findSeasonWithData(runsBySeason, start, end, "wfr26")).toBeNull();
  });
});
