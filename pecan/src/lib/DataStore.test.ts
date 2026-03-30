import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dataStore, FREQUENCY_WINDOW_MS } from './DataStore';

describe('DataStore', () => {
  beforeEach(() => {
    dataStore.clear();
    dataStore.setRetentionWindow(30000);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should calculate frequency correctly for a single message', () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const msgID = '0x100';
    
    // Ingest 5 messages over 1 second
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(now + i * 200);
      dataStore.ingestMessage({
        msgID,
        messageName: 'TestMsg',
        data: {},
        rawData: '00',
        timestamp: now + i * 200
      });
    }

    // At t=800ms, we have 5 samples in the last 2000ms
    // Frequency = 5 / 2.0 = 2.5 Hz (Wait, the window is 2000ms)
    // Actually, at t=800ms, the window [t-2000, t] is [-1200, 800].
    // It contains all 5 samples.
    // getFrequency(msgID, 2000) should return 5 / 2.0 = 2.5 Hz.
    
    const hz = dataStore.getFrequency(msgID, FREQUENCY_WINDOW_MS);
    expect(hz).toBe(2.5);
  });

  it('should return 0.0 Hz when no messages are received', () => {
    expect(dataStore.getFrequency('non-existent', FREQUENCY_WINDOW_MS)).toBe(0.0);
  });

  it('should drop old samples outside the window', () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const msgID = '0x200';
    
    // Send 10 messages at 10Hz (every 100ms)
    for (let i = 0; i < 10; i++) {
        vi.setSystemTime(now + i * 100);
        dataStore.ingestMessage({
          msgID,
          messageName: 'TestMsg',
          data: {},
          rawData: '00',
          timestamp: now + i * 100
        });
    }

    // At t=900ms, freq is 10 samples / 2s = 5.0 Hz
    expect(dataStore.getFrequency(msgID, FREQUENCY_WINDOW_MS)).toBe(5.0);

    // Advance time by 3 seconds (t=3900ms)
    // The window [1900, 3900] contains 0 samples (last one was at 900)
    vi.setSystemTime(now + 3900);
    expect(dataStore.getFrequency(msgID, FREQUENCY_WINDOW_MS)).toBe(0.0);
  });

  it('should handle multiple message IDs independently', () => {
    const now = Date.now();
    vi.setSystemTime(now);

    dataStore.ingestMessage({ msgID: 'A', messageName: 'A', data: {}, rawData: '00', timestamp: now });
    dataStore.ingestMessage({ msgID: 'A', messageName: 'A', data: {}, rawData: '00', timestamp: now + 500 });
    
    dataStore.ingestMessage({ msgID: 'B', messageName: 'B', data: {}, rawData: '00', timestamp: now });

    vi.setSystemTime(now + 1000);

    expect(dataStore.getFrequency('A', 2000)).toBe(1.0); // 2 samples / 2s
    expect(dataStore.getFrequency('B', 2000)).toBe(0.5); // 1 sample / 2s
  });

  it('should return latest sample at or before cursor time', () => {
    const base = Date.now();
    dataStore.ingestMessage({ msgID: 'X', messageName: 'X', data: {}, rawData: '00', timestamp: base });
    dataStore.ingestMessage({ msgID: 'X', messageName: 'X', data: {}, rawData: '01', timestamp: base + 100 });
    dataStore.ingestMessage({ msgID: 'X', messageName: 'X', data: {}, rawData: '02', timestamp: base + 200 });

    expect(dataStore.getLatestAt('X', base + 150)?.rawData).toBe('01');
    expect(dataStore.getLatestAt('X', base + 50)?.rawData).toBe('00');
    expect(dataStore.getLatestAt('X', base - 1)).toBeUndefined();
  });

  it('should return history in explicit time window with getHistoryAt', () => {
    const base = Date.now();
    dataStore.ingestMessage({ msgID: 'H', messageName: 'H', data: {}, rawData: 'a', timestamp: base });
    dataStore.ingestMessage({ msgID: 'H', messageName: 'H', data: {}, rawData: 'b', timestamp: base + 100 });
    dataStore.ingestMessage({ msgID: 'H', messageName: 'H', data: {}, rawData: 'c', timestamp: base + 200 });

    const windowed = dataStore.getHistoryAt('H', 100, base + 200);
    expect(windowed.map((s) => s.rawData)).toEqual(['b', 'c']);
  });

  it('should return timeline-anchored latest map with getAllLatestAt', () => {
    const base = Date.now();
    dataStore.ingestMessage({ msgID: 'A1', messageName: 'A1', data: {}, rawData: '00', timestamp: base });
    dataStore.ingestMessage({ msgID: 'A1', messageName: 'A1', data: {}, rawData: '01', timestamp: base + 100 });
    dataStore.ingestMessage({ msgID: 'B1', messageName: 'B1', data: {}, rawData: '10', timestamp: base + 50 });

    const anchored = dataStore.getAllLatestAt(base + 75);
    expect(anchored.get('A1')?.rawData).toBe('00');
    expect(anchored.get('B1')?.rawData).toBe('10');
  });

  it('should round sensor values and default direction to rx', () => {
    const base = Date.now();
    dataStore.ingestMessage({
      msgID: 'R1',
      messageName: 'Round',
      data: { temp: { sensorReading: 12.34567, unit: 'C' } },
      rawData: 'AA',
      timestamp: base,
    });

    const latest = dataStore.getLatest('R1');
    expect(latest?.data.temp.sensorReading).toBe(12.346);
    expect(latest?.direction).toBe('rx');
  });

  it('should prune by retention window using newest sample timestamp', () => {
    const base = Date.now();
    dataStore.setRetentionWindow(100);
    dataStore.ingestMessage({ msgID: 'P1', messageName: 'P1', data: {}, rawData: 'old', timestamp: base });
    dataStore.ingestMessage({ msgID: 'P1', messageName: 'P1', data: {}, rawData: 'new', timestamp: base + 200 });

    const history = dataStore.getHistory('P1');
    expect(history.map((s) => s.rawData)).toEqual(['new']);
  });

  it('should notify and unsubscribe listeners', () => {
    const listener = vi.fn();
    const unsub = dataStore.subscribe(listener);

    dataStore.ingestMessage({ msgID: 'S1', messageName: 'S1', data: {}, rawData: '00' });
    expect(listener).toHaveBeenCalledWith('S1');

    unsub();
    dataStore.ingestMessage({ msgID: 'S1', messageName: 'S1', data: {}, rawData: '01' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('should support trace subscriptions and clearTrace', () => {
    const traceListener = vi.fn();
    const unsub = dataStore.subscribeTrace(traceListener);

    dataStore.ingestMessage({ msgID: 'T1', messageName: 'T1', data: {}, rawData: '00' });
    expect(traceListener).toHaveBeenCalledTimes(1);
    expect(dataStore.getTrace()).toHaveLength(1);

    dataStore.clearTrace();
    expect(dataStore.getTrace()).toHaveLength(0);
    expect(traceListener).toHaveBeenCalledTimes(2);

    unsub();
  });

  it('should cap flat trace buffer to max size', () => {
    const base = Date.now();
    for (let i = 0; i < 10010; i += 1) {
      dataStore.ingestMessage({
        msgID: `C${i % 2}`,
        messageName: 'Cap',
        data: {},
        rawData: String(i),
        timestamp: base + i,
      });
    }

    const trace = dataStore.getTrace();
    expect(trace).toHaveLength(10000);
    expect(trace[0].rawData).toBe('10');
  });

  it('should expose stats and clearMessage behavior', () => {
    const base = Date.now();
    dataStore.ingestMessage({ msgID: 'M1', messageName: 'M1', data: {}, rawData: '00', timestamp: base });
    dataStore.ingestMessage({ msgID: 'M2', messageName: 'M2', data: {}, rawData: '11', timestamp: base + 5 });

    const stats = dataStore.getStats();
    expect(stats.totalMessages).toBe(2);
    expect(stats.totalSamples).toBe(2);
    expect(stats.oldestSample).toBe(base);
    expect(stats.newestSample).toBe(base + 5);

    dataStore.clearMessage('M1');
    expect(dataStore.getLatest('M1')).toBeUndefined();
    expect(dataStore.getLatest('M2')?.rawData).toBe('11');
  });
});
