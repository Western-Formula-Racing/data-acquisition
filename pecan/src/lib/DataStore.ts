/**
 * Telemetry DataStore
 * 
 * A singleton in-browser data buffer for live telemetry from WebSocket.
 * Provides a single source of truth for "what's the latest value?" and 
 * "what happened in the last X seconds?" for each CAN message ID.
 */

// Type definitions matching the canProcessor output
export interface TelemetrySample {
  timestamp: number; // timestamp in ms (Date.now() when received)
  msgID: string; // CAN ID as string
  messageName: string; // Human-readable message name from DBC
  data: {
    [signalName: string]: {
      sensorReading: number;
      unit: string;
    };
  };
  rawData: string; // Original payload bytes "00 01 02 ..."
  direction?: "rx" | "tx";
}

// Internal storage structure
interface MessageBuffer {
  samples: TelemetrySample[];
  lastUpdated: number;
}

// Maximum number of frames kept in the flat trace ring buffer
const TRACE_BUFFER_MAX = 10000;

// Retention window settings
const DEFAULT_RETENTION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const MIN_RETENTION_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_RETENTION_WINDOW_MS = 60 * 60 * 1000; // 60 minutes
const RETENTION_STORAGE_KEY = "pecan:retention-window-ms";

// Frequency window in milliseconds for dashboard displays (2 seconds)
export const FREQUENCY_WINDOW_MS = 2000;

// Listener callback type
type Listener = (msgID?: string) => void;

/**
 * DataStore Class - Singleton Pattern
 */
class DataStore {
  // Internal storage: msgID -> array of samples (chronological order)
  private buffer: Map<string, MessageBuffer>;

  // Flat chronological ring buffer for CAN Trace view
  private traceBuffer: TelemetrySample[];

  // Retention window in milliseconds
  private retentionWindowMs: number;

  // Pub/sub listeners
  private listeners: Set<Listener>;

  // Listeners specifically for trace buffer updates
  private traceListeners: Set<Listener>;

  // Singleton instance
  private static instance: DataStore | null = null;

