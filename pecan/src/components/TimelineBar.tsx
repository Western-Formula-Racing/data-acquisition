import { useEffect, useMemo, useRef, useState } from "react";
import { useTimeline } from "../context/TimelineContext";
import { dataStore, type TelemetrySample } from "../lib/DataStore";
import { coldStore } from "../lib/ColdStore";
import type { ReplayFrame, ReplayPlotLayout } from "../types/replay";
import { parseReplayFile, REPLAY_FRAME_HARD_CAP } from "../utils/replayParser";
import { serializePecanV2 } from "../utils/pecanSerializer";
import ReplayImportClipModal from "./ReplayImportClipModal";

interface TimelineBarProps {
  plotLayouts?: ReplayPlotLayout[];
}

const TIMELINE_COLLAPSED_KEY = "pecan:timeline:collapsed";

function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatClockPrecise(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatLocalTimestamp(ts: number): string {
  const d = new Date(ts);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  const tzOffsetMin = -d.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? "+" : "-";
  const tzAbs = Math.abs(tzOffsetMin);
  const tzH = String(Math.floor(tzAbs / 60)).padStart(2, "0");
  const tzM = String(tzAbs % 60).padStart(2, "0");
  return `${yy}-${mm}-${dd}T${hh}:${mi}:${ss}.${ms}${sign}${tzH}:${tzM}`;
}

function formatLocalFilenameTimestamp(ts: number): string {
  const d = new Date(ts);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yy}-${mm}-${dd}_${hh}-${mi}-${ss}`;
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

function parseCanIdToNumber(msgID: string): number {
  const trimmed = msgID.trim().toLowerCase();
  if (trimmed.startsWith("0x")) {
    return Number.parseInt(trimmed.slice(2), 16);
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function rawDataToHex(rawData: string): string {
  return rawData.replace(/\s+/g, "").toLowerCase();
}

function sampleToReplayFrame(sample: TelemetrySample, exportStartMs: number): ReplayFrame {
  const canId = parseCanIdToNumber(sample.msgID);
  const dataHex = rawDataToHex(sample.rawData);
  const dlc = sample.rawData.split(" ").filter(Boolean).length;

  return {
    tRelMs: Math.max(0, sample.timestamp - exportStartMs),
    tEpochMs: sample.timestamp,
    tLocalTime: formatLocalTimestamp(sample.timestamp),
    canId,
    isExtended: canId > 0x7ff,
    direction: sample.direction ?? "rx",
    dlc,
    dataHex,
    source: "timeline-export",
  };
}

function TimelineBar({ plotLayouts = [] }: TimelineBarProps) {
  const {
    source,
    mode,
    selectedTimeMs,
    collectionStartMs,
    collectionEndMs,
    latestLiveDataMs,
    checkpoints,
    seek,
    goLive,
    loadReplayFrames,
    clearReplaySession,
    addCheckpoint,
    deleteCheckpoint,
    clearCheckpoints,
    jumpToCheckpoint,
    replaySession,
    windowMs,
    isColdLoading,
    coldWarning,
    dismissColdWarning,
  } = useTimeline();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(TIMELINE_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [hoveredCheckpointId, setHoveredCheckpointId] = useState<string | null>(null);
  const [clipModeEnabled, setClipModeEnabled] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportStartMs, setExportStartMs] = useState<number | null>(null);
  const [exportEndMs, setExportEndMs] = useState<number | null>(null);
  const [isImportingReplay, setIsImportingReplay] = useState(false);
  const [pendingClipImport, setPendingClipImport] = useState<{
    frames: ReplayFrame[];
    fileName: string;
    timelineMeta?: Parameters<typeof loadReplayFrames>[2];
    plotsMeta?: Parameters<typeof loadReplayFrames>[3];
  } | null>(null);
  const replayFileInputRef = useRef<HTMLInputElement | null>(null);
  const showColdStoreSupportHint = source === "live" && !dataStore.isColdStoreSupported();

  const hasData = collectionStartMs !== null && collectionEndMs !== null;
  const durationMs = hasData ? Math.max(0, collectionEndMs - collectionStartMs) : 0;
  const sliderMin = collectionStartMs ?? 0;
  const sliderMax = collectionEndMs ?? 0;
  const sliderValue = hasData
    ? Math.max(sliderMin, Math.min(sliderMax, selectedTimeMs))
    : 0;

  useEffect(() => {
    if (!hasData) {
      setExportStartMs(null);
      setExportEndMs(null);
      return;
    }

    if (!clipModeEnabled) {
      setExportStartMs(null);
      setExportEndMs(null);
      return;
    }

    setExportStartMs((prev) => {
      if (prev === null) return sliderMin;
      return Math.max(sliderMin, Math.min(sliderMax, prev));
    });

    setExportEndMs((prev) => {
      if (prev === null) return sliderMax;
      return Math.max(sliderMin, Math.min(sliderMax, prev));
    });
  }, [hasData, sliderMin, sliderMax, clipModeEnabled]);

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

  const tickMarks = useMemo(() => {
    if (!hasData) return [];
    const count = 5;
    return Array.from({ length: count }, (_, idx) => {
      const ratio = idx / (count - 1);
      const timeMs = sliderMin + ratio * (sliderMax - sliderMin);
      return {
        key: idx,
        label: formatClock(Math.round(timeMs)),
      };
    });
  }, [hasData, sliderMin, sliderMax]);

  const exportStartPct = useMemo(() => {
    if (!hasData || durationMs <= 0 || exportStartMs === null || exportEndMs === null) return null;
    const clipStartMs = Math.min(exportStartMs, exportEndMs);
    return Math.max(0, Math.min(100, ((clipStartMs - sliderMin) / durationMs) * 100));
  }, [hasData, durationMs, exportStartMs, exportEndMs, sliderMin]);

  const exportEndPct = useMemo(() => {
    if (!hasData || durationMs <= 0 || exportStartMs === null || exportEndMs === null) return null;
    const clipEndMs = Math.max(exportStartMs, exportEndMs);
    return Math.max(0, Math.min(100, ((clipEndMs - sliderMin) / durationMs) * 100));
  }, [hasData, durationMs, exportStartMs, exportEndMs, sliderMin]);

  const activeClipRange = useMemo(() => {
    if (!clipModeEnabled || exportStartMs === null || exportEndMs === null) {
      return null;
    }
    return {
      startMs: Math.min(exportStartMs, exportEndMs),
      endMs: Math.max(exportStartMs, exportEndMs),
    };
  }, [clipModeEnabled, exportStartMs, exportEndMs]);

  const liveTailMs = useMemo(() => {
    if (
      source !== "live" ||
      mode !== "paused" ||
      latestLiveDataMs === null ||
      collectionEndMs === null
    ) {
      return 0;
    }

    return Math.max(0, latestLiveDataMs - collectionEndMs);
  }, [source, mode, latestLiveDataMs, collectionEndMs]);

  const hasLiveTail = liveTailMs > 0;
  const isAtCurrentLiveTime =
    source === "live" &&
    mode === "live" &&
    latestLiveDataMs !== null &&
    Math.abs(sliderValue - latestLiveDataMs) <= 50;

  const handleExportStartChange = (value: number) => {
    if (!hasData || !clipModeEnabled || exportEndMs === null) return;
    const next = Math.max(sliderMin, Math.min(exportEndMs, value));
    setExportStartMs(next);
  };

  const handleExportEndChange = (value: number) => {
    if (!hasData || !clipModeEnabled || exportStartMs === null) return;
    const next = Math.min(sliderMax, Math.max(exportStartMs, value));
    setExportEndMs(next);
  };

  const handleExportPecan = async () => {
    if (!hasData || isExporting) return;
    setIsExporting(true);

    try {
      const rangeStart = activeClipRange?.startMs ?? sliderMin;
      const rangeEnd   = activeClipRange?.endMs   ?? sliderMax;

      let frames: ReplayFrame[] = [];

      let epochBaseMs: number | undefined;

      if (source === "replay" && replaySession) {
        const minRelMs        = replaySession.frames[0]?.tRelMs ?? 0;
        const replayEpochBase = replaySession.startTimeMs - minRelMs;
        epochBaseMs = rangeStart;

        frames = replaySession.frames
          .filter((frame) => {
            const absTime = replayEpochBase + frame.tRelMs;
            return absTime >= rangeStart && absTime <= rangeEnd;
          })
          .map((frame) => {
            const absTime = typeof frame.tEpochMs === "number"
              ? frame.tEpochMs
              : replayEpochBase + frame.tRelMs;
            return {
              tRelMs:    Math.max(0, absTime - rangeStart),
              canId:     frame.canId,
              isExtended: frame.isExtended,
              direction: frame.direction,
              dlc:       frame.dlc,
              dataHex:   frame.dataHex,
            };
          });
      } else {
        epochBaseMs = rangeStart;

        // Hot-buffer frames for the range.
        const hotFrames: ReplayFrame[] = dataStore
          .getTrace()
          .filter((s) => s.timestamp >= rangeStart && s.timestamp <= rangeEnd)
          .map((s) => sampleToReplayFrame(s, rangeStart));

        // Cold-store frames for the same range (silently no-ops if OPFS unavailable).
        const coldRawFrames = await coldStore.loadRange(rangeStart, rangeEnd).catch(() => []);
        const coldFrames: ReplayFrame[] = coldRawFrames.map((f) => ({
          tRelMs:    Math.max(0, f.timestamp - rangeStart),
          tEpochMs:  f.timestamp,
          canId:     f.canId,
          isExtended: f.canId > 0x7FF,
          direction: f.direction,
          dlc:       f.dlc,
          dataHex:   Array.from(f.data.slice(0, f.dlc))
                       .map((b) => b.toString(16).padStart(2, "0"))
                       .join(""),
        }));

        // Merge hot + cold, sort by epoch time.
        frames = [...coldFrames, ...hotFrames].sort(
          (a, b) => (a.tEpochMs ?? 0) - (b.tEpochMs ?? 0)
        );
      }

      const blob = new Blob([serializePecanV2({
        frames,
        epochBaseMs,
        timeline: {
          windowMs,
          lastCursorMs: Math.max(0, sliderValue - rangeStart),
          checkpoints: checkpoints
            .filter((cp) => cp.timeMs >= rangeStart && cp.timeMs <= rangeEnd)
            .map((cp) => ({
              id:     cp.id,
              label:  cp.label,
              tRelMs: Math.max(0, cp.timeMs - rangeStart),
            })),
        },
        plots: plotLayouts.length > 0 ? { layouts: plotLayouts } : undefined,
      })], { type: "application/json" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `pecan_timeline_${formatLocalFilenameTimestamp(Date.now())}.pecan`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportReplay = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setIsImportingReplay(true);

    try {
      const parseResult = await parseReplayFile(file);
      if (parseResult.errors.length > 0 || parseResult.frames.length === 0) {
        const firstError = parseResult.errors[0]?.message ?? "No valid frames found in file.";
        window.alert(`Replay import failed: ${firstError}`);
        return;
      }

      if (parseResult.frames.length > REPLAY_FRAME_HARD_CAP) {
        setPendingClipImport({
          frames: parseResult.frames,
          fileName: file.name,
          timelineMeta: parseResult.sessionMeta?.timeline,
          plotsMeta: parseResult.sessionMeta?.plots,
        });
      } else {
        await loadReplayFrames(
          parseResult.frames,
          file.name,
          parseResult.sessionMeta?.timeline,
          parseResult.sessionMeta?.plots
        );
      }

      if (parseResult.warnings.length > 0) {
        window.alert(`Replay imported with ${parseResult.warnings.length} warning(s).`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown import error";
      window.alert(`Replay import failed: ${message}`);
    } finally {
      setIsImportingReplay(false);
      event.target.value = "";
    }
  };

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
            source === "replay" ? "timeline-chip-paused" : "timeline-chip-live"
          }`}
        >
          {source === "replay" ? "REPLAY" : "LIVE SOURCE"}
        </span>
        <span
          className={`timeline-chip ${
            mode === "live"
              ? "timeline-chip-live"
              : "timeline-chip-paused"
          }`}
        >
          {mode === "live" ? "LIVE" : "PAUSED"}
        </span>
        {hasLiveTail && (
          <span className="timeline-chip timeline-chip-paused">
            +{formatDuration(liveTailMs)} new
          </span>
        )}
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
          className={`trace-btn trace-btn-subtle !text-[10px] !px-2 !py-1 ${mode === "paused" ? "animate-blink" : ""}`}
          onClick={() => setCollapsed(false)}
        >
          TIMELINE ▼
        </button>
      </div>
    );
  }

  return (
    <div className="timeline-box bg-data-module-bg/92 rounded-md p-2.5 mb-2 border border-white/10 sticky top-0 z-20 backdrop-blur-[1px]">
      {pendingClipImport && (
        <ReplayImportClipModal
          frames={pendingClipImport.frames}
          fileName={pendingClipImport.fileName}
          onCancel={() => setPendingClipImport(null)}
          onConfirm={(framesToLoad) => {
            void loadReplayFrames(
              framesToLoad,
              pendingClipImport.fileName,
              pendingClipImport.timelineMeta,
              pendingClipImport.plotsMeta
            );
            setPendingClipImport(null);
          }}
        />
      )}
      {coldWarning && (
        <div className="flex items-center gap-2 mb-1.5 rounded bg-amber-500/15 border border-amber-400/40 px-2.5 py-1 text-[11px] text-amber-300">
          <span className="flex-1">⚠ {coldWarning}</span>
          <button
            type="button"
            className="text-amber-400 hover:text-amber-200 font-bold leading-none"
            onClick={dismissColdWarning}
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}
      {showColdStoreSupportHint && (
        <div className="mb-1.5 rounded border border-sky-400/35 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-200">
          Cold-store persistence is unavailable in this browser/session. Timeline history and replay import features may be limited.
          For best long-session history, use a Chromium-based browser.
        </div>
      )}
      {header}

      <div className="flex items-center gap-1.5 mt-1.5 mb-1.5 flex-wrap">
        {source === "live" && (
          <button
            type="button"
            className="trace-btn trace-btn-primary !text-[10px] !px-2 !py-1"
            onClick={goLive}
            disabled={!hasData || isAtCurrentLiveTime}
          >
            Return to Live
          </button>
        )}
        {source === "replay" && replaySession && (
          <button
            type="button"
            className="trace-btn trace-btn-danger !text-[10px] !px-2 !py-1"
            onClick={clearReplaySession}
          >
            Unmount Replay
          </button>
        )}
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
        <button
          type="button"
          className="trace-btn trace-btn-warning !text-[10px] !px-2 !py-1"
          onClick={() => {
            if (!hasData) return;
            if (!clipModeEnabled) {
              setClipModeEnabled(true);
              setExportStartMs(sliderMin);
              setExportEndMs(sliderMax);
              seek(sliderValue);
              return;
            }

            setClipModeEnabled(false);
            setExportStartMs(null);
            setExportEndMs(null);
          }}
          disabled={!hasData}
          title={clipModeEnabled ? "Reset clip and hide bounds" : "Enable clip range handles"}
        >
          {clipModeEnabled ? "Reset Clip" : "Set Clip"}
        </button>
        <button
          type="button"
          className="trace-btn trace-btn-primary !text-[10px] !px-2 !py-1"
          onClick={handleExportPecan}
          disabled={!hasData || isExporting}
          title="Export hot + cold store history as .pecan session file"
        >
          {isExporting ? "Exporting…" : "Export .pecan"}
        </button>
        {isColdLoading && (
          <span className="text-[10px] text-sky-400 animate-pulse" title="Loading cold history…">
            Loading cold…
          </span>
        )}
        <button
          type="button"
          className="trace-btn trace-btn-primary !text-[10px] !px-2 !py-1"
          onClick={() => replayFileInputRef.current?.click()}
          disabled={isImportingReplay}
        >
          {isImportingReplay ? "Importing..." : "Import .pecan"}
        </button>
        <input
          ref={replayFileInputRef}
          type="file"
          accept=".pecan,.json,.csv,text/csv,application/json"
          className="hidden"
          onChange={handleImportReplay}
          disabled={isImportingReplay}
        />
      </div>

      <div className="relative pt-3 pb-0.5">
        <div className="absolute inset-x-0 top-[13px] h-[1px] bg-white/12 rounded-full pointer-events-none" />
        {hasData && clipModeEnabled && exportStartPct !== null && exportEndPct !== null && (
          <div
            className="absolute top-[9px] h-[8px] rounded bg-orange-400/30 border border-orange-300/55 pointer-events-none"
            style={{
              left: `${Math.min(exportStartPct, exportEndPct)}%`,
              width: `${Math.max(1, Math.abs(exportEndPct - exportStartPct))}%`,
            }}
          />
        )}
        <input
          type="range"
          min={sliderMin}
          max={Math.max(sliderMax, sliderMin + 1)}
          value={sliderValue}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!hasData}
          className="timeline-range timeline-range-trace relative z-10 w-full"
        />
        {clipModeEnabled && (
          <input
            type="range"
            min={sliderMin}
            max={Math.max(sliderMax, sliderMin + 1)}
            value={exportStartMs ?? sliderMin}
            onChange={(e) => handleExportStartChange(Number(e.target.value))}
            disabled={!hasData}
            step={1}
            className="timeline-range timeline-range-clip timeline-range-clip-start absolute inset-x-0 top-0 z-20 w-full"
          />
        )}
        {clipModeEnabled && (
          <input
            type="range"
            min={sliderMin}
            max={Math.max(sliderMax, sliderMin + 1)}
            value={exportEndMs ?? sliderMax}
            onChange={(e) => handleExportEndChange(Number(e.target.value))}
            disabled={!hasData}
            step={1}
            className="timeline-range timeline-range-clip timeline-range-clip-end absolute inset-x-0 top-0 z-20 w-full"
          />
        )}
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
        {hasLiveTail && (
          <div
            className="absolute right-0 top-[4px] text-orange-300 text-[11px] font-mono font-bold pointer-events-none animate-pulse"
            title="New data has arrived beyond the paused right bound. Click Return to Live to release bound."
          >
            {">"}
          </div>
        )}
      </div>

      {tickMarks.length > 0 && (
        <div className="mt-0.5 flex items-center justify-between text-[10px] text-slate-400 font-mono tracking-normal">
          {tickMarks.map((tick) => (
            <span key={tick.key}>{tick.label}</span>
          ))}
        </div>
      )}

      <div className="mt-1.5 text-[10px] text-slate-300 font-mono tracking-normal">
        Cursor: {hasData ? formatClock(sliderValue) : "--:--:--"}
      </div>

      {hasData && activeClipRange && (
        <div className="mt-1 text-[10px] text-orange-200/90 font-mono tracking-normal">
          Export clip: drag orange handles on the timeline. Range: {formatClockPrecise(activeClipRange.startMs)} to {formatClockPrecise(activeClipRange.endMs)}
        </div>
      )}

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
