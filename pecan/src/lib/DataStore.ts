/**
 * Telemetry DataStore
 *
 * Singleton in-browser hot buffer for live CAN telemetry.
 * Keeps a short rolling window in the JS heap; older samples are evicted
 * to ColdStore (OPFS binary archive) so the timeline can still access them
 * without consuming heap memory.
 *
 * Memory architecture:
 *   Hot buffer  – last DEFAULT_RETENTION_WINDOW_MS of decoded TelemetrySamples
 *   Warm cache  – decoded frames loaded from ColdStore for the current scrub window
 *   Cold store  – binary OPFS archive up to 1 h / 500 MB  (see ColdStore.ts)
 */

import { coldStore, type RawCanFrame } from "./ColdStore";
import { createCanProcessor, formatCanId } from "../utils/canProcessor";

// ── Binary-search helpers ──────────────────────────────────────────────────

/** Returns the index of the first element whose timestamp >= target. */
function binarySearchFirstGte(arr: TelemetrySample[], target: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].timestamp < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Returns the last element whose timestamp <= timeMs, or undefined. */
function binarySearchLatestAt(arr: TelemetrySample[], timeMs: number): TelemetrySample | undefined {
  if (arr.length === 0) return undefined;
  if (arr[arr.length - 1].timestamp <= timeMs) return arr[arr.length - 1];
  const idx = binarySearchFirstGte(arr, timeMs + 1);
  return idx > 0 ? arr[idx - 1] : undefined;
}

// ── Type definitions ───────────────────────────────────────────────────────

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

export type TelemetrySource = "live" | "replay";

interface SourceBufferSet {
  byMsgId: Map<string, MessageBuffer>;
  trace: TelemetrySample[];
}

// Hard cap on the flat trace buffer (evicted entries go to ColdStore).
const TRACE_BUFFER_HARD_MAX = 100_000;

// Per-message sample cap — prevents a single high-rate ID from dominating heap.
const PER_MESSAGE_SAMPLE_CAP = 10_000;

// Retention window settings (hot buffer only).
const DEFAULT_RETENTION_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes (was 30)
const MIN_RETENTION_WINDOW_MS     = 60 * 1000;       // 1 minute
const MAX_RETENTION_WINDOW_MS     = 60 * 60 * 1000;  // 60 minutes
const RETENTION_STORAGE_KEY = "pecan:retention-window-ms";
const DATASTORE_SNAPSHOT_KEY = "pecan:datastore:snapshot:v2";
const DATASTORE_SNAPSHOT_VERSION = 2;
const DATASTORE_SNAPSHOT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DATASTORE_SNAPSHOT_SAVE_DEBOUNCE_MS = 1000;
const DATASTORE_SNAPSHOT_TARGET_TRACE_SAMPLES = 500000;
const DATASTORE_SNAPSHOT_MIN_TRACE_SAMPLES = 1000;
const LOCALSTORAGE_ASSUMED_BUDGET_BYTES = 5 * 1024 * 1024; // 5 MB typical per-origin budget
const LOCALSTORAGE_SAFETY_RESERVE_BYTES = 128 * 1024; // Leave headroom for app settings writes

// High-priority keys should always win over CAN recovery snapshot storage.
const LOCALSTORAGE_PRIORITY_KEYS = [
  "dbc-file-content",
  "pecan_monitor_presets",
  "custom-ws-url",
  "pecan:retention-window-ms",
  "pecan:timeline:checkpoints",
  "pecan:timeline:replay:checkpoints",
  "comms_pinned_sensors",
  "comms_username",
  "perf-overlay-enabled",
  "dash:viewMode",
  "dash:desktopPanelOpen",
  "dash:tutorialSeen",
  "dbc-cache-active",
  "txdash:viewMode",
];

// Frequency window in milliseconds for dashboard displays (2 seconds)
export const FREQUENCY_WINDOW_MS = 2000;

// Listener callback type
type Listener = (msgID?: string) => void;

interface PersistedDataStoreSnapshot {
  version: number;
  savedAtMs: number;
  retentionWindowMs: number;
  liveFrames: PersistedCanFrame[];
}

interface PersistedCanFrame {
  t: number;
  id: number;
  d: string;
  dir?: "rx" | "tx";
}

// ── Warm cache (decoded cold frames for the current scrub window) ──────────

interface WarmCache {
  byMsgId: Map<string, TelemetrySample[]>;
  startMs: number;
  endMs: number;
}

/**
 * DataStore Class - Singleton Pattern
 */
