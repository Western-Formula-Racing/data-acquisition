import { useEffect, useMemo, useState } from "react";
import { useTimeline } from "../context/TimelineContext";

const TIMELINE_COLLAPSED_KEY = "pecan:timeline:collapsed";

function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function TimelineBar() {
  const {
    mode,
    selectedTimeMs,
    collectionStartMs,
    collectionEndMs,
    checkpoints,
    seek,
    goLive,
    addCheckpoint,
    deleteCheckpoint,
    clearCheckpoints,
    jumpToCheckpoint,
  } = useTimeline();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TIMELINE_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [hoveredCheckpointId, setHoveredCheckpointId] = useState<string | null>(null);

  const hasData = collectionStartMs !== null && collectionEndMs !== null;
  const durationMs = hasData ? Math.max(0, collectionEndMs - collectionStartMs) : 0;
  const sliderMin = collectionStartMs ?? 0;
  const sliderMax = collectionEndMs ?? 0;
  const sliderValue = hasData
    ? Math.max(sliderMin, Math.min(sliderMax, selectedTimeMs))
    : 0;

  const checkpointPercents = useMemo(() => {
    if (!hasData || durationMs <= 0) return [];
    return checkpoints.map((checkpoint) => {
      const relative = checkpoint.timeMs - (collectionStartMs ?? 0);
      const pct = Math.max(0, Math.min(100, (relative / durationMs) * 100));
      return { ...checkpoint, pct };
    });
  }, [checkpoints, collectionStartMs, durationMs, hasData]);

  const cursorCheckpointId = useMemo(() => {
    if (!hasData || checkpoints.length === 0) return null;
    const nearest = checkpoints.reduce<{ id: string; diff: number } | null>((acc, cp) => {
      const diff = Math.abs(cp.timeMs - sliderValue);
      if (!acc || diff < acc.diff) {
        return { id: cp.id, diff };
      }
      return acc;
    }, null);

    // Highlight only when cursor is effectively on a checkpoint (or very close).
    return nearest && nearest.diff <= 500 ? nearest.id : null;
  }, [checkpoints, hasData, sliderValue]);

  const activeCheckpointId = hoveredCheckpointId ?? cursorCheckpointId;

  useEffect(() => {
    localStorage.setItem(TIMELINE_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="app-submenu-title">TIMELINE</h3>
        <p className="text-xs text-slate-300 font-mono tracking-normal">
          {hasData
            ? `Span: ${formatDuration(durationMs)} (${formatClock(sliderMin)} to ${formatClock(
                sliderMax
              )})`
            : "Waiting for telemetry data..."}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={`timeline-chip ${
            mode === "live"
              ? "timeline-chip-live"
              : "timeline-chip-paused"
          }`}
        >
          {mode === "live" ? "LIVE" : "PAUSED"}
        </span>
        <button
          type="button"
          className="trace-btn trace-btn-subtle !text-[10px] !px-2 !py-1"
          onClick={() => setCollapsed((prev) => !prev)}
        >
          Collapse ▲
        </button>
      </div>
    </div>
  );

  if (collapsed) {
    return (
      <div className="sticky top-0 z-20 mb-2 flex justify-end">
        <button
          type="button"
          className="trace-btn trace-btn-subtle !text-[10px] !px-2 !py-1"
          onClick={() => setCollapsed(false)}
        >
          TIMELINE ▼
        </button>
      </div>
    );
  }

  return (
    <div className="bg-data-module-bg/92 rounded-md p-2.5 mb-2 border border-white/10 sticky top-0 z-20 backdrop-blur-[1px]">
      {header}

      <div className="flex items-center gap-1.5 mt-1.5 mb-1.5 flex-wrap">
        <button
          type="button"
          className="trace-btn trace-btn-primary !text-[10px] !px-2 !py-1"
          onClick={goLive}
          disabled={!hasData}
        >
          Return to Live
        </button>
        <button
          type="button"
          className="trace-btn trace-btn-success !text-[10px] !px-2 !py-1"
          onClick={() => addCheckpoint()}
          disabled={!hasData}
        >
          Add Checkpoint
        </button>
        <button
          type="button"
          className="trace-btn trace-btn-subtle !text-[10px] !px-2 !py-1"
          onClick={clearCheckpoints}
          disabled={checkpoints.length === 0}
        >
          Clear Checkpoints
        </button>
      </div>

      <div className="relative pt-3 pb-0.5">
        <div className="absolute inset-x-0 top-[13px] h-[1px] bg-white/12 rounded-full pointer-events-none" />
        <input
          type="range"
          min={sliderMin}
          max={Math.max(sliderMax, sliderMin + 1)}
          value={sliderValue}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!hasData}
          className="timeline-range timeline-range-trace w-full"
        />
        {hasData &&
          checkpointPercents.map((checkpoint) => (
            <button
              key={checkpoint.id}
              type="button"
              className={`timeline-checkpoint timeline-checkpoint-trace absolute top-[8px] -translate-x-1/2 opacity-90 ${
                activeCheckpointId === checkpoint.id ? "timeline-checkpoint-active" : ""
              }`}
              style={{ left: `${checkpoint.pct}%` }}
              onClick={() => jumpToCheckpoint(checkpoint.id)}
              onMouseEnter={() => setHoveredCheckpointId(checkpoint.id)}
              onMouseLeave={() => setHoveredCheckpointId(null)}
              title={`${checkpoint.label} (${formatClock(checkpoint.timeMs)})`}
            />
          ))}
      </div>

      <div className="mt-1.5 text-[10px] text-slate-300 font-mono tracking-normal">
        Cursor: {hasData ? formatClock(sliderValue) : "--:--:--"}
      </div>

      {checkpoints.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {checkpoints.map((checkpoint) => (
            <div
              key={checkpoint.id}
              className={`text-[10px] rounded px-1.5 py-1 flex items-center gap-1 border ${
                activeCheckpointId === checkpoint.id
                  ? "timeline-checkpoint-chip-active"
                  : "bg-white/5 text-slate-300 border-white/10"
              }`}
              onMouseEnter={() => setHoveredCheckpointId(checkpoint.id)}
              onMouseLeave={() => setHoveredCheckpointId(null)}
            >
              <button
                type="button"
                onClick={() => jumpToCheckpoint(checkpoint.id)}
                className={`font-medium ${activeCheckpointId === checkpoint.id ? "text-white" : "hover:text-white"}`}
              >
                {checkpoint.label} @ {formatClock(checkpoint.timeMs)}
              </button>
              <button
                type="button"
                onClick={() => deleteCheckpoint(checkpoint.id)}
                className="timeline-delete-checkpoint"
                title="Delete checkpoint"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default TimelineBar;