  private constructor(retentionWindowMs: number = DEFAULT_RETENTION_WINDOW_MS) {
    this.buffer = new Map();
    this.traceBuffer = [];
    this.retentionWindowMs = retentionWindowMs;
    this.listeners = new Set();
    this.traceListeners = new Set();
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(retentionWindowMs?: number): DataStore {
    if (!DataStore.instance) {
      DataStore.instance = new DataStore(retentionWindowMs);
    } else if (typeof retentionWindowMs === 'number') {
      DataStore.instance.setRetentionWindow(retentionWindowMs);
    }
    return DataStore.instance;
  }

  /**
   * Ingest a new CAN message into the data store
   * @param message - Telemetry sample to ingest
   */
  public ingestMessage(message: {
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
  }): void {
    // Fix for old timestamps from recorded data
    // If timestamp is more than 1 hour old, use current time
    let timestamp = message.timestamp || Date.now();
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    if (timestamp < oneHourAgo) {
      timestamp = Date.now();
    }

    const msgID = message.msgID;

    // Round sensor readings to 3 decimal places for cleaner display
    const roundedData = { ...message.data };
    Object.keys(roundedData).forEach((key) => {
      const signal = roundedData[key];
      if (signal && typeof signal.sensorReading === 'number') {
        roundedData[key] = {
          ...signal,
          sensorReading: Math.round(signal.sensorReading * 1000) / 1000,
        };
      }
    });

    // Create the sample
    const sample: TelemetrySample = {
      timestamp,
      msgID,
      messageName: message.messageName,
      data: roundedData,
      rawData: message.rawData,
      direction: message.direction ?? "rx", // 👈 default to RX
    };

    // Get or create buffer for this msgID
    if (!this.buffer.has(msgID)) {
      this.buffer.set(msgID, {
        samples: [],
        lastUpdated: timestamp,
      });
    }

    const messageBuffer = this.buffer.get(msgID)!;

    // Add new sample
    messageBuffer.samples.push(sample);
    messageBuffer.lastUpdated = timestamp;

    // Prune old samples (rolling window)
    this.pruneOldSamples(msgID);

    // Append to flat trace ring buffer (capped)
    this.traceBuffer.push(sample);
    if (this.traceBuffer.length > TRACE_BUFFER_MAX) {
      this.traceBuffer.splice(0, this.traceBuffer.length - TRACE_BUFFER_MAX);
    }
    this.notifyTrace();

    // Notify all subscribers
    this.notifyAll(msgID);
  }

  /**
   * Prune samples older than the retention window for a specific msgID
   * @param msgID - CAN message ID to prune
   */
  private pruneOldSamples(msgID: string): void {
    const messageBuffer = this.buffer.get(msgID);
    if (!messageBuffer || messageBuffer.samples.length === 0) return;

    // Use the newest sample's time as the reference point, NOT Date.now()
    // This allows recorded data (with old timestamps) to be properly pruned
    const newestTime = messageBuffer.samples[messageBuffer.samples.length - 1].timestamp;
    const cutoffTime = newestTime - this.retentionWindowMs;

    // Filter out samples older than cutoff
    messageBuffer.samples = messageBuffer.samples.filter(
      (sample) => sample.timestamp >= cutoffTime
    );

    // If no samples left, we could optionally remove the msgID entry
    // For now, we'll keep it to preserve the messageName mapping
  }

  /**
   * Get the latest sample for a specific msgID
   * @param msgID - CAN message ID
   * @returns Most recent sample or undefined if not found
   */
  public getLatest(msgID: string): TelemetrySample | undefined {
    const messageBuffer = this.buffer.get(msgID);
    if (!messageBuffer || messageBuffer.samples.length === 0) {
      return undefined;
    }

    // Return the last sample (newest)
    return messageBuffer.samples[messageBuffer.samples.length - 1];
  }

  /**
   * Get the latest sample for a specific msgID at or before a target timestamp.
   * @param msgID - CAN message ID
   * @param timeMs - Cursor time in milliseconds
   * @returns Latest sample <= timeMs or undefined
   */
  public getLatestAt(msgID: string, timeMs: number): TelemetrySample | undefined {
    const messageBuffer = this.buffer.get(msgID);
    if (!messageBuffer || messageBuffer.samples.length === 0) {
      return undefined;
    }

    const newest = messageBuffer.samples[messageBuffer.samples.length - 1];
    if (newest.timestamp <= timeMs) {
      return newest;
    }

    let left = 0;
    let right = messageBuffer.samples.length - 1;
    let answer = -1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const ts = messageBuffer.samples[mid].timestamp;
      if (ts <= timeMs) {
        answer = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    if (answer === -1) {
      return undefined;
    }

    return messageBuffer.samples[answer];
  }

  /**
   * Get all samples for a msgID within a time window
   * @param msgID - CAN message ID
   * @param windowMs - Time window in milliseconds (default: all available)
   * @returns Array of samples within the time window
   */
  public getHistory(msgID: string, windowMs?: number): TelemetrySample[] {
    const messageBuffer = this.buffer.get(msgID);
    if (!messageBuffer) {
      return [];
    }

    // If no window specified, return all samples
    if (windowMs === undefined) {
      return [...messageBuffer.samples];
    }

    // Use the newest sample's time as the reference point
    const newestTime = messageBuffer.samples[messageBuffer.samples.length - 1].timestamp;
    const cutoffTime = newestTime - windowMs;
    return messageBuffer.samples.filter(
      (sample) => sample.timestamp >= cutoffTime
    );
  }

  /**
   * Get samples for a msgID inside an explicit time range ending at endTimeMs.
   * @param msgID - CAN message ID
   * @param windowMs - Time window in milliseconds
   * @param endTimeMs - Right edge of the time window in milliseconds
   * @returns Array of samples inside [endTimeMs - windowMs, endTimeMs]
   */
  public getHistoryAt(msgID: string, windowMs: number, endTimeMs: number): TelemetrySample[] {
    const messageBuffer = this.buffer.get(msgID);
    if (!messageBuffer || messageBuffer.samples.length === 0) {
      return [];
    }

    const cutoffTime = endTimeMs - windowMs;
    return messageBuffer.samples.filter(
      (sample) => sample.timestamp >= cutoffTime && sample.timestamp <= endTimeMs
    );
  }

  /**
   * Get the latest value for a specific signal from a specific message
   * @param msgID - CAN message ID
   * @param signalName - Signal name to retrieve
   * @returns Signal data with reading and unit, or undefined if not found
   */
  public getSignal(msgID: string, signalName: string): {
    sensorReading: number;
    unit: string;
  } | undefined {
    const latest = this.getLatest(msgID);
    if (!latest || !latest.data[signalName]) {
      return undefined;
    }

    return latest.data[signalName];
  }

  /**
   * Get all msgIDs currently in the buffer
   * @returns Array of message IDs
   */
  public getAllMessageIds(): string[] {
    return Array.from(this.buffer.keys());
  }

  /**
   * Get all latest samples (one per msgID)
   * @returns Map of msgID to latest sample
   */
  public getAllLatest(): Map<string, TelemetrySample> {
    const result = new Map<string, TelemetrySample>();

    for (const [msgID, messageBuffer] of this.buffer.entries()) {
      if (messageBuffer.samples.length > 0) {
        result.set(msgID, messageBuffer.samples[messageBuffer.samples.length - 1]);
      }
    }

    return result;
  }

  /**
   * Get latest sample per msgID at or before a target timestamp.
   * @param timeMs - Cursor time in milliseconds
   * @returns Map of msgID to timeline-anchored sample
   */
  public getAllLatestAt(timeMs: number): Map<string, TelemetrySample> {
    const result = new Map<string, TelemetrySample>();

    for (const msgID of this.buffer.keys()) {
      const sample = this.getLatestAt(msgID, timeMs);
      if (sample) {
        result.set(msgID, sample);
      }
    }

    return result;
  }

  /**
   * Get the average frequency (Hz) for a specific msgID over a time window
   * @param msgID - CAN message ID
   * @param windowMs - Time window in milliseconds
   * @returns Frequency in Hz
   */
  public getFrequency(msgID: string, windowMs: number): number {
    const messageBuffer = this.buffer.get(msgID);
    if (!messageBuffer || messageBuffer.samples.length === 0) {
      return 0;
    }

    const now = Date.now();
    const cutoffTime = now - windowMs;

    // Count samples within the window
    // Since samples are appended chronologically, we could optimize this with binary search,
    // but for typical buffer sizes (a few thousand), filter/length is fast enough.
    const samplesInWindow = messageBuffer.samples.filter(
      (sample) => sample.timestamp >= cutoffTime
    ).length;

    return samplesInWindow / (windowMs / 1000);
  }

  /**
   * Get average frequency (Hz) anchored to a specific end time.
   * @param msgID - CAN message ID
   * @param windowMs - Time window in milliseconds
   * @param endTimeMs - Right edge of the frequency window
   * @returns Frequency in Hz
   */
  public getFrequencyAt(msgID: string, windowMs: number, endTimeMs: number): number {
    const messageBuffer = this.buffer.get(msgID);
    if (!messageBuffer || messageBuffer.samples.length === 0) {
      return 0;
    }

    const cutoffTime = endTimeMs - windowMs;
    const samplesInWindow = messageBuffer.samples.filter(
      (sample) => sample.timestamp >= cutoffTime && sample.timestamp <= endTimeMs
    ).length;

    return samplesInWindow / (windowMs / 1000);
  }

  /**
   * Subscribe to data updates
   * @param listener - Callback function to be called on updates
   * @returns Unsubscribe function
   */
  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);

    // Return unsubscribe function
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Notify all subscribers of a data update
   * @param msgID - Optional message ID that was updated
   */
  private notifyAll(msgID?: string): void {
    this.listeners.forEach((listener) => {
      try {
        listener(msgID);
      } catch (error) {
        console.error('Error in DataStore listener:', error);
      }
    });
  }

  /**
   * Clear all data from the store
   */
  public clear(): void {
    this.buffer.clear();
    this.traceBuffer = [];
    this.notifyAll();
    this.notifyTrace();
  }

  // ── Trace buffer API ──────────────────────────────────────────────────────

  /**
   * Get a snapshot of the flat chronological trace buffer.
   * Returns a shallow copy to prevent external mutation.
   */
  public getTrace(): TelemetrySample[] {
    return [...this.traceBuffer];
  }

  /**
   * Clear only the trace buffer (does not affect per-ID history).
   */
  public clearTrace(): void {
    this.traceBuffer = [];
    this.notifyTrace();
  }

  /**
   * Subscribe to trace buffer updates.
   * The callback is called every time a new frame is appended.
   */
  public subscribeTrace(listener: Listener): () => void {
    this.traceListeners.add(listener);
    return () => {
      this.traceListeners.delete(listener);
    };
  }

  private notifyTrace(): void {
    this.traceListeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error('Error in DataStore trace listener:', error);
      }
    });
  }

  /**
   * Clear data for a specific msgID
   * @param msgID - CAN message ID to clear
   */
  public clearMessage(msgID: string): void {
    this.buffer.delete(msgID);
    this.notifyAll(msgID);
  }

  /**
   * Update the retention window
   * @param windowMs - New retention window in milliseconds
   */
  public setRetentionWindow(windowMs: number): void {
    if (windowMs === this.retentionWindowMs) {
      return;
    }

    this.retentionWindowMs = windowMs;

    // Prune all messages with new window
    for (const msgID of this.buffer.keys()) {
      this.pruneOldSamples(msgID);
    }

    // Notify subscribers since data might have been pruned
    this.notifyAll();
  }

  /**
   * Get current retention window
   * @returns Retention window in milliseconds
   */
  public getRetentionWindow(): number {
    return this.retentionWindowMs;
  }

  /**
   * Get statistics about the data store
   * @returns Object with stats
   */
  public getStats(): {
    totalMessages: number;
    totalSamples: number;
    oldestSample: number | null;
    newestSample: number | null;
    memoryEstimateMB: number;
  } {
    let totalSamples = 0;
    let oldestSample: number | null = null;
    let newestSample: number | null = null;

    for (const messageBuffer of this.buffer.values()) {
      totalSamples += messageBuffer.samples.length;

      if (messageBuffer.samples.length > 0) {
        const firstTimestamp = messageBuffer.samples[0].timestamp;
        const lastTimestamp = messageBuffer.samples[messageBuffer.samples.length - 1].timestamp;

        if (oldestSample === null || firstTimestamp < oldestSample) {
          oldestSample = firstTimestamp;
        }

        if (newestSample === null || lastTimestamp > newestSample) {
          newestSample = lastTimestamp;
        }
      }
    }

    // Rough memory estimate (very approximate)
    const avgSampleSize = 200; // bytes per sample (rough estimate)
    const memoryEstimateMB = (totalSamples * avgSampleSize) / (1024 * 1024);

    return {
      totalMessages: this.buffer.size,
      totalSamples,
      oldestSample,
      newestSample,
      memoryEstimateMB: Math.round(memoryEstimateMB * 100) / 100,
    };
  }
}

// Export singleton instance
function getInitialRetentionWindowMs(): number {
  try {
    const raw = localStorage.getItem(RETENTION_STORAGE_KEY);
    if (!raw) return DEFAULT_RETENTION_WINDOW_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_WINDOW_MS;
    return Math.max(MIN_RETENTION_WINDOW_MS, Math.min(MAX_RETENTION_WINDOW_MS, parsed));
  } catch {
    return DEFAULT_RETENTION_WINDOW_MS;
  }
}

export const dataStore = DataStore.getInstance(getInitialRetentionWindowMs());

// Export class for testing purposes
export { DataStore };