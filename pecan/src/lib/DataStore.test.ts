import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dataStore, FREQUENCY_WINDOW_MS } from './DataStore';

describe('DataStore', () => {
  beforeEach(() => {
    // Reset the singleton instance or clear its state if possible
    // Since DataStore is a singleton, we'll use public methods to clear it
    dataStore.setRetentionWindow(30000);
    // Note: We might need a 'clear' method for testing if internal state persists
    // For now, we'll try to work with the existing instance
    vi.useFakeTimers();
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
});
