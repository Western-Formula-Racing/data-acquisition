import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let authCallback: ((user: any) => void) | null = null;
  const setDoc = vi.fn(async () => {});
  const getDoc = vi.fn(async () => ({
    exists: () => true,
    data: () => ({ config_data: { viewMode: "trace" } }),
  }));
  const doc = vi.fn((db: unknown, collection: string, id: string) => ({ db, collection, id }));
  const onAuthStateChanged = vi.fn((_auth: unknown, cb: (user: any) => void) => {
    authCallback = cb;
    return () => {
      authCallback = null;
    };
  });

  return {
    getAuthCallback: () => authCallback,
    clearAuthCallback: () => {
      authCallback = null;
    },
    setDoc,
    getDoc,
    doc,
    onAuthStateChanged,
  };
});

vi.mock("../lib/firebase", () => ({
  auth: { app: "test-auth" },
  db: { app: "test-db" },
}));

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: mocks.onAuthStateChanged,
}));

vi.mock("firebase/firestore", () => ({
  doc: mocks.doc,
  setDoc: mocks.setDoc,
  getDoc: mocks.getDoc,
}));

import { useRemoteConfig } from "./useRemoteConfig";

describe("useRemoteConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clearAuthCallback();
    vi.useFakeTimers();
  });

  it("updates user/session from auth callback", () => {
    const { result } = renderHook(() => useRemoteConfig());

    act(() => {
      mocks.getAuthCallback()?.({ uid: "u1", email: "u1@test.com" });
    });

    expect(result.current.user?.uid).toBe("u1");
    expect(result.current.session?.user.id).toBe("u1");
  });

  it("saveConfig is debounced and writes to firestore", async () => {
    const { result } = renderHook(() => useRemoteConfig());

    act(() => {
      mocks.getAuthCallback()?.({ uid: "u1", email: "u1@test.com" });
    });

    act(() => {
      result.current.saveConfig({ viewMode: "trace" });
    });

    expect(mocks.setDoc).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    expect(mocks.setDoc).toHaveBeenCalledTimes(1);
    expect(mocks.doc).toHaveBeenCalledWith(expect.anything(), "user_configs", "u1");
  });

  it("loadConfig returns config data and toggles loading", async () => {
    const { result } = renderHook(() => useRemoteConfig());

    act(() => {
      mocks.getAuthCallback()?.({ uid: "u2", email: "u2@test.com" });
    });

    let loaded: any = null;
    await act(async () => {
      loaded = await result.current.loadConfig();
    });

    expect(loaded).toEqual({ viewMode: "trace" });
    expect(result.current.loading).toBe(false);
    expect(mocks.getDoc).toHaveBeenCalledTimes(1);
  });

  it("loadConfig returns null on firestore error", async () => {
    mocks.getDoc.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useRemoteConfig());

    act(() => {
      mocks.getAuthCallback()?.({ uid: "u3", email: "u3@test.com" });
    });

    let loaded: any = "x";
    await act(async () => {
      loaded = await result.current.loadConfig();
    });

    expect(loaded).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
