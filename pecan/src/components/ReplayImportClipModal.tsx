import { useMemo, useState } from "react";
import type { ReplayFrame } from "../types/replay";
import { REPLAY_FRAME_HARD_CAP } from "../utils/replayParser";

interface ReplayImportClipModalProps {
  frames: ReplayFrame[];
  fileName: string;
  onCancel: () => void;
  onConfirm: (framesToLoad: ReplayFrame[]) => void;
}

export default function ReplayImportClipModal({
  frames,
  fileName,
  onCancel,
  onConfirm,
}: ReplayImportClipModalProps) {
  const minRel = useMemo(
    () => frames.reduce((min, f) => Math.min(min, f.tRelMs), Number.POSITIVE_INFINITY),
    [frames]
  );
  const maxRel = useMemo(
    () => frames.reduce((max, f) => Math.max(max, f.tRelMs), Number.NEGATIVE_INFINITY),
    [frames]
  );

  const [startMs, setStartMs] = useState<number>(Math.round(minRel));
  const [endMs, setEndMs] = useState<number>(Math.round(maxRel));

  const duration = Math.max(1, maxRel - minRel);
  const startPct = Math.max(0, Math.min(100, ((Math.min(startMs, endMs) - minRel) / duration) * 100));
  const endPct = Math.max(0, Math.min(100, ((Math.max(startMs, endMs) - minRel) / duration) * 100));

  const sliderMin = Math.round(minRel);
  const sliderMax = Math.round(maxRel);

  const handleStartChange = (value: number) => {
    setStartMs(Math.max(sliderMin, Math.min(endMs, value)));
  };
  const handleEndChange = (value: number) => {
    setEndMs(Math.min(sliderMax, Math.max(startMs, value)));
  };

  const runClipImport = () => {
    const clipStart = Math.min(startMs, endMs);
    const clipEnd = Math.max(startMs, endMs);
    const clipped = frames.filter((f) => f.tRelMs >= clipStart && f.tRelMs <= clipEnd);
    if (clipped.length === 0) {
      window.alert("No frames in selected range. Expand the range.");
      return;
    }
    if (clipped.length > REPLAY_FRAME_HARD_CAP) {
      const confirmed = window.confirm(
        `Selected range has ${clipped.length.toLocaleString()} frames (limit ${REPLAY_FRAME_HARD_CAP.toLocaleString()}).\n` +
        "Use manual override to import the full selected range anyway?\n" +
        "Browser may show this page as frozen while importing. Please allow extra time before force closing the tab."
      );
      if (!confirmed) return;
      onConfirm(clipped);
      return;
    }
    onConfirm(clipped);
  };

  const runManualOverride = () => {
    const confirmed = window.confirm(
      `Manual override: import ALL ${frames.length.toLocaleString()} frames?\n` +
      "Browser may show this page as frozen while importing. Please allow extra time before force closing the tab."
    );
    if (!confirmed) return;
    onConfirm(frames);
  };

  return (
    <div className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-[1px] flex items-start justify-center p-4 pt-16">
      <div className="w-full max-w-2xl rounded-lg border border-white/10 bg-data-module-bg p-4 shadow-2xl">
        <h3 className="app-section-title">Clip Replay Import</h3>
        <p className="mt-2 text-xs text-slate-300">
          {fileName}: {frames.length.toLocaleString()} frames exceeds cap of {REPLAY_FRAME_HARD_CAP.toLocaleString()}.
          Choose a timestamp range like Timeline clipping, or use manual override.
        </p>
        <p className="mt-1 text-xs font-mono text-slate-400">
          t_rel_ms range: {sliderMin.toLocaleString()} - {sliderMax.toLocaleString()}
        </p>

        <div className="mt-4">
          <div className="relative pt-3 pb-0.5">
            <div className="absolute inset-x-0 top-[13px] h-[1px] bg-white/12 rounded-full pointer-events-none" />
            <div
              className="absolute top-[9px] h-[8px] rounded bg-orange-400/30 border border-orange-300/55 pointer-events-none"
              style={{
                left: `${Math.min(startPct, endPct)}%`,
                width: `${Math.max(1, Math.abs(endPct - startPct))}%`,
              }}
            />
            <input
              type="range"
              min={sliderMin}
              max={Math.max(sliderMax, sliderMin + 1)}
              value={startMs}
              onChange={(e) => handleStartChange(Number(e.target.value))}
              step={1}
              className="timeline-range timeline-range-clip timeline-range-clip-start absolute inset-x-0 top-0 z-20 w-full"
            />
            <input
              type="range"
              min={sliderMin}
              max={Math.max(sliderMax, sliderMin + 1)}
              value={endMs}
              onChange={(e) => handleEndChange(Number(e.target.value))}
              step={1}
              className="timeline-range timeline-range-clip timeline-range-clip-end absolute inset-x-0 top-0 z-20 w-full"
            />
            <div className="h-6" />
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-slate-300">
            <span>Start: {startMs.toLocaleString()}</span>
            <span>End: {endMs.toLocaleString()}</span>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2 justify-end">
          <button type="button" className="trace-btn trace-btn-subtle !text-[10px] !px-2 !py-1" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="trace-btn trace-btn-warning !text-[10px] !px-2 !py-1" onClick={runManualOverride}>
            Manual Override
          </button>
          <button type="button" className="trace-btn trace-btn-primary !text-[10px] !px-2 !py-1" onClick={runClipImport}>
            Import Clipped Range
          </button>
        </div>
      </div>
    </div>
  );
}
