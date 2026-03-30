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

export type TimelineMode = "live" | "paused";

export interface TimelineCheckpoint {
  id: string;
  label: string;
  timeMs: number;
}

interface TimelineContextValue {
  mode: TimelineMode;
  selectedTimeMs: number;
  windowMs: number;
  collectionStartMs: number | null;
  collectionEndMs: number | null;
  checkpoints: TimelineCheckpoint[];
  setWindowMs: (windowMs: number) => void;
  seek: (timeMs: number) => void;
  goLive: () => void;
  addCheckpoint: (label?: string) => void;
  deleteCheckpoint: (id: string) => void;
  clearCheckpoints: () => void;
  jumpToCheckpoint: (id: string) => void;
}

const CHECKPOINTS_STORAGE_KEY = "pecan:timeline:checkpoints";
const DEFAULT_WINDOW_MS = 30000;

const TimelineContext = createContext<TimelineContextValue | null>(null);

function clampTime(value: number, min: number | null, max: number | null): number {
  if (min === null || max === null) return value;
  return Math.max(min, Math.min(max, value));
}

function loadCheckpoints(): TimelineCheckpoint[] {
  try {
    const raw = localStorage.getItem(CHECKPOINTS_STORAGE_KEY);
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
  const [mode, setMode] = useState<TimelineMode>("live");
  const [selectedTimeMs, setSelectedTimeMs] = useState<number>(() => Date.now());
  const [windowMs, setWindowMsState] = useState<number>(DEFAULT_WINDOW_MS);
  const [checkpoints, setCheckpoints] = useState<TimelineCheckpoint[]>(() => loadCheckpoints());
  const [collectionStartMs, setCollectionStartMs] = useState<number | null>(null);
  const [collectionEndMs, setCollectionEndMs] = useState<number | null>(null);

  useEffect(() => {
    const updateBounds = () => {
      const stats = dataStore.getStats();
      setCollectionStartMs(stats.oldestSample);
      setCollectionEndMs(stats.newestSample);
      if (mode === "live" && stats.newestSample !== null) {
        setSelectedTimeMs(stats.newestSample);
      }
    };

    updateBounds();
    const unsubscribe = dataStore.subscribe(() => updateBounds());
    return unsubscribe;
  }, [mode]);

  useEffect(() => {
    localStorage.setItem(CHECKPOINTS_STORAGE_KEY, JSON.stringify(checkpoints));
  }, [checkpoints]);

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
    setMode("live");
    if (collectionEndMs !== null) {
      setSelectedTimeMs(collectionEndMs);
    }
  }, [collectionEndMs]);

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
      mode,
      selectedTimeMs,
      windowMs,
      collectionStartMs,
      collectionEndMs,
      checkpoints,
      setWindowMs,
      seek,
      goLive,
      addCheckpoint,
      deleteCheckpoint,
      clearCheckpoints,
      jumpToCheckpoint,
    }),
    [
      mode,
      selectedTimeMs,
      windowMs,
      collectionStartMs,
      collectionEndMs,
      checkpoints,
      setWindowMs,
      seek,
      goLive,
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
