import { loggingService, type CanFrame } from './LoggingService';
import { createCanProcessor } from '../utils/canProcessor';

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

  public async syncToInflux(
    url: string,
    token: string,
    org: string,
    bucket: string,
    onProgress?: (processed: number, total: number) => void
  ) {
    if (this.syncing) return;
    this.syncing = true;

    try {
      const total = await loggingService.getUnsyncedCount();
      let processed = 0;
      const batchSize = 100;

      const processor = await this.getProcessor();

      while (true) {
        const frames = await loggingService.getUnsyncedFrames(batchSize);
        if (frames.length === 0) break;

        const lineProtocolBatch: string[] = [];

        for (const frame of frames) {
          const decoded = processor.decode(frame.canId, frame.data, frame.time);
          if (decoded && decoded.signals) {
            // InfluxDB Line Protocol: measurement,tags fields timestamp(ns)
            const timestampNs = frame.time * 1000000;
            
            for (const [sigName, sigData] of Object.entries(decoded.signals)) {
              const value = (sigData as any).sensorReading;
              if (typeof value !== 'number') continue;

              const tags = `signalName=${this.escapeTag(sigName)},messageName=${this.escapeTag(decoded.messageName)},canId=${frame.canId}`;
              const fields = `sensorReading=${value}`;
              lineProtocolBatch.push(`WFR25,${tags} ${fields} ${timestampNs}`);
            }
          }
        }

        if (lineProtocolBatch.length > 0) {
          await this.uploadToInflux(url, token, org, bucket, lineProtocolBatch);
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

  private escapeTag(val: string): string {
    return val.replace(/ /g, '\\ ').replace(/,/g, '\\,').replace(/=/g, '\\=');
  }

  private async uploadToInflux(
    url: string,
    token: string,
    org: string,
    bucket: string,
    lines: string[]
  ) {
    // InfluxDB 3 / InfluxDB 2 write endpoint: /api/v2/write
    const writeUrl = `${url}/api/v2/write?org=${org}&bucket=${bucket}&precision=ns`;
    
    const response = await fetch(writeUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'text/plain; charset=utf-8',
        'Accept': 'application/json'
      },
      body: lines.join('\n')
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`InfluxDB write failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
  }
}

export const syncService = new SyncService();
