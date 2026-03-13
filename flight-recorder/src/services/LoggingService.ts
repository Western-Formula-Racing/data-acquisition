import Dexie, { type Table } from 'dexie';

export interface CanFrame {
  id?: number;
  time: number;
  canId: number;
  data: number[];
  synced: number; // 0 for no, 1 for yes
}

export class FlightDataRecorderDB extends Dexie {
  canFrames!: Table<CanFrame>;

  constructor() {
    super('FlightDataRecorder');
    this.version(1).stores({
      canFrames: '++id, time, canId, synced'
    });
  }
}

export const db = new FlightDataRecorderDB();

export class LoggingService {
  private recording = false;

  public startRecording() {
    console.log('[LoggingService] Recording started');
    this.recording = true;
  }

  public stopRecording() {
    console.log('[LoggingService] Recording stopped');
    this.recording = false;
  }

  public isRecording(): boolean {
    return this.recording;
  }

  public async logFrame(time: number, canId: number, data: number[]) {
    if (!this.recording) return;

    try {
      await db.canFrames.add({
        time,
        canId,
        data,
        synced: 0
      });
    } catch (error) {
      console.error('[LoggingService] Failed to log frame:', error);
    }
  }

  public async getUnsyncedCount(): Promise<number> {
    return await db.canFrames.where('synced').equals(0).count();
  }

  public async getTotalCount(): Promise<number> {
    return await db.canFrames.count();
  }

  public async getUnsyncedFrames(limit = 1000): Promise<CanFrame[]> {
    return await db.canFrames
      .where('synced')
      .equals(0)
      .limit(limit)
      .toArray();
  }

  public async markAsSynced(ids: number[]) {
    await db.canFrames.where('id').anyOf(ids).modify({ synced: 1 });
  }

  public async clearLogs() {
    await db.canFrames.clear();
  }
}

export const loggingService = new LoggingService();
