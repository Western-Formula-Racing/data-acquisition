import type { SignalSeries } from "../types";

export type SeriesMap = Record<string, SignalSeries>;

const CLIENT_POINT_BUDGET = 1_000_000;
const MAX_TARGET_POINTS = 20_000;

export function targetPointsFor(signalCount: number): number {
  if (signalCount <= 0) return 0;
  // Cap per-request density so the client stays within its shared point budget.
  return Math.min(MAX_TARGET_POINTS, Math.floor(CLIENT_POINT_BUDGET / signalCount));
}

export function seriesCacheKey(
  season: string,
  signals: string[],
  startMs: number,
  endMs: number,
  targetPoints: number,
): string {
  // Sort signals so cache hits ignore selection order while keeping exact ranges.
  return JSON.stringify([season, [...signals].sort(), startMs, endMs, targetPoints]);
}

function representedPoints(series: SeriesMap): number {
  return Object.values(series).reduce((sum, item) => sum + item.point_count, 0);
}

export class SeriesCache {
  private readonly entries = new Map<string, { value: SeriesMap; points: number }>();
  private points = 0;

  constructor(private readonly budget = CLIENT_POINT_BUDGET) {}

  get(key: string): SeriesMap | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Re-insert to mark this key as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: SeriesMap): void {
    const points = representedPoints(value);
    // Reject oversize inserts before mutating so useful entries stay cached.
    if (points > this.budget) return;

    const prior = this.entries.get(key);
    if (prior) this.points -= prior.points;
    this.entries.delete(key);
    this.entries.set(key, { value, points });
    this.points += points;
    while (this.points > this.budget && this.entries.size > 0) {
      const oldest = this.entries.entries().next().value as
        | [string, { value: SeriesMap; points: number }]
        | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.points -= oldest[1].points;
    }
  }
}
