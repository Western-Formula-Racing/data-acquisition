import { loggingService } from './LoggingService';
import { createCanProcessor } from '../utils/canProcessor';

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
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
          await this.uploadToInflux(
            url,
            token,
            org,
            bucket,
            lineProtocolBatch
          );
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
    url: string,
    token: string,
    bucket: string
  ): Promise<ConnectionTestResult> {
    try {
      const response = await fetch(`${url}/api/v3/query_sql`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ db: bucket, q: 'SELECT 1' }),
      });

      if (response.ok) {
        return { ok: true, message: `Connected to ${bucket}` };
      } else {
        const redirectedToAccess = response.redirected && /cdn-cgi\/access\/login/i.test(response.url);
        if (redirectedToAccess) {
          return {
            ok: false,
            message: `Cloudflare Access login required. Open ${url} in this browser and sign in with Google, then test again.`,
          };
        }

        const text = await response.text();
        const accessHint = response.status === 401 || response.status === 403
          ? ' Cloudflare Access session may be missing; sign in to Access in this browser.'
          : '';
        return { ok: false, message: `${response.status} ${response.statusText}: ${text.slice(0, 120)}${accessHint}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "Load failed" / "Failed to fetch" means network-level failure (no server, CORS, etc.)
      const isNetworkErr = /load failed|failed to fetch|network/i.test(msg);
      return {
        ok: false,
        message: isNetworkErr
          ? `Cannot reach ${url} — check URL/network. If this endpoint is behind Cloudflare Access, sign in to Access in this browser first.`
          : msg,
      };
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
      credentials: 'include',
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
