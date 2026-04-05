import { beforeEach, describe, expect, it, vi } from "vitest";

const processWebSocketMessage = vi.fn();
const createCanProcessor = vi.fn(async () => ({
  processWebSocketMessage,
}));

vi.mock("../utils/canProcessor", () => ({
  createCanProcessor,
}));

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

  emitClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

describe("WebSocketService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    localStorage.clear();
    // Avoid multi-URL default failover (10.71… then demo) so tests stay fast unless overridden.
    localStorage.setItem("pecan-ws-candidates", "wss://ws-demo.westernformularacing.org");
  });

  it("connects using custom URL from localStorage", async () => {
    localStorage.clear();
    localStorage.setItem("custom-ws-url", "my-host:1234");
    const { WebSocketService } = await import("./WebSocketService");

    const svc = new WebSocketService();
    await svc.initialize();

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe("ws://my-host:1234");
  });

  it("emits decoded events from processor", async () => {
    processWebSocketMessage.mockReturnValue({ canId: 256 });
    const { WebSocketService } = await import("./WebSocketService");

    const svc = new WebSocketService();
    const decodedSpy = vi.fn();
    svc.on("decoded", decodedSpy);

    await svc.initialize();
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    ws.emitMessage({ canId: 256, data: [1, 2] });

    expect(processWebSocketMessage).toHaveBeenCalled();
    expect(decodedSpy).toHaveBeenCalledWith({ canId: 256 });
  });

  it("sendCanMessage returns false when disconnected", async () => {
    const { WebSocketService } = await import("./WebSocketService");
    const svc = new WebSocketService();
    expect(svc.sendCanMessage(256, [1, 2], "ref")).toBe(false);
  });

  it("sendCanMessage sends payload when connected", async () => {
    const { WebSocketService } = await import("./WebSocketService");
    const svc = new WebSocketService();

    await svc.initialize();
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();

    const ok = svc.sendCanMessage(256, [1, 2, 3], "abc");
    expect(ok).toBe(true);
    expect(ws.sent[0]).toContain('"type":"can_send"');
    expect(ws.sent[0]).toContain('"canId":256');
  });

  it("retries reconnect on abnormal close", async () => {
    vi.useFakeTimers();
    const { WebSocketService } = await import("./WebSocketService");
    const svc = new WebSocketService();

    await svc.initialize();
    const ws = MockWebSocket.instances[0];
    ws.emitClose(1006);

    vi.advanceTimersByTime(2100);
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
  });
});
