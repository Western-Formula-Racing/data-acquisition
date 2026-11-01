import type { RunRecord } from "../types";

/** Convert a run's UTC bounds to millisecond timestamps. */
export function runRange(run: RunRecord): [number, number] {
  return [Date.parse(run.start_utc), Date.parse(run.end_utc)];
}

function isValidRange(startMs: number, endMs: number): boolean {
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs < endMs;
}

/**
 * Find another season whose indexed runs strictly overlap [startMs, endMs).
 * Excludes `currentSeason`. Returns null for invalid query ranges or no overlap.
 */
export function findSeasonWithData(
  runsBySeason: Record<string, RunRecord[]>,
  startMs: number,
  endMs: number,
  currentSeason: string,
): string | null {
  if (!isValidRange(startMs, endMs)) {
    return null;
  }

  for (const [season, runs] of Object.entries(runsBySeason)) {
    if (season === currentSeason) continue;

    const overlaps = runs.some((r) => {
      const runStart = Date.parse(r.start_utc);
      const runEnd = Date.parse(r.end_utc);
      if (!Number.isFinite(runStart) || !Number.isFinite(runEnd)) {
        return false;
      }
      return runStart < endMs && runEnd > startMs;
    });

    if (overlaps) return season;
  }

  return null;
}
