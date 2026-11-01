import { useCallback, useEffect, useRef, useState } from "react";
import { querySeries } from "../api";
import {
  SeriesCache,
  seriesCacheKey,
  targetPointsFor,
  type SeriesMap,
} from "./series-cache";

export interface LoadedSeriesRequest {
  seasonTable: string;
  signals: string[];
  startMs: number;
  endMs: number;
}

export interface UseSeriesData {
  seriesBySignal: SeriesMap;
  /** Request that produced the current `seriesBySignal` (null while pending/cleared). */
  loadedRequest: LoadedSeriesRequest | null;
  loading: boolean;
  error: string | null;
  requestRange(
    seasonTable: string,
    signals: string[],
    startMs: number,
    endMs: number,
  ): void;
  retry(): void;
  /** Drop pending/in-flight work and wipe results (e.g. season change). */
  clear(): void;
}

interface SeriesRequestArgs {
  seasonTable: string;
  signals: string[];
  startMs: number;
  endMs: number;
}

const DEBOUNCE_MS = 300;
// Shared across hook instances so zoom revisits hit the same window budget.
const seriesCache = new SeriesCache();

export function useSeriesData(): UseSeriesData {
  const [seriesBySignal, setSeriesBySignal] = useState<SeriesMap>({});
  const [loadedRequest, setLoadedRequest] = useState<LoadedSeriesRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const lastRequestRef = useRef<SeriesRequestArgs | null>(null);

  const executeRequest = useCallback(async (req: SeriesRequestArgs, generation: number) => {
    // Drop work that was superseded while the debounce timer was pending.
    if (generation !== generationRef.current) return;

    const { seasonTable, signals, startMs, endMs } = req;
    const targetPoints = targetPointsFor(signals.length);
    const key = seriesCacheKey(seasonTable, signals, startMs, endMs, targetPoints);
    const applied: LoadedSeriesRequest = {
      seasonTable,
      signals: [...signals],
      startMs,
      endMs,
    };

    const cached = seriesCache.get(key);
    if (cached) {
      // Clear loading so a later cache hit cannot leave a prior fetch stuck true.
      if (mountedRef.current && generation === generationRef.current) {
        setSeriesBySignal(cached);
        setLoadedRequest(applied);
        setLoading(false);
        setError(null);
      }
      return;
    }

    if (mountedRef.current && generation === generationRef.current) {
      setLoading(true);
    }

    try {
      const response = await querySeries({
        season: seasonTable,
        signals,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        target_points: targetPoints,
      });
      // Cache under the request's own key even if superseded — that cannot corrupt
      // current UI because state updates below still require a matching generation.
      seriesCache.set(key, response.series);
      if (!mountedRef.current || generation !== generationRef.current) return;
      setSeriesBySignal(response.series);
      setLoadedRequest(applied);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      const message = err instanceof Error ? err.message : "failed to fetch series";
      setLoadedRequest(null);
      setError(
        `${message} (${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()})`,
      );
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const requestRange = useCallback(
    (seasonTable: string, signals: string[], startMs: number, endMs: number) => {
      // Copy signals so callers can mutate their array without changing the pending request.
      const req: SeriesRequestArgs = {
        seasonTable,
        signals: [...signals],
        startMs,
        endMs,
      };
      lastRequestRef.current = req;
      // Allocate generation at schedule time so an in-flight older fetch cannot
      // win state updates during this request's debounce window.
      const generation = ++generationRef.current;
      // Invalidate export eligibility immediately (including the debounce window).
      setLoadedRequest(null);
      setError(null);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void executeRequest(req, generation);
      }, DEBOUNCE_MS);
    },
    [executeRequest],
  );

  const retry = useCallback(() => {
    const last = lastRequestRef.current;
    if (!last) return;
    // Resubmit the latest intentional range; cache applies only if that fetch already succeeded.
    requestRange(last.seasonTable, last.signals, last.startMs, last.endMs);
  }, [requestRange]);

  const clear = useCallback(() => {
    generationRef.current += 1;
    lastRequestRef.current = null;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (mountedRef.current) {
      setSeriesBySignal({});
      setLoadedRequest(null);
      setLoading(false);
      setError(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return { seriesBySignal, loadedRequest, loading, error, requestRange, retry, clear };
}
