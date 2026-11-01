import type { StatesResponse } from "../types";

export type Severity = "ok" | "transitional" | "fault" | "unknown";

// VCU_State_Info.State: 4 DRIVE is healthy, 5 PRECHARGE_ERROR and
// 6 DEVICE_FAULT are faults, everything else is startup/transitional.
const CAR_SEVERITY: Record<number, Severity> = {
  0: "transitional",
  1: "transitional",
  2: "transitional",
  3: "transitional",
  4: "ok",
  5: "fault",
  6: "fault",
};

// INV_VSM_State: 6 Motor Running is healthy, 7 Blink Fault Code is a fault,
// precharge/wait/ready/shutdown/reset are transitional.
const VSM_SEVERITY: Record<number, Severity> = {
  0: "transitional",
  1: "transitional",
  2: "transitional",
  3: "transitional",
  4: "transitional",
  5: "transitional",
  6: "ok",
  7: "fault",
  14: "transitional",
  15: "transitional",
};

export function severityFor(laneId: string, value: number): Severity {
  const map = laneId === "car" ? CAR_SEVERITY : laneId === "inverter" ? VSM_SEVERITY : null;
  return map?.[value] ?? "unknown";
}

export interface SegmentBox {
  leftPct: number;
  widthPct: number;
}

const MIN_SEGMENT_WIDTH_PCT = 0.4;

export function segmentBox(
  startMs: number,
  endMs: number,
  view: [number, number],
): SegmentBox | null {
  const [viewStart, viewEnd] = view;
  const span = viewEnd - viewStart;
  if (!(span > 0) || endMs <= viewStart || startMs >= viewEnd) return null;
  const left = (Math.max(startMs, viewStart) - viewStart) / span;
  const right = (Math.min(endMs, viewEnd) - viewStart) / span;
  return {
    leftPct: left * 100,
    widthPct: Math.max((right - left) * 100, MIN_SEGMENT_WIDTH_PCT),
  };
}

export const MIN_ZOOM_SPAN_MS = 1000;

export function padRange(startMs: number, endMs: number): [number, number] {
  const span = endMs - startMs;
  if (span >= MIN_ZOOM_SPAN_MS) return [startMs, endMs];
  const pad = (MIN_ZOOM_SPAN_MS - span) / 2;
  return [startMs - pad, endMs + pad];
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (totalMinutes < 60) return `${totalMinutes} m ${seconds} s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours} h ${totalMinutes % 60} m`;
}

export function faultNamesAt(data: StatesResponse, startMs: number, endMs: number): string[] {
  const names: string[] = [];
  for (const fault of data.faults) {
    if (fault.segments.some((seg) => seg.start_ms < endMs && seg.end_ms > startMs)) {
      names.push(fault.name);
    }
  }
  return names;
}
