/**
 * useDataStore Hook
 * 
 * React hooks for easy integration with the Telemetry DataStore.
 * Provides reactive access to telemetry data with automatic re-renders.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { dataStore, type TelemetrySample, type TelemetrySource } from './DataStore';

/**
 * Hook to get the latest sample for a specific msgID
 * Automatically updates when new data arrives for this msgID
 * 
 * @param msgID - CAN message ID to monitor
 * @returns Latest telemetry sample or undefined
 */
export function useLatestMessage(msgID: string): TelemetrySample | undefined {
  const [sample, setSample] = useState<TelemetrySample | undefined>(() => 
    dataStore.getLatest(msgID)
  );

  useEffect(() => {
    // Initial value
    setSample(dataStore.getLatest(msgID));

    // Subscribe to updates
    const unsubscribe = dataStore.subscribe((updatedMsgID) => {
      // Only update if this is our msgID
      if (updatedMsgID === msgID || updatedMsgID === undefined) {
        setSample(dataStore.getLatest(msgID));
      }
    });

    return unsubscribe;
  }, [msgID]);

  return sample;
}

/**
 * Hook to get historical data for a specific msgID
 * 
 * @param msgID - CAN message ID to monitor
 * @param windowMs - Time window in milliseconds (optional)
 * @returns Array of telemetry samples within the time window
 */
export function useMessageHistory(msgID: string, windowMs?: number): TelemetrySample[] {
  const [history, setHistory] = useState<TelemetrySample[]>(() => 
    dataStore.getHistory(msgID, windowMs)
  );

  useEffect(() => {
    // Initial value
    setHistory(dataStore.getHistory(msgID, windowMs));

    // Subscribe to updates
    const unsubscribe = dataStore.subscribe((updatedMsgID) => {
      // Only update if this is our msgID
      if (updatedMsgID === msgID || updatedMsgID === undefined) {
        setHistory(dataStore.getHistory(msgID, windowMs));
      }
    });

    return unsubscribe;
  }, [msgID, windowMs]);

  return history;
}

/**
 * Hook to get a specific signal from a specific message
 * 
 * @param msgID - CAN message ID
 * @param signalName - Signal name to retrieve
 * @returns Signal data or undefined
 */
export function useSignal(msgID: string, signalName: string): {
  sensorReading: number;
  unit: string;
} | undefined {
  const [signal, setSignal] = useState(() => 
    dataStore.getSignal(msgID, signalName)
  );

  useEffect(() => {
    // Initial value
    setSignal(dataStore.getSignal(msgID, signalName));

    // Subscribe to updates for this specific message
    const unsubscribe = dataStore.subscribe((updatedMsgID) => {
      if (updatedMsgID === msgID || updatedMsgID === undefined) {
        setSignal(dataStore.getSignal(msgID, signalName));
      }
    });

    return unsubscribe;
  }, [msgID, signalName]);

  return signal;
}

/**
 * Hook to get all latest messages
 * Updates whenever any message is updated
 * 
 * @returns Map of msgID to latest telemetry sample
 */
export function useAllLatestMessages(source?: TelemetrySource): Map<string, TelemetrySample> {
  const [allLatest, setAllLatest] = useState<Map<string, TelemetrySample>>(() => 
    dataStore.getAllLatest(source)
  );

  useEffect(() => {
    // Initial value
    setAllLatest(dataStore.getAllLatest(source));

    // Subscribe to all updates
    const unsubscribe = dataStore.subscribe(() => {
      setAllLatest(dataStore.getAllLatest(source));
    });

    return unsubscribe;
  }, [source]);

  return allLatest;
}

/**
 * Hook to get all message IDs currently in the buffer
 * 
 * @returns Array of message IDs
 */
export function useAllMessageIds(): string[] {
  const [messageIds, setMessageIds] = useState<string[]>(() => 
    dataStore.getAllMessageIds()
  );

  useEffect(() => {
    // Initial value
    setMessageIds(dataStore.getAllMessageIds());

    // Subscribe to updates
    const unsubscribe = dataStore.subscribe(() => {
      setMessageIds(dataStore.getAllMessageIds());
    });

    return unsubscribe;
  }, []);

  return messageIds;
}

/**
 * Hook to get all unique signals (msgID, signalName pairs) currently in the buffer.
 * 
 * @returns Array of { msgID: string, signalName: string } objects
 */
export function useAllSignals(): { msgID: string, signalName: string }[] {
  const messageIds = useAllMessageIds();
  const allSignals = useMemo(() => {
    const signals: { msgID: string, signalName: string }[] = [];
    const seen = new Set<string>();
    const allLatest = dataStore.getAllLatest();
    allLatest.forEach((sample) => {
      for (const signalName in sample.data) {
        const key = `${sample.msgID}:${signalName}`;
        if (!seen.has(key)) {
          signals.push({ msgID: sample.msgID, signalName });
          seen.add(key);
        }
      }
    });
    return signals;
  }, [messageIds]);
  return allSignals;
}

/**
 * Hook to get DataStore statistics.
 * Throttled to at most once per second to avoid rebuilding stats on every frame.
 */
