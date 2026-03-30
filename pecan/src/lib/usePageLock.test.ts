import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (payload: any) => void;
const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<Handler>>();
  return {
    listeners,
    send: vi.fn(),
    on: vi.fn((type: string, handler: Handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    }),
    off: vi.fn((type: string, handler: Handler) => {
      listeners.get(type)?.delete(handler);
    }),
    isConnected: vi.fn(() => true),
  };
});

vi.mock("../services/WebSocketService", () => ({
  webSocketService: {
    send: mocks.send,
    on: mocks.on,
    off: mocks.off,
    isConnected: mocks.isConnected,
  },
}));

import { usePageLock } from "./usePageLock";

function emit(type: string, payload: any) {
  mocks.listeners.get(type)?.forEach((handler) => handler(payload));
}

describe("usePageLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
  });

  it("queries immediately when socket is connected", () => {
    renderHook(() => usePageLock("can-transmitter", "Driver"));

    expect(mocks.send).toHaveBeenCalledWith({ type: "page_lock", action: "query" });
  });

  it("sends acquire and release payloads", () => {
    const { result } = renderHook(() => usePageLock("can-transmitter", "Driver"));

    act(() => result.current.acquire());
    act(() => result.current.release());

    expect(mocks.send).toHaveBeenCalledWith({
      type: "page_lock",
      action: "acquire",
      page: "can-transmitter",
      name: "Driver",
    });
    expect(mocks.send).toHaveBeenCalledWith({
      type: "page_lock",
      action: "release",
      page: "can-transmitter",
    });
  });

  it("derives lock ownership from events", () => {
    const { result } = renderHook(() => usePageLock("can-transmitter"));

    act(() => {
      emit("page_lock_state", {
        clientId: "c1",
        locks: {
          "can-transmitter": { holder: "c1", name: "Me" },
        },
      });
    });

    expect(result.current.clientId).toBe("c1");
    expect(result.current.isLockedByMe).toBe(true);
    expect(result.current.isLockedByOther).toBe(false);
  });

  it("auto-releases on unmount", () => {
    const { unmount } = renderHook(() => usePageLock("can-transmitter", "Driver"));

    unmount();

    expect(mocks.send).toHaveBeenCalledWith({
      type: "page_lock",
      action: "release",
      page: "can-transmitter",
    });
  });
});
