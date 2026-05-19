import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveRelayService } from './LiveRelayService';
import { webSocketService } from './WebSocketService';

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

function emitSourceStatus(url: string): void {
  (webSocketService as any).notify('status', { connected: true, url });
}

function emitWireMessage(raw: string): void {
  (webSocketService as any).notify('wire', raw);
}

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) throw new Error('Expected relay WebSocket to be created');
  return socket;
}

function parseHeartbeat(raw: string) {
  return JSON.parse(raw)[0] as { canId: number; data: number[] };
}

describe('LiveRelayService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new MemoryStorage(),
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: MockWebSocket,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: globalThis,
    });
    liveRelayService.shutdown();
    localStorage.clear();
  });

  afterEach(() => {
    liveRelayService.shutdown();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('creates sessions from a Worker origin even when the input is an old ingest URL', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        room: 'new-room',
        ingestUrl: 'wss://relay.example/ingest?room=new-room',
        viewerUrl: 'wss://relay.example/viewer?room=new-room',
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    await liveRelayService.createSession('wss://relay.example/ingest?room=old-room#stale');

    expect(fetchMock).toHaveBeenCalledWith('https://relay.example/session', { method: 'POST' });
  });

  it('sends the synthetic relay heartbeat immediately and once per second', () => {
    liveRelayService.initialize();
    liveRelayService.setConfig('wss://relay.example/ingest?room=test', true);

    const socket = latestSocket();
    socket.open();

    expect(socket.sent).toHaveLength(1);
    expect(parseHeartbeat(socket.sent[0])).toMatchObject({
      canId: 0x7FD,
      data: [0xFA, 0xAA, 0xFA, 0xAA, 0, 0, 0, 0],
    });

    vi.advanceTimersByTime(1000);
    expect(socket.sent).toHaveLength(2);

    vi.advanceTimersByTime(3000);
    expect(socket.sent).toHaveLength(5);
  });

  it('does not forward telemetry from the hosted demo source', () => {
    liveRelayService.initialize();
    liveRelayService.setConfig('wss://relay.example/ingest?room=test', true);

    const socket = latestSocket();
    socket.open();
    emitSourceStatus('wss://ws-demo.westernformularacing.org');
    emitWireMessage(JSON.stringify([{ canId: 0x123, data: [1, 2, 3], time: 1000 }]));

    expect(socket.sent).toHaveLength(1);
    expect(parseHeartbeat(socket.sent[0]).canId).toBe(0x7FD);
  });

  it('forwards telemetry from a non-demo source', () => {
    const raw = JSON.stringify([{ canId: 0x123, data: [1, 2, 3], time: 1000 }]);

    liveRelayService.initialize();
    liveRelayService.setConfig('wss://relay.example/ingest?room=test', true);

    const socket = latestSocket();
    socket.open();
    emitSourceStatus('ws://192.168.0.42:9080');
    emitWireMessage(raw);

    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toBe(raw);
  });
});