export function useDataStoreStats(): ReturnType<typeof dataStore.getStats> {
  const [stats, setStats] = useState(() => dataStore.getStats());

  useEffect(() => {
    let scheduled = false;

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        setStats(dataStore.getStats());
      }, 1000);
    };

    const unsubscribe = dataStore.subscribe(schedule);
    return unsubscribe;
  }, []);

  return stats;
}

/**
 * Hook for warm-cache loading state and cold-store warnings.
 * Updates whenever a warm-cache prefetch starts/finishes or a cold warning fires.
 */
export function useColdStoreState(): {
  isLoading: boolean;
  coldWarning: string | null;
  coldSizeBytes: number;
  coldDurationMs: number;
  coldNearingLimit: boolean;
} {
  const [isLoading,       setIsLoading]       = useState(() => dataStore.isColdCacheLoading());
  const [coldWarning,     setColdWarning]     = useState<string | null>(null);
  const [coldSizeBytes,   setColdSizeBytes]   = useState(() => dataStore.getColdStoreSizeBytes());
  const [coldDurationMs,  setColdDurationMs]  = useState(() => dataStore.getColdExtent()?.endMs
    ? (dataStore.getColdExtent()!.endMs - dataStore.getColdExtent()!.startMs) : 0);
  const [coldNearingLimit, setColdNearingLimit] = useState(() => dataStore.isColdNearingLimit());

  useEffect(() => {
    const unsubscribe = dataStore.subscribeColdState(() => {
      setIsLoading(dataStore.isColdCacheLoading());

      const warning = dataStore.consumeColdWarning();
      if (warning) setColdWarning(warning);

      setColdSizeBytes(dataStore.getColdStoreSizeBytes());
      const extent = dataStore.getColdExtent();
      setColdDurationMs(extent ? extent.endMs - extent.startMs : 0);
      setColdNearingLimit(dataStore.isColdNearingLimit());
    });
    return unsubscribe;
  }, []);

  return { isLoading, coldWarning, coldSizeBytes, coldDurationMs, coldNearingLimit };
}

/**
 * Hook to provide DataStore control functions
 * Returns memoized control functions that don't cause re-renders
 * 
 * @returns Object with control functions
 */
export function useDataStoreControls() {
  const clear = useCallback(() => {
    dataStore.clear();
  }, []);

  const clearMessage = useCallback((msgID: string) => {
    dataStore.clearMessage(msgID);
  }, []);

  const setRetentionWindow = useCallback((windowMs: number) => {
    dataStore.setRetentionWindow(windowMs);
  }, []);

  const getRetentionWindow = useCallback(() => {
    return dataStore.getRetentionWindow();
  }, []);

  const ingestMessage = useCallback((message: {
    msgID: string;
    messageName: string;
    data: {
      [signalName: string]: {
        sensorReading: number;
        unit: string;
      };
    };
    rawData: string;
    timestamp?: number;
    direction?: "rx" | "tx";
    source?: "live" | "replay";
  }) => {
    dataStore.ingestMessage(message);
  }, []);

  return useMemo(() => ({
    clear,
    clearMessage,
    setRetentionWindow,
    getRetentionWindow,
    ingestMessage,
  }), [clear, clearMessage, setRetentionWindow, getRetentionWindow, ingestMessage]);
}

/**
 * Custom hook for components that need multiple pieces of data
 * Combines common queries into a single hook
 * 
 * @param msgID - CAN message ID
 * @param windowMs - Time window for history
 * @returns Object with latest sample and history
 */
export function useMessageData(msgID: string, windowMs?: number): {
  latest: TelemetrySample | undefined;
  history: TelemetrySample[];
} {
  const latest = useLatestMessage(msgID);
  const history = useMessageHistory(msgID, windowMs);

  return useMemo(() => ({
    latest,
    history,
  }), [latest, history]);
}

/**
 * Hook for the flat chronological trace buffer.
 *
 * Updates are throttled to at most once every `throttleMs` milliseconds
 * (default 50 ms = 20 Hz) so the component doesn't re-render on every
 * individual CAN frame at high bus rates.
 *
 * @param throttleMs - Min ms between state updates (default 50)
 * @returns Snapshot of the trace buffer + a clearTrace() helper
 */
export function useTraceBuffer(throttleMs = 50, source?: TelemetrySource): {
  frames: TelemetrySample[];
  clearTrace: () => void;
} {
  const [frames, setFrames] = useState<TelemetrySample[]>(() =>
    dataStore.getTrace(source)
  );

  useEffect(() => {
    let pending = false;

    const flush = () => {
      pending = false;
      setFrames(dataStore.getTrace(source));
    };

    const unsubscribe = dataStore.subscribeTrace(() => {
      if (!pending) {
        pending = true;
        setTimeout(flush, throttleMs);
      }
    });

    // Sync immediately on mount
    setFrames(dataStore.getTrace(source));

    return unsubscribe;
  }, [throttleMs, source]);

  const clearTrace = useCallback(() => {
    dataStore.clearTrace(source);
    setFrames([]);
  }, [source]);

  return useMemo(() => ({ frames, clearTrace }), [frames, clearTrace]);
}