class DataStore {
  // Internal storage split by source
  private sourceBuffers: Record<TelemetrySource, SourceBufferSet>;

  // Which source existing read APIs are anchored to
  private activeSource: TelemetrySource;

  // Retention window in milliseconds
  private retentionWindowMs: number;

  // Pub/sub listeners
  private listeners: Set<Listener>;

  // Listeners specifically for trace buffer updates
  private traceListeners: Set<Listener>;

  // Singleton instance
  private static instance: DataStore | null = null;

  private snapshotSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveredFromSnapshot = false;
  private isRestoringSnapshot = false;

  // ── Cold store integration ──────────────────────────────────────────────

  /** Decoded warm cache: cold frames re-decoded for the current scrub window. */
  private warmCache: WarmCache | null = null;

  /** True while an async cold-range prefetch is in flight. */
  private warmCacheLoading = false;

  /** Cold store warning message from the last enforceLimits pass. */
  private coldWarningMessage: string | null = null;

  /** Listeners fired when warm-cache loading state or cold warning changes. */
  private coldStateListeners: Set<() => void> = new Set();

  private constructor(retentionWindowMs: number = DEFAULT_RETENTION_WINDOW_MS) {
    this.sourceBuffers = {
      live: { byMsgId: new Map(), trace: [] },
      replay: { byMsgId: new Map(), trace: [] },
    };
    this.activeSource = "live";
    this.retentionWindowMs = retentionWindowMs;
    this.listeners = new Set();
    this.traceListeners = new Set();

    // Wire cold store warnings into DataStore notifications.
    coldStore.setWarningCallback((msg) => {
      this.coldWarningMessage = msg;
      this.notifyColdState();
    });

    // Boot OPFS cold store asynchronously (non-blocking).
    coldStore.init().catch((e) => console.warn("[DataStore] ColdStore init failed:", e));

    this.loadSnapshotFromStorage();
  }

  private getSourceBuffers(source: TelemetrySource = this.activeSource): SourceBufferSet {
    return this.sourceBuffers[source];
  }

  public setActiveSource(source: TelemetrySource): void {
    if (this.activeSource === source) {
      return;
    }

    this.activeSource = source;
    if (source === "replay") {
      // Cold-store limits/warnings are only relevant to live capture.
      // Clear any pending cold warning so replay imports don't surface stale 1h-limit alerts.
      this.coldWarningMessage = null;
      this.notifyColdState();
    }
    this.scheduleSnapshotSave();
    this.notifyAll();
    this.notifyTrace();
  }

  public getActiveSource(): TelemetrySource {
    return this.activeSource;
  }

  public consumeRecoveredSnapshotNotice(): boolean {
    const recovered = this.recoveredFromSnapshot;
    this.recoveredFromSnapshot = false;
    return recovered;
  }

  public clearPersistedSnapshot(): void {
    try {
      localStorage.removeItem(DATASTORE_SNAPSHOT_KEY);
    } catch {
      // ignore localStorage failures
    }
  }

