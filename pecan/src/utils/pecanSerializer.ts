import type {
  ReplayDecodeMetadata,
  ReplayFrame,
  ReplayFrameTuple,
  ReplayPlotsMetadata,
  ReplaySession,
  ReplayTimelineMetadata,
} from "../types/replay";

function frameToTuple(frame: ReplayFrame): ReplayFrameTuple {
  const flags = (frame.isExtended ? 1 : 0) | (frame.direction === "tx" ? 2 : 0);
  return [frame.tRelMs, frame.canId, flags, frame.dataHex];
}

export interface SerializeOptions {
  frames: ReplayFrame[];
  epochBaseMs?: number;
  decode?: ReplayDecodeMetadata;
  timeline?: ReplayTimelineMetadata;
  plots?: ReplayPlotsMetadata;
}

/**
 * Serializes frames to the compact v2 .pecan format (list-of-lists).
 * ~7x smaller than the v1 named-object format.
 */
export function serializePecanV2(opts: SerializeOptions): string {
  const session: ReplaySession = {
    format: "pecan-session",
    version: 2,
    columns: ["tRelMs", "canId", "flags", "dataHex"],
    epochBaseMs: opts.epochBaseMs,
    frames: opts.frames.map(frameToTuple),
    decode: opts.decode,
    timeline: opts.timeline,
    plots: opts.plots,
  };

  // Strip undefined top-level keys so JSON output is clean
  const clean: Record<string, unknown> = { format: session.format, version: session.version, columns: session.columns };
  if (session.epochBaseMs !== undefined) clean.epochBaseMs = session.epochBaseMs;
  clean.frames = session.frames;
  if (session.decode) clean.decode = session.decode;
  if (session.timeline) clean.timeline = session.timeline;
  if (session.plots) clean.plots = session.plots;

  return JSON.stringify(clean);
}
