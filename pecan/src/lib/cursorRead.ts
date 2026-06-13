/**
 * Cursor-aware DataStore reads.
 *
 * When the timeline is paused/scrubbing (mode === "paused"), every panel should
 * reflect the value *at the selected cursor time* rather than the newest sample.
 * These helpers centralize that branch so imperative readers (accumulator stats,
 * charging curve, etc.) stay consistent with the reactive hooks.
 */
import { dataStore, type TelemetrySample, type TelemetrySource } from "./DataStore";

export type CursorMode = "live" | "paused";

/** Latest sample for a message, clipped to the cursor when paused. */
export function readLatest(
  msgID: string,
  mode: CursorMode,
  cursorMs: number,
  source?: TelemetrySource
): TelemetrySample | undefined {
  return mode === "paused"
    ? dataStore.getLatestAt(msgID, cursorMs, source)
    : dataStore.getLatest(msgID, source);
}

/** History window for a message, ending at the cursor when paused. */
export function readHistory(
  msgID: string,
  windowMs: number | undefined,
  mode: CursorMode,
  cursorMs: number,
  source?: TelemetrySource
): TelemetrySample[] {
  if (mode === "paused") {
    return dataStore.getHistoryAt(
      msgID,
      windowMs ?? dataStore.getRetentionWindow(),
      cursorMs,
      source
    );
  }
  return dataStore.getHistory(msgID, windowMs, source);
}