  private loadSnapshotFromStorage(): void {
    try {
      const raw = localStorage.getItem(DATASTORE_SNAPSHOT_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as PersistedDataStoreSnapshot;
      if (!Number.isFinite(parsed.savedAtMs) || Date.now() - parsed.savedAtMs > DATASTORE_SNAPSHOT_TTL_MS) {
        localStorage.removeItem(DATASTORE_SNAPSHOT_KEY);
        return;
      }

      if (typeof parsed.retentionWindowMs === "number") {
        this.retentionWindowMs = Math.max(
          MIN_RETENTION_WINDOW_MS,
          Math.min(MAX_RETENTION_WINDOW_MS, parsed.retentionWindowMs)
        );
      }

      if (parsed.version !== DATASTORE_SNAPSHOT_VERSION) {
        localStorage.removeItem(DATASTORE_SNAPSHOT_KEY);
        return;
      }

      const liveFrames = Array.isArray(parsed.liveFrames) ? parsed.liveFrames : [];
      this.sourceBuffers.live = { byMsgId: new Map(), trace: [] };
      this.sourceBuffers.replay = { byMsgId: new Map(), trace: [] };
      this.activeSource = "live";
      this.recoveredFromSnapshot = liveFrames.length > 0;

      if (liveFrames.length > 0) {
        void this.restoreLiveTraceFromFrames(liveFrames);
      }
    } catch {
      // ignore corrupted snapshot data
    }
  }

  private compactHexToBytes(compactHex: string): number[] {
    if (!compactHex || compactHex.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(compactHex)) {
      return [];
    }

    const bytes: number[] = [];
    for (let i = 0; i < compactHex.length; i += 2) {
      const byte = Number.parseInt(compactHex.slice(i, i + 2), 16);
      if (!Number.isFinite(byte)) {
        return [];
      }
      bytes.push(byte);
    }
    return bytes;
  }

  private bytesToRawData(bytes: number[]): string {
    return bytes.map((value) => value.toString(16).padStart(2, "0").toUpperCase()).join(" ");
  }

  private msgIdToCanId(msgID: string): number | null {
    if (!msgID || !msgID.startsWith("0x")) {
      return null;
    }

    const parsed = Number.parseInt(msgID.slice(2), 16);
    if (!Number.isFinite(parsed)) {
      return null;
    }

    return parsed >>> 0;
  }

  private rawDataToCompactHex(rawData: string): string | null {
    if (typeof rawData !== "string" || rawData.length === 0) {
      return null;
    }

    const compact = rawData.replace(/\s+/g, "").toUpperCase();
    if (compact.length === 0 || compact.length % 2 !== 0 || !/^[0-9A-F]+$/.test(compact)) {
      return null;
    }

    return compact;
  }

  private async restoreLiveTraceFromFrames(frames: PersistedCanFrame[]): Promise<void> {
    if (!Array.isArray(frames) || frames.length === 0) {
      return;
    }

    this.isRestoringSnapshot = true;

    try {
      const processor = await createCanProcessor().catch(() => null);

      const chunkSize = 5000;
      for (let i = 0; i < frames.length; i += chunkSize) {
        const chunk = frames.slice(i, i + chunkSize);
        const messages: Array<{
          msgID: string;
          messageName: string;
          data: {
            [signalName: string]: {
              sensorReading: number;
              unit: string;
            };
          };
          rawData: string;
          direction?: "rx" | "tx";
          timestamp: number;
          preserveTimestamp: boolean;
          source: "live";
        }> = [];

        for (const frame of chunk) {
          if (!Number.isFinite(frame?.t) || !Number.isFinite(frame?.id) || typeof frame?.d !== "string") {
            continue;
          }

          const bytes = this.compactHexToBytes(frame.d);
          if (bytes.length === 0 && frame.d.length > 0) {
            continue;
          }

          const timestamp = frame.t;
          const canId = frame.id >>> 0;
          const msgID = formatCanId(canId);
          const decoded = processor?.decode(canId, bytes, timestamp) ?? null;

          messages.push({
            msgID,
            messageName: decoded?.messageName ?? `CAN_${msgID}`,
            data: decoded?.signals ?? {},
            rawData: this.bytesToRawData(bytes),
            direction: frame.dir,
            timestamp,
            preserveTimestamp: true,
            source: "live",
          });
        }

        if (messages.length > 0) {
          this.ingestMessagesBatch(messages);
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      this.isRestoringSnapshot = false;
      this.scheduleSnapshotSave();
      this.notifyAll();
      this.notifyTrace();
    }
  }

  private scheduleSnapshotSave(): void {
    if (this.isRestoringSnapshot) {
      return;
    }

    if (this.snapshotSaveTimer) {
      return;
    }

    this.snapshotSaveTimer = setTimeout(() => {
      this.snapshotSaveTimer = null;
      this.persistSnapshotToStorage();
    }, DATASTORE_SNAPSHOT_SAVE_DEBOUNCE_MS);
  }

  private estimateStringStorageBytes(value: string): number {
    // localStorage stores UTF-16 strings in most browsers: 2 bytes per char.
    return value.length * 2;
  }

  private estimatePriorityStorageBytes(): number {
    let total = 0;

    for (const key of LOCALSTORAGE_PRIORITY_KEYS) {
      try {
        const value = localStorage.getItem(key);
        if (value === null) {
          continue;
        }

        total += this.estimateStringStorageBytes(key);
        total += this.estimateStringStorageBytes(value);
      } catch {
        // ignore key read failures and keep best-effort estimate
      }
    }

    return total;
  }

  private getSnapshotBudgetBytes(): number {
    const reserved = this.estimatePriorityStorageBytes() + LOCALSTORAGE_SAFETY_RESERVE_BYTES;
    const available = LOCALSTORAGE_ASSUMED_BUDGET_BYTES - reserved;
    return Math.max(0, available);
  }

  private persistSnapshotToStorage(): void {
    if (this.isRestoringSnapshot) {
      return;
    }

    const fullLiveTrace = this.sourceBuffers.live.trace;
    if (fullLiveTrace.length === 0) {
      try {
        localStorage.removeItem(DATASTORE_SNAPSHOT_KEY);
      } catch {
        // ignore localStorage failures
      }
      return;
    }

    const snapshotBudgetBytes = this.getSnapshotBudgetBytes();
    if (snapshotBudgetBytes <= 0) {
      try {
        localStorage.removeItem(DATASTORE_SNAPSHOT_KEY);
      } catch {
        // ignore localStorage failures
      }
      return;
    }

    let sampleCount = Math.min(DATASTORE_SNAPSHOT_TARGET_TRACE_SAMPLES, fullLiveTrace.length);
    while (sampleCount >= DATASTORE_SNAPSHOT_MIN_TRACE_SAMPLES) {
      try {
        const liveFrames: PersistedCanFrame[] = [];
        for (const sample of fullLiveTrace.slice(-sampleCount)) {
          const canId = this.msgIdToCanId(sample.msgID);
          const dataHex = this.rawDataToCompactHex(sample.rawData);
          if (canId === null || dataHex === null) {
            continue;
          }

          liveFrames.push({
            t: sample.timestamp,
            id: canId,
            d: dataHex,
            dir: sample.direction,
          });
        }

        if (liveFrames.length === 0) {
          sampleCount = Math.floor(sampleCount / 2);
          continue;
        }

        const snapshot: PersistedDataStoreSnapshot = {
          version: DATASTORE_SNAPSHOT_VERSION,
          savedAtMs: Date.now(),
          retentionWindowMs: this.retentionWindowMs,
          liveFrames,
        };

        const serialized = JSON.stringify(snapshot);
        const serializedBytes = this.estimateStringStorageBytes(serialized) + this.estimateStringStorageBytes(DATASTORE_SNAPSHOT_KEY);
        if (serializedBytes > snapshotBudgetBytes) {
          sampleCount = Math.floor(sampleCount / 2);
          continue;
        }

        localStorage.setItem(DATASTORE_SNAPSHOT_KEY, serialized);
        return;
      } catch {
        sampleCount = Math.floor(sampleCount / 2);
      }
    }

    try {
      localStorage.removeItem(DATASTORE_SNAPSHOT_KEY);
    } catch {
      // ignore localStorage failures
    }
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
    preserveTimestamp?: boolean;
    source?: TelemetrySource;
  }): void {
    // Fix for old timestamps from recorded data
    // If timestamp is more than 1 hour old, use current time
    let timestamp = message.timestamp || Date.now();
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    if (!message.preserveTimestamp && timestamp < oneHourAgo) {
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

    const source = message.source ?? "live";
    const buffers = this.getSourceBuffers(source);

    // Get or create buffer for this msgID
    if (!buffers.byMsgId.has(msgID)) {
      buffers.byMsgId.set(msgID, {
        samples: [],
        lastUpdated: timestamp,
      });
    }

    const messageBuffer = buffers.byMsgId.get(msgID)!;

    // Add new sample
    messageBuffer.samples.push(sample);
    messageBuffer.lastUpdated = timestamp;

    // Prune old samples (rolling window)
    this.pruneOldSamples(msgID, source);

    // Append to flat trace history and prune by retention window.
    buffers.trace.push(sample);
    this.pruneTraceBuffer(timestamp, source);
    this.scheduleSnapshotSave();
    this.notifyTrace();

    // Notify all subscribers
    this.notifyAll(msgID);
  }

  /**
   * Batch ingest to avoid notifying subscribers for every frame during replay loads.
   */
  public ingestMessagesBatch(messages: Array<{
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
    preserveTimestamp?: boolean;
    source?: TelemetrySource;
  }>): void {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }

    let newestTimestampBySource: Partial<Record<TelemetrySource, number>> = {};

    for (const message of messages) {
      // Fix for old timestamps from recorded data unless explicitly preserved.
      let timestamp = message.timestamp || Date.now();
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      if (!message.preserveTimestamp && timestamp < oneHourAgo) {
        timestamp = Date.now();
      }

      const source = message.source ?? "live";
      newestTimestampBySource[source] = Math.max(newestTimestampBySource[source] ?? timestamp, timestamp);

      const buffers = this.getSourceBuffers(source);

      const roundedData = { ...message.data };
      Object.keys(roundedData).forEach((key) => {
        const signal = roundedData[key];
        if (signal && typeof signal.sensorReading === "number") {
          roundedData[key] = {
            ...signal,
            sensorReading: Math.round(signal.sensorReading * 1000) / 1000,
          };
        }
      });

      const sample: TelemetrySample = {
        timestamp,
        msgID: message.msgID,
        messageName: message.messageName,
        data: roundedData,
        rawData: message.rawData,
        direction: message.direction ?? "rx",
      };

      if (!buffers.byMsgId.has(sample.msgID)) {
        buffers.byMsgId.set(sample.msgID, {
          samples: [],
          lastUpdated: timestamp,
        });
      }

      const messageBuffer = buffers.byMsgId.get(sample.msgID)!;
      messageBuffer.samples.push(sample);
      messageBuffer.lastUpdated = timestamp;
      this.pruneOldSamples(sample.msgID, source);

      buffers.trace.push(sample);
    }

    for (const source of Object.keys(newestTimestampBySource) as TelemetrySource[]) {
      const newestTimestamp = newestTimestampBySource[source];
      if (typeof newestTimestamp === "number") {
        this.pruneTraceBuffer(newestTimestamp, source);
      }
    }
    this.scheduleSnapshotSave();
    this.notifyTrace();
    this.notifyAll();
  }

  /**
   * Prune samples older than the retention window for a specific msgID.
   * Uses binary search + splice to avoid allocating a replacement array.
   */
  private pruneOldSamples(msgID: string, source: TelemetrySource = this.activeSource): void {
    if (source === "replay") return;

    const messageBuffer = this.getSourceBuffers(source).byMsgId.get(msgID);
    if (!messageBuffer || messageBuffer.samples.length === 0) return;

    const newestTime = messageBuffer.samples[messageBuffer.samples.length - 1].timestamp;
    const cutoffTime = newestTime - this.retentionWindowMs;

    // Binary search for the first sample to keep, then splice off everything before it.
    const keepIdx = binarySearchFirstGte(messageBuffer.samples, cutoffTime);
    if (keepIdx > 0) {
      messageBuffer.samples.splice(0, keepIdx);
    }

    // Hard per-message cap: prevents a single high-rate ID from dominating heap.
    if (messageBuffer.samples.length > PER_MESSAGE_SAMPLE_CAP) {
      messageBuffer.samples.splice(0, messageBuffer.samples.length - PER_MESSAGE_SAMPLE_CAP);
    }
  }

  /**
   * Get the latest sample for a specific msgID
   * @param msgID - CAN message ID
   * @returns Most recent sample or undefined if not found
   */
  public getLatest(msgID: string, source: TelemetrySource = this.activeSource): TelemetrySample | undefined {
    const messageBuffer = this.getSourceBuffers(source).byMsgId.get(msgID);
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
  public getLatestAt(msgID: string, timeMs: number, source: TelemetrySource = this.activeSource): TelemetrySample | undefined {
    const messageBuffer = this.getSourceBuffers(source).byMsgId.get(msgID);
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
   * Get samples for a msgID within a rolling time window anchored to the newest sample.
   * Merges hot buffer with warm cache when the cursor is in cold territory.
   */
  public getHistory(msgID: string, windowMs?: number, source: TelemetrySource = this.activeSource): TelemetrySample[] {
    const messageBuffer = this.getSourceBuffers(source).byMsgId.get(msgID);

    if (windowMs === undefined) {
      const hotSamples = messageBuffer ? [...messageBuffer.samples] : [];
      if (source === "live" && this.warmCache) {
        const coldSamples = this.warmCache.byMsgId.get(msgID);
        if (coldSamples && coldSamples.length > 0) {
          return [...coldSamples, ...hotSamples].sort((a, b) => a.timestamp - b.timestamp);
        }
      }
      return hotSamples;
    }

    if (!messageBuffer || messageBuffer.samples.length === 0) {
      if (source === "live" && this.warmCache) {
        const coldSamples = this.warmCache.byMsgId.get(msgID);
        if (coldSamples && coldSamples.length > 0) {
          const newestTime = coldSamples[coldSamples.length - 1].timestamp;
          const startIdx   = binarySearchFirstGte(coldSamples, newestTime - windowMs);
          return coldSamples.slice(startIdx);
        }
      }
      return [];
    }

    const newestTime = messageBuffer.samples[messageBuffer.samples.length - 1].timestamp;
    const cutoffTime = newestTime - windowMs;
    const startIdx   = binarySearchFirstGte(messageBuffer.samples, cutoffTime);
    return messageBuffer.samples.slice(startIdx);
  }

  /**
   * Get samples for a msgID inside [endTimeMs - windowMs, endTimeMs].
   * Transparently merges hot buffer with warm cache for cold-territory scrubbing.
   * Uses binary search to avoid .filter() allocations.
   */
  public getHistoryAt(msgID: string, windowMs: number, endTimeMs: number, source: TelemetrySource = this.activeSource): TelemetrySample[] {
    const cutoffTime = endTimeMs - windowMs;

    const sliceRange = (arr: TelemetrySample[]): TelemetrySample[] => {
      const startIdx = binarySearchFirstGte(arr, cutoffTime);
      const endIdx   = binarySearchFirstGte(arr, endTimeMs + 1);
      return arr.slice(startIdx, endIdx);
    };

    const messageBuffer = this.getSourceBuffers(source).byMsgId.get(msgID);
    const hotSamples    = messageBuffer ? sliceRange(messageBuffer.samples) : [];

    if (source === "live" && this.warmCache) {
      const coldSamples = this.warmCache.byMsgId.get(msgID);
      if (coldSamples && coldSamples.length > 0) {
        const coldInRange = sliceRange(coldSamples);
        if (coldInRange.length > 0) {
          return [...coldInRange, ...hotSamples].sort((a, b) => a.timestamp - b.timestamp);
        }
      }
    }

    return hotSamples;
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
    const latest = this.getLatest(msgID, this.activeSource);
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
    return Array.from(this.getSourceBuffers().byMsgId.keys());
  }

  /**
   * Get all latest samples (one per msgID)
   * @returns Map of msgID to latest sample
   */
  public getAllLatest(source: TelemetrySource = this.activeSource): Map<string, TelemetrySample> {
    const result = new Map<string, TelemetrySample>();
    const byMsgId = this.getSourceBuffers(source).byMsgId;

    for (const [msgID, messageBuffer] of byMsgId.entries()) {
      if (messageBuffer.samples.length > 0) {
        result.set(msgID, messageBuffer.samples[messageBuffer.samples.length - 1]);
      }
    }

    return result;
  }

  /**
   * Get latest sample per msgID at or before a target timestamp.
   * Checks warm cache first (for cold-territory scrubbing), hot buffer overrides.
   */
  public getAllLatestAt(timeMs: number, source: TelemetrySource = this.activeSource): Map<string, TelemetrySample> {
    const result = new Map<string, TelemetrySample>();

    // Warm cache first (lower priority — hot buffer overrides below).
    if (source === "live" && this.warmCache) {
      for (const [msgID, coldSamples] of this.warmCache.byMsgId) {
        const sample = binarySearchLatestAt(coldSamples, timeMs);
        if (sample) result.set(msgID, sample);
      }
    }

    // Hot buffer overrides any cold entry for the same msgID.
    const byMsgId = this.getSourceBuffers(source).byMsgId;
    for (const msgID of byMsgId.keys()) {
      const sample = this.getLatestAt(msgID, timeMs, source);
      if (sample) result.set(msgID, sample);
    }

    return result;
  }

  /**
   * Average frequency (Hz) for a msgID over the most recent windowMs.
   * Uses binary search — no temporary array allocation.
   */
  public getFrequency(msgID: string, windowMs: number, source: TelemetrySource = this.activeSource): number {
    const messageBuffer = this.getSourceBuffers(source).byMsgId.get(msgID);
    if (!messageBuffer || messageBuffer.samples.length === 0) return 0;

    const now = source === "replay"
      ? messageBuffer.samples[messageBuffer.samples.length - 1].timestamp
      : Date.now();
    const cutoffTime = now - windowMs;
    const startIdx   = binarySearchFirstGte(messageBuffer.samples, cutoffTime);
    const count      = messageBuffer.samples.length - startIdx;

    return count / (windowMs / 1000);
  }

  /**
   * Average frequency (Hz) anchored to an explicit end time.
   * Uses binary search — no temporary array allocation.
   */
  public getFrequencyAt(msgID: string, windowMs: number, endTimeMs: number, source: TelemetrySource = this.activeSource): number {
    const messageBuffer = this.getSourceBuffers(source).byMsgId.get(msgID);
    if (!messageBuffer || messageBuffer.samples.length === 0) return 0;

    const cutoffTime      = endTimeMs - windowMs;
    const startIdx        = binarySearchFirstGte(messageBuffer.samples, cutoffTime);
    const endIdx          = binarySearchFirstGte(messageBuffer.samples, endTimeMs + 1);
    const samplesInWindow = endIdx - startIdx;

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
  public clear(source?: TelemetrySource): void {
    const sources: TelemetrySource[] = source ? [source] : ["live", "replay"];

    for (const item of sources) {
      const buffers = this.getSourceBuffers(item);
      buffers.byMsgId.clear();
      buffers.trace = [];
    }

    this.scheduleSnapshotSave();
    this.notifyAll();
    this.notifyTrace();
  }

  // ── Cold state / warm cache API ───────────────────────────────────────────

  /** Subscribe to warm-cache loading state and cold-store warning changes. */
  public subscribeColdState(listener: () => void): () => void {
    this.coldStateListeners.add(listener);
    return () => { this.coldStateListeners.delete(listener); };
  }

  private notifyColdState(): void {
    this.coldStateListeners.forEach((l) => { try { l(); } catch { /* ignore */ } });
  }

  public isColdCacheLoading(): boolean { return this.warmCacheLoading; }

  /** The cold-store warning message (if any) from the last limit-enforcement pass. */
  public consumeColdWarning(): string | null {
    if (this.activeSource !== "live") {
      return null;
    }
    const msg = this.coldWarningMessage;
    this.coldWarningMessage = null;
    return msg;
  }

  /**
   * Returns the full time extent of cold (OPFS) data, or null if no cold data.
   * Used by TimelineContext to extend the collection-start timestamp.
   */
  public getColdExtent(): { startMs: number; endMs: number } | null {
    if (this.activeSource !== "live") {
      return null;
    }
    return coldStore.getTimeRange();
  }

  /** Returns cold store on-disk size in bytes. */
  public getColdStoreSizeBytes(): number {
    if (this.activeSource !== "live") {
      return 0;
    }
    return coldStore.getTotalBytes();
  }

  public isColdNearingLimit(): boolean {
    if (this.activeSource !== "live") {
      return false;
    }
    return coldStore.isNearingLimit();
  }

  /**
   * Feature capability check for OPFS-backed cold storage.
   * Uses capability detection (not user-agent sniffing).
   */
  public isColdStoreSupported(): boolean {
    if (typeof navigator === "undefined") return false;
    if (!("storage" in navigator)) return false;
    return typeof (navigator.storage as { getDirectory?: unknown }).getDirectory === "function";
  }

  /**
   * Asynchronously loads and decodes a time window from ColdStore into the
   * warm cache so that sync read APIs (getHistoryAt, getAllLatestAt, etc.)
   * can serve historical data while the cursor is in cold territory.
   *
   * Skips the load if the requested range is already covered by the cache.
   */
  public async prefetchWarmCache(startMs: number, endMs: number): Promise<void> {
    if (this.warmCacheLoading) return;

    // Already fully covered?
    if (
      this.warmCache &&
      this.warmCache.startMs <= startMs &&
      this.warmCache.endMs   >= endMs
    ) return;

    this.warmCacheLoading = true;
    this.notifyColdState();

    try {
      const rawFrames = await coldStore.loadRange(startMs, endMs);

      const byMsgId = new Map<string, TelemetrySample[]>();
      if (rawFrames.length > 0) {
        const processor = await createCanProcessor().catch(() => null);

        for (const frame of rawFrames) {
          const msgID = formatCanId(frame.canId);

          const bytes   = Array.from(frame.data.slice(0, frame.dlc));
          const decoded = processor?.decode(frame.canId, bytes, frame.timestamp) ?? null;

          const sample: TelemetrySample = {
            timestamp:   frame.timestamp,
            msgID,
            messageName: decoded?.messageName ?? `CAN_${msgID}`,
            data:        decoded?.signals ?? {},
            rawData:     this.bytesToRawData(bytes),
            direction:   frame.direction,
          };

          let bucket = byMsgId.get(msgID);
          if (!bucket) { bucket = []; byMsgId.set(msgID, bucket); }
          bucket.push(sample);
        }
      }

      this.warmCache = { byMsgId, startMs, endMs };
    } catch (e) {
      console.warn("[DataStore] prefetchWarmCache failed:", e);
    } finally {
      this.warmCacheLoading = false;
      this.notifyColdState();
    }
  }

  /** Clear the warm cache (e.g. when returning to live mode). */
  public clearWarmCache(): void {
    this.warmCache = null;
  }

  // ── Trace buffer API ──────────────────────────────────────────────────────

  /**
   * Get a snapshot of the flat chronological trace buffer.
   * Returns a shallow copy to prevent external mutation.
   */
  public getTrace(source: TelemetrySource = this.activeSource): TelemetrySample[] {
    return [...this.getSourceBuffers(source).trace];
  }

  /**
   * Clear only the trace buffer (does not affect per-ID history).
   */
  public clearTrace(source: TelemetrySource = this.activeSource): void {
    this.getSourceBuffers(source).trace = [];
    this.scheduleSnapshotSave();
    this.notifyTrace();
  }

  private pruneTraceBuffer(referenceTimeMs: number, source: TelemetrySource = this.activeSource): void {
    if (source === "replay") return;

    const cutoffTime = referenceTimeMs - this.retentionWindowMs;
    const buffers    = this.getSourceBuffers(source);

    // Time-based eviction — evicted frames go to cold store.
    const keepIdx = binarySearchFirstGte(buffers.trace, cutoffTime);
    if (keepIdx > 0) {
      const evicted = buffers.trace.splice(0, keepIdx);
      this.evictToColdStore(evicted);
    }

    // Hard cap eviction (safety valve for very high bus rates).
    if (buffers.trace.length > TRACE_BUFFER_HARD_MAX) {
      const excess  = buffers.trace.length - TRACE_BUFFER_HARD_MAX;
      const evicted = buffers.trace.splice(0, excess);
      this.evictToColdStore(evicted);
    }
  }

  /**
   * Convert evicted TelemetrySamples to compact RawCanFrames and hand them
   * off to ColdStore for background OPFS writing.
   */
  private evictToColdStore(samples: TelemetrySample[]): void {
    if (samples.length === 0 || !coldStore.isReady()) return;

    const frames: RawCanFrame[] = [];
    for (const sample of samples) {
      const canId = this.msgIdToCanId(sample.msgID);
      if (canId === null) continue;
      const compactHex = this.rawDataToCompactHex(sample.rawData);
      if (compactHex === null) continue;
      const bytes = this.compactHexToBytes(compactHex);
      const data  = new Uint8Array(8);
      for (let i = 0; i < Math.min(bytes.length, 8); i++) data[i] = bytes[i];

      frames.push({
        timestamp: sample.timestamp,
        canId,
        direction: sample.direction ?? "rx",
        dlc:       bytes.length,
        data,
      });
    }

    if (frames.length > 0) coldStore.queueFrames(frames);
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
  public clearMessage(msgID: string, source: TelemetrySource = this.activeSource): void {
    this.getSourceBuffers(source).byMsgId.delete(msgID);
    this.scheduleSnapshotSave();
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
    for (const source of ["live", "replay"] as TelemetrySource[]) {
      const byMsgId = this.getSourceBuffers(source).byMsgId;
      for (const msgID of byMsgId.keys()) {
        this.pruneOldSamples(msgID, source);
      }

      const trace = this.getSourceBuffers(source).trace;
      const newestTraceSample = trace[trace.length - 1];
      if (newestTraceSample) {
        this.pruneTraceBuffer(newestTraceSample.timestamp, source);
      }
    }

    // Notify subscribers since data might have been pruned
    this.scheduleSnapshotSave();
    this.notifyAll();
    this.notifyTrace();
  }

  /**
   * Get current retention window
   * @returns Retention window in milliseconds
   */
  public getRetentionWindow(): number {
    return this.retentionWindowMs;
  }

  /**
   * Get statistics about the hot buffer and cold store.
   */
  public getStats(source: TelemetrySource = this.activeSource): {
    totalMessages: number;
    totalSamples: number;
    oldestSample: number | null;
    newestSample: number | null;
    memoryEstimateMB: number;
    coldSizeBytes: number;
    coldDurationMs: number;
    coldNearingLimit: boolean;
  } {
    let totalSamples = 0;
    let oldestSample: number | null = null;
    let newestSample: number | null = null;

    const byMsgId = this.getSourceBuffers(source).byMsgId;
    for (const messageBuffer of byMsgId.values()) {
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

    // Memory estimate: ~600 bytes per decoded TelemetrySample (JS object overhead,
    // string interning, signal sub-objects).  Counts hot-buffer byMsgId only —
    // trace shares the same object references so is not double-counted.
    const avgSampleSize    = 600;
    const memoryEstimateMB = (totalSamples * avgSampleSize) / (1024 * 1024);

    return {
      totalMessages:    byMsgId.size,
      totalSamples,
      oldestSample,
      newestSample,
      memoryEstimateMB: Math.round(memoryEstimateMB * 100) / 100,
      coldSizeBytes:    source === "live" ? coldStore.getTotalBytes() : 0,
      coldDurationMs:   source === "live" ? coldStore.getSessionDurationMs() : 0,
      coldNearingLimit: source === "live" ? coldStore.isNearingLimit() : false,
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