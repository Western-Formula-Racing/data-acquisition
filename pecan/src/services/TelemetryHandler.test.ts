import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, Set<(data: any) => void>>();
const ingestMessage = vi.fn();
const isIngestionSuppressed = vi.fn(() => false);
const getMessageCount = vi.fn(() => 0);

vi.mock('./WebSocketService', () => ({
  webSocketService: {
    on: vi.fn((type: string, handler: (data: any) => void) => {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
    }),
    isIngestionSuppressed,
    getMessageCount,
  },
}));

vi.mock('../lib/DataStore', () => ({
  dataStore: {
    ingestMessage,
  },
}));

function emit(type: string, data: any): void {
  handlers.get(type)?.forEach((handler) => handler(data));
}

describe('TelemetryHandler', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it('routes UTS and relay heartbeat frames to the heartbeat diagnostic message', async () => {
    const { DIAG_MSG_IDS, telemetryHandler } = await import('./TelemetryHandler');
    telemetryHandler.initialize();

    emit('decoded', [
      { canId: 1999, signals: {}, rawData: '00 00 00 00 00 00 00 00', time: 1000 },
      { canId: 0x7FD, signals: {}, rawData: 'FA AA FA AA 00 00 00 00', time: 2000 },
    ]);

    expect(ingestMessage).toHaveBeenCalledTimes(2);
    expect(ingestMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      msgID: DIAG_MSG_IDS.HEARTBEAT,
      messageName: 'Heartbeat',
      timestamp: 1000,
    }));
    expect(ingestMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      msgID: DIAG_MSG_IDS.HEARTBEAT,
      messageName: 'Heartbeat',
      timestamp: 2000,
    }));
  });
});
