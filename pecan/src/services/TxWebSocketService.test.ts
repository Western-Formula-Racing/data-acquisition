import { beforeEach, describe, expect, it, vi } from "vitest";

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }

  emitOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe("TxWebSocketService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    localStorage.clear();
  });

  it("derives host from custom RX URL", async () => {
    localStorage.setItem("custom-ws-url", "ws://10.0.0.20:9080");
    const { TxWebSocketService } = await import("./TxWebSocketService");

    const svc = new TxWebSocketService();
    svc.connect();

    expect(MockWebSocket.instances[0].url).toContain("10.0.0.20:9078");
  });

  it("returns false for preview/send when disconnected", async () => {
    const { TxWebSocketService } = await import("./TxWebSocketService");
    const svc = new TxWebSocketService();

    expect(svc.previewSignals(256, { a: 1 })).toBe(false);
    expect(svc.sendSignals(256, { a: 1 })).toBe(false);
  });

  it("sends preview and send payloads when connected", async () => {
    const { TxWebSocketService } = await import("./TxWebSocketService");
    const svc = new TxWebSocketService();
    svc.connect();

    const ws = MockWebSocket.instances[0];
    ws.emitOpen();

    expect(svc.previewSignals(256, { a: 1 }, "p1")).toBe(true);
    expect(svc.sendSignals(256, { b: 2 }, "s1")).toBe(true);

    expect(ws.sent[0]).toContain('"type":"can_preview_signals"');
    expect(ws.sent[1]).toContain('"type":"can_send_signals"');
  });

  it("notifies registered listeners", async () => {
    const { TxWebSocketService } = await import("./TxWebSocketService");
    const svc = new TxWebSocketService();
    const listener = vi.fn();

    svc.onMessage(listener);
    svc.connect();

    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    ws.emitMessage({ type: "preview", canId: 256, bytes: [1, 2], ok: true });

    expect(listener).toHaveBeenCalled();
  });
});
