import { beforeEach, describe, expect, it, vi } from "vitest";

function stubFetch(response: Partial<Response> | Error) {
  const fetchMock =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("baseStation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads the config the Pi serves", async () => {
    stubFetch({
      ok: true,
      json: async () => ({
        mode: "base-station",
        viewerOnly: true,
        wsPort: 9081,
        dbcUrl: "/dbc/active.dbc",
      }),
    });
    const { loadBaseStationConfig, isViewerOnly } = await import("./baseStation");

    expect(await loadBaseStationConfig()).toEqual({
      viewerOnly: true,
      wsPort: 9081,
      dbcUrl: "/dbc/active.dbc",
    });
    expect(isViewerOnly()).toBe(true);
  });

  it("treats a base station as view-only unless told otherwise", async () => {
    stubFetch({ ok: true, json: async () => ({ mode: "base-station" }) });
    const { loadBaseStationConfig } = await import("./baseStation");

    expect(await loadBaseStationConfig()).toEqual({
      viewerOnly: true,
      wsPort: 9080,
      dbcUrl: null,
    });
  });

  it("ignores the file not existing, as on the hosted site", async () => {
    stubFetch({ ok: false, json: async () => ({}) });
    const { loadBaseStationConfig, isViewerOnly } = await import("./baseStation");

    expect(await loadBaseStationConfig()).toBeNull();
    expect(isViewerOnly()).toBe(false);
  });

  it("ignores an HTML fallback page", async () => {
    stubFetch({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    const { loadBaseStationConfig } = await import("./baseStation");

    expect(await loadBaseStationConfig()).toBeNull();
  });

  it("ignores JSON that isn't a base station config", async () => {
    stubFetch({ ok: true, json: async () => ({ mode: "other" }) });
    const { loadBaseStationConfig } = await import("./baseStation");

    expect(await loadBaseStationConfig()).toBeNull();
  });

  it("survives having no network", async () => {
    stubFetch(new TypeError("Failed to fetch"));
    const { loadBaseStationConfig } = await import("./baseStation");

    expect(await loadBaseStationConfig()).toBeNull();
  });

  it("hides the pages that can send to the car", async () => {
    const { isHiddenFromViewers } = await import("./baseStation");

    for (const path of ["/can-transmitter", "/throttle-mapper", "/sensor-validator"]) {
      expect(isHiddenFromViewers(path)).toBe(true);
      expect(isHiddenFromViewers(`${path}/`)).toBe(true);
    }
    expect(isHiddenFromViewers("/dashboard")).toBe(false);
    expect(isHiddenFromViewers("/accumulator")).toBe(false);
  });
});
