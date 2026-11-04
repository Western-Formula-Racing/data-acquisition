import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

async function loadBaseStation(config: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => config })
  );
  const { loadBaseStationConfig } = await import("../lib/baseStation");
  await loadBaseStationConfig();
}

function stubPageUrl(url: string) {
  const { protocol, hostname } = new URL(url);
  vi.stubGlobal("location", { protocol, hostname, pathname: "/" });
}

describe("WebSocketService", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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

  it("tries localhost WebSocket first on localhost pages", async () => {
    localStorage.clear();
    window.history.pushState({}, "", "http://localhost:3000/");
    const { WebSocketService } = await import("./WebSocketService");

    const svc = new WebSocketService();

    expect((svc as any).resolveCandidateUrls()[0]).toBe("ws://localhost:9080");
  });

  it("tries its own host first on a LAN page", async () => {
    localStorage.clear();
    stubPageUrl("http://192.168.20.1:3000/");
    const { WebSocketService } = await import("./WebSocketService");

    const svc = new WebSocketService();

    expect((svc as any).resolveCandidateUrls()[0]).toBe("ws://192.168.20.1:9080");
  });

  it("leaves the hosted site's candidates alone", async () => {
    localStorage.clear();
    stubPageUrl("https://pecan.westernformularacing.org/");
    const { WebSocketService } = await import("./WebSocketService");

    const urls: string[] = (new WebSocketService() as any).resolveCandidateUrls();

    expect(urls).toContain("wss://ws-demo.westernformularacing.org");
    expect(urls.some((url) => url.includes("pecan.westernformularacing.org"))).toBe(false);
  });

  describe("served from a base station", () => {
    const config = { mode: "base-station", viewerOnly: true, wsPort: 9080 };

    it("connects only to the Pi that served the page", async () => {
      localStorage.clear();
      stubPageUrl("http://192.168.20.1/");
      await loadBaseStation(config);
      const { WebSocketService } = await import("./WebSocketService");

      expect((new WebSocketService() as any).resolveCandidateUrls()).toEqual([
        "ws://192.168.20.1:9080",
      ]);
    });

    it("follows whichever name the page was opened with", async () => {
      localStorage.clear();
      stubPageUrl("http://pecan.wfr/");
      await loadBaseStation(config);
      const { WebSocketService } = await import("./WebSocketService");

      expect((new WebSocketService() as any).resolveCandidateUrls()).toEqual([
        "ws://pecan.wfr:9080",
      ]);
    });

    it("ignores saved URLs for viewers, who can't reach Settings to fix them", async () => {
      localStorage.clear();
      localStorage.setItem("custom-ws-url", "wss://ws-demo.westernformularacing.org");
      localStorage.setItem("pecan-ws-candidates", "wss://ws-demo.westernformularacing.org");
      stubPageUrl("http://192.168.20.1/");
      await loadBaseStation(config);
      const { WebSocketService } = await import("./WebSocketService");

      expect((new WebSocketService() as any).resolveCandidateUrls()).toEqual([
        "ws://192.168.20.1:9080",
      ]);
    });

    it("keeps saved URLs when the Pi isn't view-only", async () => {
      localStorage.clear();
      localStorage.setItem("custom-ws-url", "ws://10.71.1.10:9080");
      stubPageUrl("http://192.168.20.1/");
      await loadBaseStation({ ...config, viewerOnly: false });
      const { WebSocketService } = await import("./WebSocketService");

      expect((new WebSocketService() as any).resolveCandidateUrls()).toEqual([
        "ws://10.71.1.10:9080",
      ]);
    });

    it("keeps retrying long after the normal limit", async () => {
      localStorage.clear();
      stubPageUrl("http://192.168.20.1/");
      await loadBaseStation(config);
      const { WebSocketService } = await import("./WebSocketService");
      vi.useFakeTimers();

      const svc = new WebSocketService();
      await svc.initialize();

      for (let attempt = 0; attempt < 20; attempt++) {
        MockWebSocket.instances[MockWebSocket.instances.length - 1].emitClose(1006);
        await vi.advanceTimersByTimeAsync(10_000);
      }

      expect(MockWebSocket.instances).toHaveLength(21);
      svc.disconnect();
    });

    it("reconnects when the page wakes on a quiet socket", async () => {
      localStorage.clear();
      stubPageUrl("http://192.168.20.1/");
      await loadBaseStation(config);
      const { WebSocketService } = await import("./WebSocketService");

      const svc = new WebSocketService();
      await svc.initialize();
      MockWebSocket.instances[0].emitOpen();

      window.dispatchEvent(new Event("online"));

      expect(MockWebSocket.instances).toHaveLength(2);
      svc.disconnect();
    });

    it("stays closed after a deliberate disconnect when the page wakes", async () => {
      localStorage.clear();
      stubPageUrl("http://192.168.20.1/");
      await loadBaseStation(config);
      const { WebSocketService } = await import("./WebSocketService");

      const svc = new WebSocketService();
      await svc.initialize();
      MockWebSocket.instances[0].emitOpen();
      svc.disconnect();

      window.dispatchEvent(new Event("online"));

      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it("leaves a socket that is still receiving alone when the page wakes", async () => {
      localStorage.clear();
      stubPageUrl("http://192.168.20.1/");
      await loadBaseStation(config);
      const { WebSocketService } = await import("./WebSocketService");

      const svc = new WebSocketService();
      await svc.initialize();
      MockWebSocket.instances[0].emitOpen();
      MockWebSocket.instances[0].emitMessage({ type: "ping" });

      window.dispatchEvent(new Event("online"));

      expect(MockWebSocket.instances).toHaveLength(1);
      svc.disconnect();
    });
  });

  it("still stops retrying when not served from a base station", async () => {
    vi.useFakeTimers();
    const { WebSocketService } = await import("./WebSocketService");

    const svc = new WebSocketService();
    await svc.initialize();

    for (let attempt = 0; attempt < 8; attempt++) {
      MockWebSocket.instances[MockWebSocket.instances.length - 1].emitClose(1006);
      await vi.advanceTimersByTimeAsync(10_000);
    }

    expect(MockWebSocket.instances).toHaveLength(6);
  });

  it("does not let a replaced socket start a second connection", async () => {
    vi.useFakeTimers();
    const { WebSocketService } = await import("./WebSocketService");

    const svc = new WebSocketService();
    await svc.initialize();
    const replaced = MockWebSocket.instances[0];

    (svc as any).ws = null;
    await (svc as any).connect();
    replaced.emitClose(1006);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(MockWebSocket.instances).toHaveLength(2);
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
