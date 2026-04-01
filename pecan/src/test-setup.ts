import { afterEach, beforeEach, vi } from "vitest";
import { dataStore } from "./lib/DataStore";

function ensureLocalStorage(): void {
  const hasStorage =
    typeof globalThis.localStorage !== "undefined" &&
    typeof globalThis.localStorage.getItem === "function" &&
    typeof globalThis.localStorage.setItem === "function" &&
    typeof globalThis.localStorage.removeItem === "function" &&
    typeof globalThis.localStorage.clear === "function";

  if (hasStorage) return;

  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value));
    },
    removeItem: (key: string) => {
      store.delete(String(key));
    },
    clear: () => {
      store.clear();
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureLocalStorage();
});

afterEach(() => {
  // Reset timers/mocks across suites that use debounce/reconnect backoff.
  vi.useRealTimers();

  // DataStore is a singleton; clear between tests to avoid cross-test bleed.
  dataStore.clear();
});
