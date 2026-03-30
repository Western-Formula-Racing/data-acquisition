import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ingestMessage: vi.fn(),
  clear: vi.fn(),
  setSuppressIngestion: vi.fn(),
  decodeAndIngestCanFrame: vi.fn(),
  formatCanId: vi.fn((id: number) => `0x${id.toString(16).toUpperCase()}`),
}));

vi.mock("../lib/DataStore", () => ({
  dataStore: {
    ingestMessage: mocks.ingestMessage,
    clear: mocks.clear,
  },
}));

vi.mock("./WebSocketService", () => ({
  webSocketService: {
    setSuppressIngestion: mocks.setSuppressIngestion,
  },
}));

vi.mock("../utils/canProcessor", () => ({
  createCanProcessor: vi.fn(async () => ({ can: { mocked: true } })),
  decodeAndIngestCanFrame: mocks.decodeAndIngestCanFrame,
  formatCanId: mocks.formatCanId,
}));

import { SerialService } from "./SerialService";

function buildMockPort() {
  const write = vi.fn(async () => {});
  const releaseLock = vi.fn();
  return {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    readable: null,
    writable: {
      getWriter: () => ({
        write,
        releaseLock,
      }),
    },
    write,
  };
}

describe("SerialService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("alert", vi.fn());
  });

  it("returns false when Web Serial API is unavailable", async () => {
    Object.defineProperty(globalThis.navigator, "serial", {
      value: undefined,
      configurable: true,
    });

    const service = new SerialService();
    const ok = await service.connect();

    expect(ok).toBe(false);
  });

  it("connect initializes serial and suppresses websocket ingestion", async () => {
    const port = buildMockPort();
    Object.defineProperty(globalThis.navigator, "serial", {
      value: {
        requestPort: vi.fn(async () => port),
        getPorts: vi.fn(async () => []),
      },
      configurable: true,
    });

    const service = new SerialService();
    const ok = await service.connect();

    expect(ok).toBe(true);
    expect(port.open).toHaveBeenCalledWith({ baudRate: 115200 });
    expect(mocks.setSuppressIngestion).toHaveBeenCalledWith(true);
    expect(mocks.clear).toHaveBeenCalled();
    expect(port.write).toHaveBeenCalledTimes(3);
  });

  it("parses standard slcan frame and ingests decoded frame", async () => {
    const service = new SerialService() as any;
    await Promise.resolve();
    service.canInstance = { mocked: true };

    await service.parseSlcanMessage("t1232A1B2");
    await Promise.resolve();

    expect(mocks.decodeAndIngestCanFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        canId: 0x123,
        data: [0xa1, 0xb2],
      })
    );
  });

  it("falls back to raw ingest when decoder is unavailable", async () => {
    const service = new SerialService() as any;
    await Promise.resolve();
    service.canInstance = null;
    service.processorPromise = Promise.resolve(null);

    await service.ingestFrame(0x222, [0xaa, 0xbb]);

    expect(mocks.ingestMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        msgID: "0x222",
        rawData: "AA BB",
      })
    );
  });
});
