import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { dataStore } from "../lib/DataStore";
import type { ReplayFrame, ReplayPlotsMetadata, ReplayTimelineMetadata } from "../types/replay";
import { createCanProcessor } from "../utils/canProcessor";

export type TimelineMode = "live" | "paused";
export type TimelineSource = "live" | "replay";

export interface TimelineCheckpoint {
  id: string;
  label: string;
  timeMs: number;
}

interface TimelineContextValue {
  source: TimelineSource;
  mode: TimelineMode;
  selectedTimeMs: number;
  windowMs: number;
  collectionStartMs: number | null;
  collectionEndMs: number | null;
  latestLiveDataMs: number | null;
  checkpoints: TimelineCheckpoint[];
  replaySession: {
    fileName: string;
    frameCount: number;
    loadedAtMs: number;
    startTimeMs: number;
    endTimeMs: number;
    frames: ReplayFrame[];
    plots?: ReplayPlotsMetadata;
  } | null;
  /** True while a cold-store prefetch is in flight for the current scrub position. */
  isColdLoading: boolean;
  /** Warning message when cold storage is approaching its 1 h limit. */
  coldWarning: string | null;
  dismissColdWarning: () => void;
  setWindowMs: (windowMs: number) => void;
  seek: (timeMs: number) => void;
  goLive: () => void;
  loadReplayFrames: (
    frames: ReplayFrame[],
    fileName: string,
    timelineMeta?: ReplayTimelineMetadata,
    plotsMeta?: ReplayPlotsMetadata
  ) => Promise<void>;
  clearReplaySession: () => void;
  addCheckpoint: (label?: string) => void;
  deleteCheckpoint: (id: string) => void;
  clearCheckpoints: () => void;
  jumpToCheckpoint: (id: string) => void;
}

const LIVE_CHECKPOINTS_STORAGE_KEY = "pecan:timeline:checkpoints";
const REPLAY_CHECKPOINTS_STORAGE_KEY = "pecan:timeline:replay:checkpoints";
const DEFAULT_WINDOW_MS = 30000;

const TimelineContext = createContext<TimelineContextValue | null>(null);

function clampTime(value: number, min: number | null, max: number | null): number {
  if (min === null || max === null) return value;
  return Math.max(min, Math.min(max, value));
}

function checkpointsStorageKeyForSource(source: TimelineSource): string {
  return source === "replay"
    ? REPLAY_CHECKPOINTS_STORAGE_KEY
    : LIVE_CHECKPOINTS_STORAGE_KEY;
}

function formatReplayCanId(canId: number, isExtended: boolean): string {
  const normalizedId = canId >>> 0;
  const rawCanId = normalizedId > 0x7ff ? normalizedId & ~0x80000000 : normalizedId;
  const width = isExtended || rawCanId > 0x7ff ? 8 : 3;
  return `0x${rawCanId.toString(16).toUpperCase().padStart(width, "0")}`;
}

function dataHexToRawData(dataHex: string): string {
  const normalized = dataHex.replace(/\s+/g, "").toUpperCase();
  if (!normalized) return "";

  const bytes = normalized.match(/.{1,2}/g);
  return bytes ? bytes.join(" ") : "";
}

function dataHexToBytes(dataHex: string): number[] {
  const normalized = dataHex.replace(/\s+/g, "").toUpperCase();
  const bytePairs = normalized.match(/.{1,2}/g) ?? [];
  return bytePairs
    .map((pair) => Number.parseInt(pair, 16))
    .filter((value) => Number.isFinite(value));
}

function parseLocalTimeToEpochMs(localTime?: string): number | null {
  if (!localTime) {
    return null;
  }

  const parsed = Date.parse(localTime);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadCheckpoints(storageKey: string): TimelineCheckpoint[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        id: String(item.id ?? ""),
        label: String(item.label ?? "Checkpoint"),
        timeMs: Number(item.timeMs ?? 0),
      }))
      .filter((item) => item.id && Number.isFinite(item.timeMs));
  } catch {
    return [];
  }
}

