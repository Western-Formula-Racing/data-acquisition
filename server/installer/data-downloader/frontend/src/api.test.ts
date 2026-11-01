import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalysisConfig, deleteAnalysisConfig, fetchAnalysisConfigs, querySeries } from "./api";

describe("querySeries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs JSON body to /api/series", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        season: "wfr26",
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-01T01:00:00Z",
        series: {},
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = {
      season: "wfr26",
      signals: ["A", "B"],
      start: "2026-01-01T00:00:00Z",
      end: "2026-01-01T01:00:00Z",
      target_points: 4000,
    };
    await querySeries(payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/series");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it("surfaces server detail on errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ detail: "TimescaleDB unavailable" }),
      }),
    );

    await expect(
      querySeries({
        season: "wfr26",
        signals: ["A"],
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-01T01:00:00Z",
        target_points: 4000,
      }),
    ).rejects.toThrow("TimescaleDB unavailable");
  });

  it("surfaces non-JSON error bodies as plain text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => "Bad Gateway from upstream",
      }),
    );

    await expect(
      querySeries({
        season: "wfr26",
        signals: ["A"],
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-01T01:00:00Z",
        target_points: 4000,
      }),
    ).rejects.toThrow("Bad Gateway from upstream");
  });

  it("falls back when the error body is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "",
      }),
    );

    await expect(
      querySeries({
        season: "wfr26",
        signals: ["A"],
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-01T01:00:00Z",
        target_points: 4000,
      }),
    ).rejects.toThrow("Request failed (500)");
  });
});

describe("analysis configs api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("unwraps the configs array from the list response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ configs: [{ id: "a", name: "n" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const configs = await fetchAnalysisConfigs();

    expect(configs).toEqual([{ id: "a", name: "n" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/analysis-configs",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("POSTs a create payload and returns the created config", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "x", name: "brake" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await createAnalysisConfig({
      name: "brake",
      note: "",
      author: "",
      season: "wfr26",
      start: "2026-06-20T15:00:00.000Z",
      end: "2026-06-20T15:05:00.000Z",
      plots: [{ signals: ["A"], rightAxis: [] }],
    });

    expect(created.id).toBe("x");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
  });

  it("DELETEs by id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await deleteAnalysisConfig("x");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/analysis-configs/x");
    expect(init.method).toBe("DELETE");
  });
});
