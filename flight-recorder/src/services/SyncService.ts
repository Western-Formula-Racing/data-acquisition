import { loggingService } from './LoggingService';
import { createCanProcessor } from '../utils/canProcessor';

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface SyncConfig {
  apiEndpoint: string;  // e.g. "https://data.westernformularacing.org"
  season: string;       // e.g. "wfr26"
}

export class SyncService {
  private syncing = false;
  private processor: any = null;

  private async getProcessor() {
    if (!this.processor) {
      this.processor = await createCanProcessor();
    }
    return this.processor;
  }

  public isSyncing(): boolean {
    return this.syncing;
  }

  /**
   * Sync recorded CAN frames to the server TimescaleDB via REST API.
    * Replaces the legacy line protocol upload path.
   */
  public async syncToServer(
    config: SyncConfig,
    onProgress?: (processed: number, total: number) => void
  ) {
    if (this.syncing) return;
    this.syncing = true;

    try {
      const total = await loggingService.getUnsyncedCount();
      let processed = 0;
      const batchSize = 5000;

      const processor = await this.getProcessor();

      while (true) {
        const frames = await loggingService.getUnsyncedFrames(batchSize);
        if (frames.length === 0) break;

        // Build batch payload for POST /api/can-frames/batch
        const batchFrames: Array<{
          time: string;
          can_id: number;
          message_name: string;
          signals: Record<string, number>;
        }> = [];

        for (const frame of frames) {
          const decoded = processor.decode(frame.canId, frame.data, frame.time);
          if (decoded && decoded.signals) {
            const signals: Record<string, number> = {};
            for (const [name, s] of Object.entries(decoded.signals)) {
              if (typeof (s as any).sensorReading === 'number' && isFinite((s as any).sensorReading)) {
                signals[name] = (s as any).sensorReading;
              }
            }
            if (Object.keys(signals).length > 0) {
              batchFrames.push({
                time: new Date(frame.time * 1000).toISOString(),
                can_id: frame.canId,
                message_name: decoded.messageName,
                signals,
              });
            }
          }
        }

        if (batchFrames.length > 0) {
          await this.uploadBatch(config.apiEndpoint, config.season, batchFrames);
        }

        const ids = frames.map(f => f.id!).filter(id => id !== undefined);
        await loggingService.markAsSynced(ids);

        processed += frames.length;
        if (onProgress) {
          onProgress(processed, total);
        }
      }

      console.log('[SyncService] Sync completed');
    } catch (error) {
      console.error('[SyncService] Sync failed:', error);
      throw error;
    } finally {
      this.syncing = false;
    }
  }

  public async testConnection(
    apiEndpoint: string
  ): Promise<ConnectionTestResult> {
    try {
      const response = await fetch(`${apiEndpoint}/api/health`, {
        method: 'GET',
        credentials: 'omit',
      });

      if (response.ok) {
        return { ok: true, message: `Connected to ${apiEndpoint}` };
      } else {
        const text = await response.text();
        return { ok: false, message: `${response.status} ${response.statusText}: ${text.slice(0, 120)}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isNetworkErr = /load failed|failed to fetch|network/i.test(msg);
      return {
        ok: false,
        message: isNetworkErr
          ? `Cannot reach ${apiEndpoint} — check URL/network/CORS.`
          : msg,
      };
    }
  }

  private async uploadBatch(
    apiEndpoint: string,
    season: string,
    frames: Array<{
      time: string;
      can_id: number;
      message_name: string;
      signals: Record<string, number>;
    }>
  ) {
    const response = await fetch(`${apiEndpoint}/api/can-frames/batch`, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ season, frames }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Batch upload failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
  }

  /** Drop the cached processor so the next sync creates a fresh one from the current dbcFile. */
  public invalidateProcessor(): void {
    this.processor = null;
  }
}

export const syncService = new SyncService();
