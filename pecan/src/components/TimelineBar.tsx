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

  useEffect(() => {
    localStorage.setItem(TIMELINE_COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 className="text-white font-semibold">Timeline Since Data Collection</h3>
        <p className="text-xs text-slate-300">
          {hasData
            ? `Span: ${formatDuration(durationMs)} (${formatClock(sliderMin)} to ${formatClock(
                sliderMax
              )})`
            : "Waiting for telemetry data..."}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span
          className={`text-xs px-2 py-1 rounded ${
            mode === "live"
              ? "bg-green-500/20 text-green-300"
              : "bg-amber-500/20 text-amber-300"
          }`}
        >
          {mode === "live" ? "LIVE" : "PAUSED"}
        </span>
        <button
          type="button"
          className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white"
          onClick={() => setCollapsed((prev) => !prev)}
        >
          {collapsed ? "Expand" : "Collapse"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="bg-data-module-bg rounded-md p-3 mb-3 border border-white/10 sticky top-0 z-20">
      {header}

      {collapsed ? (
        <div className="mt-2 text-xs text-slate-300">
          Cursor: {hasData ? formatClock(sliderValue) : "--:--:--"}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 mt-2 mb-2">
            <button
              type="button"
              className="text-xs px-2 py-1 rounded bg-blue-600/80 hover:bg-blue-500 text-white"
              onClick={goLive}
              disabled={!hasData}
            >
              Return to Live
            </button>
            <button
              type="button"
              className="text-xs px-2 py-1 rounded bg-emerald-700/80 hover:bg-emerald-600 text-white"
              onClick={() => addCheckpoint()}
              disabled={!hasData}
            >
              Add Checkpoint
            </button>
            <button
              type="button"
              className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-white"
              onClick={clearCheckpoints}
              disabled={checkpoints.length === 0}
            >
              Clear Checkpoints
            </button>
          </div>

          <div className="relative pt-4">
            <input
              type="range"
              min={sliderMin}
              max={Math.max(sliderMax, sliderMin + 1)}
              value={sliderValue}
              onChange={(e) => seek(Number(e.target.value))}
              disabled={!hasData}
              className="w-full accent-blue-500"
            />
            {hasData &&
              checkpointPercents.map((checkpoint) => (
                <button
                  key={checkpoint.id}
                  type="button"
                  className="absolute top-0 -translate-x-1/2 text-[10px] px-1 py-0.5 rounded bg-amber-500/80 text-black hover:bg-amber-400"
                  style={{ left: `${checkpoint.pct}%` }}
                  onClick={() => jumpToCheckpoint(checkpoint.id)}
                  title={`${checkpoint.label} (${formatClock(checkpoint.timeMs)})`}
                >
                  |
                </button>
              ))}
          </div>

          <div className="mt-2 text-xs text-slate-300">
            Cursor: {hasData ? formatClock(sliderValue) : "--:--:--"}
          </div>

          {checkpoints.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {checkpoints.map((checkpoint) => (
                <div
                  key={checkpoint.id}
                  className="text-xs bg-data-textbox-bg text-slate-200 rounded px-2 py-1 flex items-center gap-1"
                >
                  <button
                    type="button"
                    onClick={() => jumpToCheckpoint(checkpoint.id)}
                    className="hover:text-white"
                  >
                    {checkpoint.label} @ {formatClock(checkpoint.timeMs)}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteCheckpoint(checkpoint.id)}
                    className="text-red-300 hover:text-red-200"
                    title="Delete checkpoint"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default TimelineBar;