export function TimelineProvider({ children }: { children: ReactNode }) {
  const skipNextCheckpointHydrationRef = useRef(false);
  const [source, setSource] = useState<TimelineSource>("live");
  const [mode, setMode] = useState<TimelineMode>("live");
  const [selectedTimeMs, setSelectedTimeMs] = useState<number>(() => Date.now());
  const [windowMs, setWindowMsState] = useState<number>(DEFAULT_WINDOW_MS);
  const [checkpoints, setCheckpoints] = useState<TimelineCheckpoint[]>(() =>
    loadCheckpoints(LIVE_CHECKPOINTS_STORAGE_KEY)
  );
  const [collectionStartMs, setCollectionStartMs] = useState<number | null>(null);
  const [collectionEndMs, setCollectionEndMs] = useState<number | null>(null);
  const [latestLiveDataMs, setLatestLiveDataMs] = useState<number | null>(null);
  const [replaySession, setReplaySession] = useState<TimelineContextValue["replaySession"]>(null);

  // Cold store state
  const [isColdLoading, setIsColdLoading] = useState(false);
  const [coldWarning, setColdWarning] = useState<string | null>(null);

  // Subscribe to cold-store state changes (loading, warnings).
  useEffect(() => {
    const unsubscribe = dataStore.subscribeColdState(() => {
      setIsColdLoading(dataStore.isColdCacheLoading());
      const warning = dataStore.consumeColdWarning();
      if (warning) setColdWarning(warning);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    dataStore.setActiveSource(source);
  }, [source]);

  useEffect(() => {
    if (source !== "live") {
      return;
    }

    const updateBounds = () => {
      // Guard against stale closure: if the dataStore has already been switched to
      // replay (e.g. by loadReplayFrames before React re-renders), skip the bounds
      // update entirely so we don't overwrite the replay collection window with the
      // live-data timestamps.
      if (dataStore.getActiveSource() !== "live") {
        return;
      }

      const stats      = dataStore.getStats("live");
      const coldExtent = dataStore.getColdExtent();

      setLatestLiveDataMs(stats.newestSample);

      if (mode === "live") {
        // Extend collection start to include cold-store history.
        const hotOldest  = stats.oldestSample;
        const coldOldest = coldExtent?.startMs ?? null;
        const extendedStart =
          hotOldest !== null && coldOldest !== null ? Math.min(hotOldest, coldOldest)
          : hotOldest ?? coldOldest;

        setCollectionStartMs(extendedStart);
        setCollectionEndMs(stats.newestSample);
      }

      if (mode === "live") {
        if (stats.newestSample !== null) {
          setSelectedTimeMs(stats.newestSample);
        } else if (extendedStart === null) {
          // Store was fully cleared — reset cursor to now so stale timestamps don't linger.
          setSelectedTimeMs(Date.now());
        }
      }
    };

    updateBounds();
    const unsubscribe = dataStore.subscribe(() => updateBounds());
    return unsubscribe;
  }, [mode, source]);

  useEffect(() => {
    if (skipNextCheckpointHydrationRef.current) {
      skipNextCheckpointHydrationRef.current = false;
      return;
    }

    const storageKey = checkpointsStorageKeyForSource(source);
    setCheckpoints(loadCheckpoints(storageKey));
  }, [source]);

  useEffect(() => {
    const storageKey = checkpointsStorageKeyForSource(source);
    localStorage.setItem(storageKey, JSON.stringify(checkpoints));
  }, [checkpoints, source]);

  const setWindowMs = useCallback((value: number) => {
    // Hard cap at 120 s — plot window beyond this exhausts the warm cache budget.
    const clamped = Math.max(1000, Math.min(120_000, value));
    setWindowMsState(clamped);
  }, []);

  const seek = useCallback(
    (timeMs: number) => {
      const clamped = clampTime(timeMs, collectionStartMs, collectionEndMs);
      setSelectedTimeMs(clamped);
      setMode("paused");

      // If the cursor moved into cold territory, prefetch a warm cache window.
      if (source === "live") {
        const hotStats  = dataStore.getStats("live");
        const hotOldest = hotStats.oldestSample;
        if (hotOldest !== null && clamped < hotOldest) {
          // Prefetch slightly wider than the current windowMs so small scrub
          // movements don't immediately trigger another load.
          const pad      = windowMs * 0.2;
          const fetchStart = Math.max(collectionStartMs ?? clamped, clamped - windowMs - pad);
          const fetchEnd   = clamped + pad;
          dataStore.prefetchWarmCache(fetchStart, fetchEnd).catch(console.warn);
        } else {
          // Back in hot territory — drop the warm cache to free memory.
          dataStore.clearWarmCache();
        }
      }
    },
    [collectionStartMs, collectionEndMs]
  );

  const goLive = useCallback(() => {
    setReplaySession(null);
    dataStore.setActiveSource("live");
    setSource("live");
    setMode("live");
    const stats = dataStore.getStats("live");
    setLatestLiveDataMs(stats.newestSample);
    setCollectionStartMs(stats.oldestSample);
    setCollectionEndMs(stats.newestSample);
    if (stats.newestSample !== null) {
      setSelectedTimeMs(stats.newestSample);
    }
  }, []);

  const clearReplaySession = useCallback(() => {
    setReplaySession(null);
    dataStore.clear("replay");
    dataStore.setActiveSource("live");
    setSource("live");
    setMode("live");
    const stats = dataStore.getStats("live");
    setLatestLiveDataMs(stats.newestSample);
    setCollectionStartMs(stats.oldestSample);
    setCollectionEndMs(stats.newestSample);
    if (stats.newestSample !== null) {
      setSelectedTimeMs(stats.newestSample);
    }
  }, []);

  const loadReplayFrames = useCallback(async (
    frames: ReplayFrame[],
    fileName: string,
    timelineMeta?: ReplayTimelineMetadata,
    plotsMeta?: ReplayPlotsMetadata
  ) => {
    if (!Array.isArray(frames) || frames.length === 0) {
      return;
    }

    const sorted = [...frames].sort((a, b) => a.tRelMs - b.tRelMs);
    const firstFrame = sorted[0];
    const firstRelMs = firstFrame?.tRelMs ?? 0;
    const baseEpochMs =
      sorted.find((frame) => typeof frame.tEpochMs === "number")?.tEpochMs ??
      parseLocalTimeToEpochMs(sorted.find((frame) => typeof frame.tLocalTime === "string")?.tLocalTime) ??
      (Date.now() - firstRelMs);

    let previousNormalizedTimestamp: number | null = null;
    const normalizedFrames = sorted.map((frame) => {
      const localEpochMs = parseLocalTimeToEpochMs(frame.tLocalTime);
      const relBasedTimestamp = baseEpochMs + frame.tRelMs;
      const rawTimestamp =
        typeof frame.tEpochMs === "number"
          ? frame.tEpochMs
          : (localEpochMs ?? relBasedTimestamp);

      const monotonicTimestamp = previousNormalizedTimestamp === null
        ? rawTimestamp
        : Math.max(rawTimestamp, previousNormalizedTimestamp, relBasedTimestamp);
      const normalizedTimestamp = monotonicTimestamp;
      previousNormalizedTimestamp = normalizedTimestamp;

      return {
        ...frame,
        tEpochMs: normalizedTimestamp,
      };
    });

    const normalizedStartEpochMs = normalizedFrames[0].tEpochMs ?? Date.now();
    const reBasedFrames = normalizedFrames.map((frame) => {
      const timestamp = frame.tEpochMs ?? normalizedStartEpochMs;
      return {
        ...frame,
        tEpochMs: timestamp,
        tRelMs: Math.max(0, timestamp - normalizedStartEpochMs),
      };
    });

    const retainedFrames = reBasedFrames;
    const endTimeMs = retainedFrames[retainedFrames.length - 1].tEpochMs ?? normalizedStartEpochMs;

    if (retainedFrames.length === 0) {
      return;
    }

    const retainedStartTimeMs = retainedFrames[0].tEpochMs ?? normalizedStartEpochMs;
    const replayWindowMs =
      typeof timelineMeta?.windowMs === "number"
        ? Math.max(1000, Math.min(60 * 60 * 1000, timelineMeta.windowMs))
        : windowMs;

    const importedCheckpoints: TimelineCheckpoint[] = (timelineMeta?.checkpoints ?? [])
      .map((checkpoint, index) => {
        const absoluteTimeMs = normalizedStartEpochMs + checkpoint.tRelMs;
        return {
          id: checkpoint.id?.trim() || `replay-${index}-${Math.round(absoluteTimeMs)}`,
          label: checkpoint.label?.trim() || `Checkpoint ${index + 1}`,
          timeMs: absoluteTimeMs,
        };
      })
      .filter((checkpoint) => checkpoint.timeMs >= retainedStartTimeMs && checkpoint.timeMs <= endTimeMs)
      .sort((a, b) => a.timeMs - b.timeMs);

    const importedCursorMs =
      typeof timelineMeta?.lastCursorMs === "number"
        ? clampTime(normalizedStartEpochMs + timelineMeta.lastCursorMs, retainedStartTimeMs, endTimeMs)
        : endTimeMs;

    const processor = await createCanProcessor().catch((error) => {
      console.warn("[Timeline] Failed to initialize CAN decoder for replay import:", error);
      return null;
    });

    // Switch to replay source BEFORE ingesting frames so that any notifyAll()
    // calls fired during ingestion are deflected by the updateBounds guard above.
    // Without this, the stale live subscriber would overwrite collectionStart/End
    // with live-data timestamps before React has a chance to re-render.
    dataStore.setActiveSource("replay");
    dataStore.clear("replay");
    dataStore.ingestMessagesBatch(
      retainedFrames.map((frame) => {
        const timestamp = frame.tEpochMs ?? retainedStartTimeMs;
        const msgID = formatReplayCanId(frame.canId, frame.isExtended);
        const rawBytes = dataHexToBytes(frame.dataHex);
        const decoded = processor?.decode(frame.canId, rawBytes, timestamp) ?? null;

        return {
          msgID,
          messageName: decoded?.messageName ?? `CAN_${msgID}`,
          data: decoded?.signals ?? {},
          rawData: dataHexToRawData(frame.dataHex),
          direction: frame.direction,
          timestamp,
          preserveTimestamp: true,
          source: "replay" as const,
        };
      })
    );

    try {
      localStorage.setItem(REPLAY_CHECKPOINTS_STORAGE_KEY, JSON.stringify(importedCheckpoints));
    } catch {
      // ignore localStorage write failures for checkpoint persistence
    }

    skipNextCheckpointHydrationRef.current = true;

    setReplaySession({
      fileName,
      frameCount: retainedFrames.length,
      loadedAtMs: Date.now(),
      startTimeMs: retainedStartTimeMs,
      endTimeMs,
      frames: retainedFrames,
      plots: plotsMeta,
    });

    setSource("replay");
    setMode("paused");
    setWindowMsState(replayWindowMs);
    setCheckpoints(importedCheckpoints);
    setLatestLiveDataMs(null);
    setCollectionStartMs(retainedStartTimeMs);
    setCollectionEndMs(endTimeMs);
    setSelectedTimeMs(importedCursorMs);
  }, [windowMs]);

  const addCheckpoint = useCallback(
    (label?: string) => {
      const now = collectionEndMs ?? Date.now();
      const checkpointTime = clampTime(selectedTimeMs, collectionStartMs, collectionEndMs) || now;
      setCheckpoints((prev) => {
        const nextIndex = prev.length + 1;
        const checkpoint: TimelineCheckpoint = {
          id: `${checkpointTime}-${Math.random().toString(36).slice(2, 8)}`,
          label: label?.trim() ? label.trim() : `Checkpoint ${nextIndex}`,
          timeMs: checkpointTime,
        };
        return [...prev, checkpoint].sort((a, b) => a.timeMs - b.timeMs);
      });
    },
    [collectionEndMs, collectionStartMs, selectedTimeMs]
  );

  const deleteCheckpoint = useCallback((id: string) => {
    setCheckpoints((prev) => prev.filter((checkpoint) => checkpoint.id !== id));
  }, []);

  const clearCheckpoints = useCallback(() => {
    setCheckpoints([]);
  }, []);

  const jumpToCheckpoint = useCallback(
    (id: string) => {
      const target = checkpoints.find((checkpoint) => checkpoint.id === id);
      if (!target) return;
      seek(target.timeMs);
    },
    [checkpoints, seek]
  );

  const dismissColdWarning = useCallback(() => setColdWarning(null), []);

  const value = useMemo<TimelineContextValue>(
    () => ({
      source,
      mode,
      selectedTimeMs,
      windowMs,
      collectionStartMs,
      collectionEndMs,
      latestLiveDataMs,
      checkpoints,
      replaySession,
      isColdLoading,
      coldWarning,
      dismissColdWarning,
      setWindowMs,
      seek,
      goLive,
      loadReplayFrames,
      clearReplaySession,
      addCheckpoint,
      deleteCheckpoint,
      clearCheckpoints,
      jumpToCheckpoint,
    }),
    [
      source,
      mode,
      selectedTimeMs,
      windowMs,
      collectionStartMs,
      collectionEndMs,
      latestLiveDataMs,
      checkpoints,
      replaySession,
      isColdLoading,
      coldWarning,
      dismissColdWarning,
      setWindowMs,
      seek,
      goLive,
      loadReplayFrames,
      clearReplaySession,
      addCheckpoint,
      deleteCheckpoint,
      clearCheckpoints,
      jumpToCheckpoint,
    ]
  );

  return <TimelineContext.Provider value={value}>{children}</TimelineContext.Provider>;
}

export function useTimeline(): TimelineContextValue {
  const context = useContext(TimelineContext);
  if (!context) {
    throw new Error("useTimeline must be used inside TimelineProvider");
  }
  return context;
}
