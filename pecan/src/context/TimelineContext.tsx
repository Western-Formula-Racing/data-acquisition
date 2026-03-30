import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { dataStore } from "../lib/DataStore";
import type { ReplayFrame } from "../types/replay";

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
  } | null;
  setWindowMs: (windowMs: number) => void;
  seek: (timeMs: number) => void;
  goLive: () => void;
  loadReplayFrames: (frames: ReplayFrame[], fileName: string) => void;
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

  useEffect(() => {
    if (source !== "live") {
      return;
    }

    const updateBounds = () => {
      const stats = dataStore.getStats();
      setLatestLiveDataMs(stats.newestSample);

      if (mode === "live") {
        setCollectionStartMs(stats.oldestSample);
        setCollectionEndMs(stats.newestSample);
      }

      if (mode === "live" && stats.newestSample !== null) {
        setSelectedTimeMs(stats.newestSample);
      }
    };

    updateBounds();
    const unsubscribe = dataStore.subscribe(() => updateBounds());
    return unsubscribe;
  }, [mode, source]);

  useEffect(() => {
    const storageKey = checkpointsStorageKeyForSource(source);
    setCheckpoints(loadCheckpoints(storageKey));
  }, [source]);

  useEffect(() => {
    const storageKey = checkpointsStorageKeyForSource(source);
    localStorage.setItem(storageKey, JSON.stringify(checkpoints));
  }, [checkpoints, source]);

  const setWindowMs = useCallback((value: number) => {
    const clamped = Math.max(1000, Math.min(60 * 60 * 1000, value));
    setWindowMsState(clamped);
  }, []);

  const seek = useCallback(
    (timeMs: number) => {
      const clamped = clampTime(timeMs, collectionStartMs, collectionEndMs);
      setSelectedTimeMs(clamped);
      setMode("paused");
    },
    [collectionStartMs, collectionEndMs]
  );

  const goLive = useCallback(() => {
    setReplaySession(null);
    setSource("live");
    setMode("live");
    const stats = dataStore.getStats();
    setLatestLiveDataMs(stats.newestSample);
    setCollectionStartMs(stats.oldestSample);
    setCollectionEndMs(stats.newestSample);
    if (stats.newestSample !== null) {
      setSelectedTimeMs(stats.newestSample);
    }
  }, []);

  const clearReplaySession = useCallback(() => {
    setReplaySession(null);
    setSource("live");
    setMode("live");
    const stats = dataStore.getStats();
    setLatestLiveDataMs(stats.newestSample);
    setCollectionStartMs(stats.oldestSample);
    setCollectionEndMs(stats.newestSample);
    if (stats.newestSample !== null) {
      setSelectedTimeMs(stats.newestSample);
    }
  }, []);

  const loadReplayFrames = useCallback((frames: ReplayFrame[], fileName: string) => {
    if (!Array.isArray(frames) || frames.length === 0) {
      return;
    }

    const sorted = [...frames].sort((a, b) => a.tRelMs - b.tRelMs);
    const minRelMs = sorted[0].tRelMs;
    const maxRelMs = sorted[sorted.length - 1].tRelMs;
    const baseEpochMs = sorted.find((frame) => typeof frame.tEpochMs === "number")?.tEpochMs ?? Date.now();
    const startTimeMs = baseEpochMs + minRelMs;
    const endTimeMs = baseEpochMs + maxRelMs;

    setReplaySession({
      fileName,
      frameCount: sorted.length,
      loadedAtMs: Date.now(),
      startTimeMs,
      endTimeMs,
      frames: sorted,
    });

    setSource("replay");
    setMode("paused");
    setLatestLiveDataMs(null);
    setCollectionStartMs(startTimeMs);
    setCollectionEndMs(endTimeMs);
    setSelectedTimeMs(startTimeMs);
  }, []);

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
