/**
 * ColdStore — OPFS-backed persistent CAN frame archive
 *
 * Stores raw 21-byte binary records to the Origin Private File System in
 * 5-minute time-partitioned chunk files.  DataStore evicts hot-buffer
 * samples here as they age out, so the timeline can still reach historical
 * data on demand without keeping it in the JS heap.
 *
 * Binary record layout (21 bytes, little-endian):
 *   Offset  Size   Field
 *   0       8      Float64  timestamp (ms since Unix epoch)
 *   8       4      Uint32   canId | (direction=="tx" ? 0x80000000 : 0)
 *   12      1      Uint8    dlc (0–8)
 *   13      8      Uint8[8] raw CAN payload, zero-padded to 8 bytes
 *
 * At ~3 000 frames/sec this costs ≈63 KB/s → ≈225 MB/hour.
 * Hard limits: 1 h duration, 500 MB total — oldest chunks are dropped first.
 */

export interface RawCanFrame {
  timestamp: number;
  canId: number;       // without the direction flag
  direction: "rx" | "tx";
  dlc: number;
  data: Uint8Array;    // always 8 bytes, zero-padded
}

interface ChunkMeta {
  filename: string;
  startMs: number;
  endMs: number;
  frameCount: number;
  sizeBytes: number;
}

const COLD_STORE_DIR     = "pecan-cold-store";
const COLD_INDEX_FILE    = "index.json";
const CHUNK_DURATION_MS  = 5 * 60 * 1000;   // 5-minute partitions
const MAX_DURATION_MS    = 60 * 60 * 1000;  // 1 hour hard cap
const WARN_THRESHOLD_MS  = 50 * 60 * 1000;  // warn at 50 minutes
const MAX_BYTES          = 500_000_000;      // 500 MB safety cap
const BYTES_PER_FRAME    = 21;
const FLUSH_INTERVAL_MS  = 2_000;
const MIN_FLUSH_FRAMES   = 500;

export type ColdStoreWarningCallback = (message: string) => void;

class ColdStore {
  private dir: FileSystemDirectoryHandle | null = null;
  private index: ChunkMeta[] = [];
  private ready = false;

