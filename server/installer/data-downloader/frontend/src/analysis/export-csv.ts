import type { SignalSeries } from "../types";
import type { SeriesMap } from "./series-cache";

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

interface ColumnSpec {
  header: string;
  values: Map<number, number>;
}

function columnsForSignal(signal: string, series: SignalSeries): ColumnSpec[] {
  if (series.mode === "raw") {
    const values = new Map<number, number>();
    for (let i = 0; i < series.t.length; i++) {
      values.set(series.t[i], series.v[i]);
    }
    return [{ header: signal, values }];
  }

  const avg = new Map<number, number>();
  const min = new Map<number, number>();
  const max = new Map<number, number>();
  for (let i = 0; i < series.t.length; i++) {
    const t = series.t[i];
    avg.set(t, series.avg[i]);
    min.set(t, series.min[i]);
    max.set(t, series.max[i]);
  }
  // Header order matches the product contract: avg, min, max.
  return [
    { header: `${signal}_avg`, values: avg },
    { header: `${signal}_min`, values: min },
    { header: `${signal}_max`, values: max },
  ];
}

/**
 * Merge loaded series into a CSV string keyed by exact numeric timestamps.
 * Signal iteration order follows `Object.keys(seriesBySignal)`.
 */
export function seriesToCsv(seriesBySignal: SeriesMap): {
  csv: string;
  containsEnvelope: boolean;
} {
  const columns: ColumnSpec[] = [];
  let containsEnvelope = false;
  const timestamps = new Set<number>();

  for (const [signal, series] of Object.entries(seriesBySignal)) {
    if (series.mode === "envelope") containsEnvelope = true;
    for (const col of columnsForSignal(signal, series)) {
      columns.push(col);
      for (const t of col.values.keys()) timestamps.add(t);
    }
  }

  const sortedTimes = [...timestamps].sort((a, b) => a - b);
  const header = ["time_utc", ...columns.map((c) => escapeCsvField(c.header))].join(",");
  const rows = sortedTimes.map((t) => {
    const cells = [
      new Date(t).toISOString(),
      ...columns.map((c) => {
        const value = c.values.get(t);
        return value === undefined ? "" : String(value);
      }),
    ];
    return cells.join(",");
  });

  return {
    csv: [header, ...rows].join("\n"),
    containsEnvelope,
  };
}

/** Make a filesystem-safe filename fragment from an ISO / season string. */
export function safeFilenamePart(value: string): string {
  return value.replace(/[:/\\?%*|<>"]/g, "-").replace(/\s+/g, "_");
}

export function seriesCsvFilename(season: string, startMs: number, endMs: number): string {
  const start = safeFilenamePart(new Date(startMs).toISOString());
  const end = safeFilenamePart(new Date(endMs).toISOString());
  return `${safeFilenamePart(season)}_${start}_${end}.csv`;
}

/** Trigger a browser download for the current series map; always revokes the blob URL. */
export function downloadSeriesCsv(
  seriesBySignal: SeriesMap,
  season: string,
  startMs: number,
  endMs: number,
): void {
  const { csv } = seriesToCsv(seriesBySignal);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = seriesCsvFilename(season, startMs, endMs);
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