  private writeBuffer: RawCanFrame[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> = Promise.resolve();

  private onWarning: ColdStoreWarningCallback | null = null;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (
      typeof navigator === "undefined" ||
      !("storage" in navigator) ||
      typeof (navigator.storage as { getDirectory?: unknown }).getDirectory !== "function"
    ) {
      return; // OPFS unavailable (non-Chromium or SSR)
    }
    try {
      const root = await navigator.storage.getDirectory();
      this.dir = await root.getDirectoryHandle(COLD_STORE_DIR, { create: true });
      await this.loadIndex();
      this.ready = true;
    } catch (e) {
      console.warn("[ColdStore] OPFS init failed:", e);
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  setWarningCallback(cb: ColdStoreWarningCallback): void {
    this.onWarning = cb;
  }

  // ── Index ─────────────────────────────────────────────────────────────────

  private async loadIndex(): Promise<void> {
    try {
      const handle = await this.dir!.getFileHandle(COLD_INDEX_FILE);
      const file   = await handle.getFile();
      const parsed = JSON.parse(await file.text()) as unknown;
      if (Array.isArray(parsed)) this.index = parsed as ChunkMeta[];
    } catch {
      this.index = [];
    }
  }

  private async saveIndex(): Promise<void> {
    if (!this.dir) return;
    try {
      const handle   = await this.dir.getFileHandle(COLD_INDEX_FILE, { create: true });
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(this.index));
      await writable.close();
    } catch (e) {
      console.warn("[ColdStore] Failed to save index:", e);
    }
  }

  // ── Write path ────────────────────────────────────────────────────────────

  /**
   * Queue frames for background write.  Called from the DataStore hot path —
   * must be synchronous and cheap; actual I/O happens in a chained Promise.
   */
  queueFrames(frames: RawCanFrame[]): void {
    if (!this.ready || frames.length === 0) return;
    for (const f of frames) this.writeBuffer.push(f);

    if (this.writeBuffer.length >= MIN_FLUSH_FRAMES) {
      this.triggerFlush();
    } else if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.triggerFlush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  private triggerFlush(): void {
    // Chain so concurrent flushes don't interleave.
    this.flushPromise = this.flushPromise
      .then(() => this.flush())
      .catch((e) => console.warn("[ColdStore] Flush error:", e));
  }

  private async flush(): Promise<void> {
    if (this.writeBuffer.length === 0 || !this.dir) return;

    const frames = this.writeBuffer.splice(0);
    frames.sort((a, b) => a.timestamp - b.timestamp);

    // Group into 5-minute buckets
    const groups = new Map<number, RawCanFrame[]>();
    for (const frame of frames) {
      const key = Math.floor(frame.timestamp / CHUNK_DURATION_MS) * CHUNK_DURATION_MS;
      let grp = groups.get(key);
      if (!grp) { grp = []; groups.set(key, grp); }
      grp.push(frame);
    }

    for (const [chunkStartMs, chunkFrames] of groups) {
      await this.appendChunk(chunkStartMs, chunkFrames);
    }

    await this.enforceLimits();
    await this.saveIndex();
  }

  private async appendChunk(chunkStartMs: number, frames: RawCanFrame[]): Promise<void> {
    if (!this.dir) return;
    const filename = `chunk_${chunkStartMs}.bin`;

    // Build packed binary buffer
    const buf  = new ArrayBuffer(frames.length * BYTES_PER_FRAME);
    const view = new DataView(buf);
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const o = i * BYTES_PER_FRAME;
      view.setFloat64(o,      f.timestamp, /* le= */ true);
      view.setUint32( o + 8,  (f.canId >>> 0) | (f.direction === "tx" ? 0x80000000 : 0), true);
      view.setUint8(  o + 12, f.dlc);
      for (let j = 0; j < 8; j++) {
        view.setUint8(o + 13 + j, j < f.data.length ? f.data[j] : 0);
      }
    }

    try {
      const fh       = await this.dir.getFileHandle(filename, { create: true });
      const existing = await fh.getFile();
      const writable = await fh.createWritable({ keepExistingData: true });
      await writable.seek(existing.size);
      await writable.write(buf);
      await writable.close();

      const added = buf.byteLength;
      const entry = this.index.find(c => c.filename === filename);
      if (entry) {
        entry.endMs      = Math.max(entry.endMs, frames[frames.length - 1].timestamp);
        entry.frameCount += frames.length;
        entry.sizeBytes  += added;
      } else {
        this.index.push({
          filename,
          startMs:    frames[0].timestamp,
          endMs:      frames[frames.length - 1].timestamp,
          frameCount: frames.length,
          sizeBytes:  added,
        });
        this.index.sort((a, b) => a.startMs - b.startMs);
      }
    } catch (e) {
      console.warn("[ColdStore] Failed to append chunk:", filename, e);
    }
  }

  // ── Read path ─────────────────────────────────────────────────────────────

  async loadRange(startMs: number, endMs: number): Promise<RawCanFrame[]> {
    if (!this.dir || !this.ready) return [];

    const relevant = this.index.filter(c => c.startMs <= endMs && c.endMs >= startMs);
    if (relevant.length === 0) return [];

    const result: RawCanFrame[] = [];

    for (const chunk of relevant) {
      try {
        const fh   = await this.dir.getFileHandle(chunk.filename);
        const file = await fh.getFile();
        const buf  = await file.arrayBuffer();
        const view = new DataView(buf);
        const n    = Math.floor(buf.byteLength / BYTES_PER_FRAME);

        for (let i = 0; i < n; i++) {
          const o  = i * BYTES_PER_FRAME;
          const ts = view.getFloat64(o, true);
          if (ts < startMs || ts > endMs) continue;

          const raw = view.getUint32(o + 8, true) >>> 0;
          const dlc = view.getUint8(o + 12);
          const data = new Uint8Array(8);
          for (let j = 0; j < 8; j++) data[j] = view.getUint8(o + 13 + j);

          result.push({
            timestamp: ts,
            canId:     raw & 0x7FFFFFFF,
            direction: (raw & 0x80000000) !== 0 ? "tx" : "rx",
            dlc,
            data,
          });
        }
      } catch (e) {
        console.warn("[ColdStore] Failed to read chunk:", chunk.filename, e);
      }
    }

    result.sort((a, b) => a.timestamp - b.timestamp);
    return result;
  }

  // ── Sync stats ────────────────────────────────────────────────────────────

  getTimeRange(): { startMs: number; endMs: number } | null {
    if (this.index.length === 0) return null;
    return {
      startMs: this.index[0].startMs,
      endMs:   this.index[this.index.length - 1].endMs,
    };
  }

  getTotalBytes(): number {
    return this.index.reduce((s, c) => s + c.sizeBytes, 0);
  }

  getSessionDurationMs(): number {
    const r = this.getTimeRange();
    return r ? r.endMs - r.startMs : 0;
  }

  isNearingLimit(): boolean {
    return this.getSessionDurationMs() >= WARN_THRESHOLD_MS;
  }

  // ── Limit enforcement ─────────────────────────────────────────────────────

  private async enforceLimits(): Promise<void> {
    if (!this.dir) return;
    let didWarnDuration = false;
    let didWarnSize = false;

    while (this.index.length > 0) {
      const duration = this.getSessionDurationMs();
      const size     = this.getTotalBytes();
      if (duration <= MAX_DURATION_MS && size <= MAX_BYTES) break;

      const oldest = this.index[0];
      try { await this.dir.removeEntry(oldest.filename); } catch { /* ignore */ }
      this.index.shift();

      if (!didWarnDuration && duration > MAX_DURATION_MS) {
        this.onWarning?.("Session cold storage reached 1 h. Oldest data is being discarded.");
        didWarnDuration = true;
      }
      if (!didWarnSize && size > MAX_BYTES) {
        this.onWarning?.("Session cold storage reached 500 MB. Oldest data is being discarded.");
        didWarnSize = true;
      }
    }
  }

  // ── Clear ─────────────────────────────────────────────────────────────────

  async clear(): Promise<void> {
    if (!this.dir) return;
    for (const chunk of this.index) {
      try { await this.dir.removeEntry(chunk.filename); } catch { /* ignore */ }
    }
    try { await this.dir.removeEntry(COLD_INDEX_FILE); } catch { /* ignore */ }
    this.index = [];
  }
}

export const coldStore = new ColdStore();
