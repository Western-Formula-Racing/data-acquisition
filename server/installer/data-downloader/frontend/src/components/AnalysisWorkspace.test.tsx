import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RunRecord,
  Season,
  SensorsGroupedResponse,
  SeriesResponse,
  StatesResponse,
} from "../types";

vi.mock("../api", () => ({
  fetchSeasons: vi.fn(),
  fetchRuns: vi.fn(),
  fetchSensors: vi.fn(),
  fetchSensorsGrouped: vi.fn(),
  fetchScannerStatus: vi.fn(),
  triggerScan: vi.fn(),
  updateNote: vi.fn(),
  querySeries: vi.fn(),
  querySensorData: vi.fn(),
  queryStates: vi.fn(),
  fetchAnalysisConfigs: vi.fn().mockResolvedValue([]),
  createAnalysisConfig: vi.fn(),
  deleteAnalysisConfig: vi.fn(),
}));

vi.mock("react-plotly.js", () => ({
  default: ({ onRelayout }: { onRelayout?: (event: Record<string, unknown>) => void }) => (
    <div data-testid="plotly-mock">
      <button
        type="button"
        data-testid="plotly-zoom"
        onClick={() =>
          onRelayout?.({
            "xaxis.range[0]": Date.parse("2026-06-08T22:00:00.000Z"),
            "xaxis.range[1]": Date.parse("2026-06-09T00:00:00.000Z"),
          })
        }
      >
        Zoom
      </button>
      <button
        type="button"
        data-testid="plotly-autorange"
        onClick={() => onRelayout?.({ "xaxis.autorange": true })}
      >
        Reset autorange
      </button>
    </div>
  ),
}));

vi.mock("../analysis/export-csv", async () => {
  const actual = await vi.importActual<typeof import("../analysis/export-csv")>(
    "../analysis/export-csv",
  );
  return {
    ...actual,
    downloadSeriesCsv: vi.fn(),
  };
});

// Capture every requestRange invocation so tests can assert on what the workspace
// dispatches, not just what survives the debounce coalescing at the querySeries boundary.
const { requestRangeCalls } = vi.hoisted(() => ({ requestRangeCalls: [] as string[][] }));

vi.mock("../analysis/use-series-data", async () => {
  const actual = await vi.importActual<typeof import("../analysis/use-series-data")>(
    "../analysis/use-series-data",
  );
  const React = await import("react");
  return {
    ...actual,
    useSeriesData: () => {
      const hook = actual.useSeriesData();
      const requestRange = React.useCallback(
        (seasonTable: string, signals: string[], startMs: number, endMs: number) => {
          requestRangeCalls.push([...signals]);
          hook.requestRange(seasonTable, signals, startMs, endMs);
        },
        [hook.requestRange],
      );
      return { ...hook, requestRange };
    },
  };
});

import App from "../App";
import {
  fetchRuns,
  fetchScannerStatus,
  fetchSeasons,
  fetchSensors,
  fetchSensorsGrouped,
  querySeries,
  queryStates,
} from "../api";
import { downloadSeriesCsv } from "../analysis/export-csv";
import { serializeLayout } from "../analysis/plot-layout";
import { AnalysisWorkspace } from "./AnalysisWorkspace";

const fetchSeasonsMock = vi.mocked(fetchSeasons);
const fetchRunsMock = vi.mocked(fetchRuns);
const fetchSensorsMock = vi.mocked(fetchSensors);
const fetchSensorsGroupedMock = vi.mocked(fetchSensorsGrouped);
const fetchScannerStatusMock = vi.mocked(fetchScannerStatus);
const querySeriesMock = vi.mocked(querySeries);
const queryStatesMock = vi.mocked(queryStates);
const downloadSeriesCsvMock = vi.mocked(downloadSeriesCsv);

const seasons: Season[] = [
  { name: "WFR26", year: 2026, table: "wfr26" },
  { name: "WFR25", year: 2025, table: "wfr25" },
];

const run: RunRecord = {
  key: "run-1",
  start_utc: "2026-06-08T21:00:00.000Z",
  end_utc: "2026-06-09T03:00:00.000Z",
  start_local: "2026-06-08T17:00:00-04:00",
  end_local: "2026-06-08T23:00:00-04:00",
  bins: 60,
};

const grouped: SensorsGroupedResponse = {
  updated_at: null,
  dbc_source: "github",
  messages: [
    {
      name: "M160_Temperature_Set_1",
      subsystem: "INV",
      can_id: 160,
      can_id_hex: "0x0A0",
      signals: ["INV_Analog_Input_2"],
    },
  ],
  ungrouped: [],
};

const emptyGrouped: SensorsGroupedResponse = {
  updated_at: null,
  dbc_source: "none",
  messages: [],
  ungrouped: [],
};

function seriesResponse(
  season: string,
  signal: string,
  value: number,
  mode: "raw" | "envelope" = "raw",
): SeriesResponse {
  if (mode === "envelope") {
    return {
      season,
      start: "s",
      end: "e",
      series: {
        [signal]: {
          mode: "envelope",
          resolution_ms: 1000,
          point_count: 1,
          t: [Date.parse(run.start_utc)],
          min: [value - 1],
          max: [value + 1],
          avg: [value],
        },
      },
    };
  }
  return {
    season,
    start: "s",
    end: "e",
    series: {
      [signal]: {
        mode: "raw",
        resolution_ms: null,
        point_count: 1,
        t: [Date.parse(run.start_utc)],
        v: [value],
      },
    },
  };
}

function statesResponse(overrides: Partial<StatesResponse> = {}): StatesResponse {
  return {
    season: "wfr26",
    start: "s",
    end: "e",
    lanes: [
      {
        id: "car",
        signal: "State",
        label: "Car",
        segments: [
          {
            start_ms: Date.parse(run.start_utc) + 60_000,
            end_ms: Date.parse(run.start_utc) + 120_000,
            value: 4,
            label: "DRIVE",
          },
        ],
      },
    ],
    faults: [],
    ...overrides,
  };
}

function emptySeriesResponse(season: string, signal: string): SeriesResponse {
  return {
    season,
    start: "s",
    end: "e",
    series: {
      [signal]: {
        mode: "raw",
        resolution_ms: null,
        point_count: 0,
        t: [],
        v: [],
      },
    },
  };
}

function stubAppApis() {
  fetchSeasonsMock.mockResolvedValue(seasons);
  fetchRunsMock.mockImplementation(async (season?: string) => {
    if (season === "WFR25") {
      return { updated_at: null, runs: [] };
    }
    return { updated_at: "2026-07-16T10:00:00Z", runs: [run] };
  });
  fetchSensorsMock.mockResolvedValue({
    updated_at: "2026-07-16T10:00:00Z",
    sensors: ["INV_Analog_Input_2"],
  });
  fetchSensorsGroupedMock.mockResolvedValue(grouped);
  fetchScannerStatusMock.mockResolvedValue({
    scanning: false,
    started_at: null,
    finished_at: null,
    source: null,
    updated_at: null,
  });
  querySeriesMock.mockResolvedValue(seriesResponse("wfr26", "INV_Analog_Input_2", 5));
  queryStatesMock.mockResolvedValue(statesResponse());
}

async function flushInitialLoad() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("Analysis workspace tabs (App)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubAppApis();
  });

  it("shows Downloader and Analysis tabs with Past Runs initially", async () => {
    render(<App />);
    await flushInitialLoad();

    expect(screen.getByRole("tab", { name: "Downloader" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Analysis" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Past Runs" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Run window/i })).not.toBeInTheDocument();
    expect(document.getElementById("panel-analysis")).toHaveAttribute("hidden");
  });

  it("switches to Analysis workspace while keeping the shared season selected", async () => {
    render(<App />);
    await flushInitialLoad();

    fireEvent.click(screen.getByRole("tab", { name: "Analysis" }));

    expect(screen.getByRole("combobox", { name: /Run window/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Search signals/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Past Runs" })).not.toBeInTheDocument();
    expect(document.getElementById("panel-downloader")).toHaveAttribute("hidden");
    expect(document.getElementById("panel-analysis")).not.toHaveAttribute("hidden");

    const activeSeason = screen.getByRole("button", { name: "WFR26" });
    expect(activeSeason).toHaveStyle({ fontWeight: "bold" });
  });

  it("queries the season table with exact run UTC bounds and selected signal", async () => {
    render(<App />);
    await flushInitialLoad();

    fireEvent.click(screen.getByRole("tab", { name: "Analysis" }));

    fireEvent.change(screen.getByLabelText(/Run window/i), {
      target: { value: run.key },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(querySeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        season: "wfr26",
        signals: ["INV_Analog_Input_2"],
        start: run.start_utc,
        end: run.end_utc,
      }),
    );
  });

  it("does not query the new season table with the old range/signals after a season switch", async () => {
    render(<App />);
    await flushInitialLoad();

    fireEvent.click(screen.getByRole("tab", { name: "Analysis" }));
    fireEvent.change(screen.getByLabelText(/Run window/i), {
      target: { value: run.key },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(await screen.findByTestId("plotly-mock")).toBeInTheDocument();

    querySeriesMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "WFR25" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId("plotly-mock")).not.toBeInTheDocument();
    const signalChip = screen.queryByRole("checkbox", { name: "INV_Analog_Input_2" });
    if (signalChip) {
      expect(signalChip).toHaveAttribute("aria-checked", "false");
    }
    const staleCalls = querySeriesMock.mock.calls.filter(
      ([payload]) =>
        payload.season === "wfr25" &&
        Array.isArray(payload.signals) &&
        payload.signals.includes("INV_Analog_Input_2") &&
        payload.start === run.start_utc &&
        payload.end === run.end_utc,
    );
    expect(staleCalls).toHaveLength(0);
  });

  it("clears the previous season's grouped sensors on a cross-season load so a target-only signal is not pruned before its season's sensor list arrives", async () => {
    const wfr25OnlySignal = "Brake_Only_WFR25";
    const wfr25Grouped: SensorsGroupedResponse = {
      updated_at: null,
      dbc_source: "github",
      messages: [],
      ungrouped: [wfr25OnlySignal],
    };

    // WFR26's grouped response (the season active before the cross-season load) never
    // contains the WFR25-only signal, matching the season prefix in the review scenario.
    fetchSensorsGroupedMock.mockImplementation(async (season?: string) => {
      if (season === "WFR25") return wfr25Grouped;
      return grouped;
    });

    const savedConfig = {
      id: "cross-1",
      name: "WFR25 view",
      note: "",
      author: "",
      season: "wfr25",
      start: "2026-06-20T15:00:00.000Z",
      end: "2026-06-20T15:05:00.000Z",
      plots: [{ signals: [wfr25OnlySignal], rightAxis: [] }],
      created_at: "2026-06-20T15:06:00.000Z",
      updated_at: "2026-06-20T15:06:00.000Z",
    };
    const { fetchAnalysisConfigs } = await import("../api");
    (fetchAnalysisConfigs as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([savedConfig]);

    render(<App />);
    await flushInitialLoad();

    fireEvent.click(screen.getByRole("tab", { name: "Analysis" }));

    // The saved-views box is expanded by default; Load appears once configs load.
    fireEvent.click(await screen.findByRole("button", { name: "Load" }));
    // Cross-season load asks for confirmation before App switches the active season.
    fireEvent.click(screen.getByRole("button", { name: /switch and load/i }));

    // Season switch remounts AnalysisWorkspace synchronously; let App's async
    // refetch of WFR25's grouped sensors settle before asserting.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const checkbox = await screen.findByRole("checkbox", { name: wfr25OnlySignal });
    expect(checkbox).toHaveAttribute("aria-checked", "true");
  });

  it("preserves Downloader local form state across Analysis tab round-trips", async () => {
    render(<App />);
    await flushInitialLoad();

    const limitInput = screen.getByDisplayValue("5000");
    fireEvent.change(limitInput, { target: { value: "1234" } });
    expect(screen.getByDisplayValue("1234")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Analysis" }));
    expect(screen.getByLabelText(/Run window/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Past Runs" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Downloader" }));
    expect(screen.getByRole("heading", { name: "Past Runs" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("1234")).toBeInTheDocument();
  });
});

describe("AnalysisWorkspace", () => {
  const runsBySeason: Record<string, RunRecord[]> = {
    WFR26: [run],
    WFR25: [],
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    querySeriesMock.mockReset();
    queryStatesMock.mockReset();
    downloadSeriesCsvMock.mockReset();
    queryStatesMock.mockResolvedValue(statesResponse());
  });

  it("clears prior season plots when remounted with a new season key", async () => {
    const clearSeason: Season = { name: "WFR26", year: 2026, table: "wfr26-clear" };
    querySeriesMock.mockResolvedValue(seriesResponse("wfr26-clear", "INV_Analog_Input_2", 5));

    const { rerender } = render(
      <AnalysisWorkspace
        key={clearSeason.name}
        season={clearSeason}
        runs={[run]}
        grouped={grouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), {
      target: { value: run.key },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(await screen.findByTestId("plotly-mock")).toBeInTheDocument();
    expect(querySeriesMock).toHaveBeenCalledTimes(1);

    querySeriesMock.mockClear();
    rerender(
      <AnalysisWorkspace
        key={seasons[1].name}
        season={seasons[1]}
        runs={[]}
        grouped={emptyGrouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    expect(screen.queryByTestId("plotly-mock")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "INV_Analog_Input_2" })).not.toBeInTheDocument();
    expect(querySeriesMock).not.toHaveBeenCalled();
  });

  it("does not show the neutral empty state before the first response completes", async () => {
    let resolveSeries!: (value: SeriesResponse) => void;
    querySeriesMock.mockReturnValue(
      new Promise<SeriesResponse>((resolve) => {
        resolveSeries = resolve;
      }),
    );

    const emptySeason: Season = { name: "WFR26", year: 2026, table: "wfr26-empty-timing" };

    render(
      <AnalysisWorkspace
        season={emptySeason}
        runs={[run]}
        grouped={grouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), {
      target: { value: run.key },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));

    expect(screen.queryByTestId("analysis-empty")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(screen.queryByTestId("analysis-empty")).not.toBeInTheDocument();
    expect(screen.getByText(/Loading series/i)).toBeInTheDocument();

    await act(async () => {
      resolveSeries(emptySeriesResponse("wfr26-empty-timing", "INV_Analog_Input_2"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("analysis-empty")).toBeInTheDocument();
  });

  it("shows a 'Refreshing' overlay over the previous plots while a refresh is in flight", async () => {
    const refreshSeason: Season = { name: "WFR26", year: 2026, table: "wfr26-refresh-overlay" };
    let resolveSecond!: (value: SeriesResponse) => void;
    querySeriesMock
      .mockResolvedValueOnce(seriesResponse(refreshSeason.table, "INV_Analog_Input_2", 5))
      .mockReturnValueOnce(
        new Promise<SeriesResponse>((resolve) => {
          resolveSecond = resolve;
        }),
      );

    render(
      <AnalysisWorkspace
        season={refreshSeason}
        runs={[run]}
        grouped={grouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), { target: { value: run.key } });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(await screen.findByTestId("plotly-mock")).toBeInTheDocument();

    // Zoom fires a second /api/series request; the first response stays visible.
    fireEvent.click(screen.getByTestId("plotly-zoom"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(screen.queryByTestId("analysis-empty")).toBeNull();
    expect(screen.getByTestId("analysis-refreshing")).toBeInTheDocument();
    expect(await screen.findByTestId("plotly-mock")).toBeInTheDocument();

    await act(async () => {
      resolveSecond(emptySeriesResponse(refreshSeason.table, "INV_Analog_Input_2"));
      await Promise.resolve();
    });

    expect(screen.queryByTestId("analysis-refreshing")).toBeNull();
    expect(screen.getByTestId("analysis-empty")).toBeInTheDocument();
  });

  it("asks for inline confirmation before exporting envelope data", async () => {
    const envelopeSeason: Season = { name: "WFR26", year: 2026, table: "wfr26-envelope" };
    querySeriesMock.mockResolvedValue(
      seriesResponse("wfr26-envelope", "INV_Analog_Input_2", 5, "envelope"),
    );
    const confirmSpy = vi.spyOn(window, "confirm");

    render(
      <AnalysisWorkspace
        season={envelopeSeason}
        runs={[run]}
        grouped={grouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), {
      target: { value: run.key },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(await screen.findByTestId("plotly-mock")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(downloadSeriesCsvMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("analysis-export-confirm")).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByTestId("analysis-export-confirm")).getByRole("button", {
        name: /Export anyway/i,
      }),
    );

    const startMs = Date.parse(run.start_utc);
    const endMs = Date.parse(run.end_utc);
    expect(downloadSeriesCsvMock).toHaveBeenCalledTimes(1);
    expect(downloadSeriesCsvMock).toHaveBeenCalledWith(
      {
        INV_Analog_Input_2: expect.objectContaining({ mode: "envelope", point_count: 1 }),
      },
      "WFR26",
      startMs,
      endMs,
    );
    confirmSpy.mockRestore();
  });

  it("disables export while a refresh is pending and exports only selected loaded series", async () => {
    const exportSeason: Season = { name: "WFR26", year: 2026, table: "wfr26-export-guard" };
    const multiGrouped: SensorsGroupedResponse = {
      ...grouped,
      messages: [
        {
          name: "M160_Temperature_Set_1",
          subsystem: "INV",
          can_id: 160,
          can_id_hex: "0x0A0",
          signals: ["INV_Analog_Input_2", "INV_Analog_Input_3"],
        },
      ],
    };

    querySeriesMock.mockImplementation(async (payload) => {
      const series: SeriesResponse["series"] = {};
      for (const signal of payload.signals) {
        series[signal] = {
          mode: "raw",
          resolution_ms: null,
          point_count: 1,
          t: [Date.parse(run.start_utc)],
          v: [signal === "INV_Analog_Input_2" ? 5 : 9],
        };
      }
      return {
        season: "wfr26-export-guard",
        start: "s",
        end: "e",
        series,
      };
    });

    render(
      <AnalysisWorkspace
        season={exportSeason}
        runs={[run]}
        grouped={multiGrouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), {
      target: { value: run.key },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_3" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(await screen.findAllByTestId("plotly-mock")).toHaveLength(2);

    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_3" }));

    const exportBtn = screen.getByRole("button", { name: /Export CSV/i });
    expect(exportBtn).toBeDisabled();
    fireEvent.click(exportBtn);
    expect(downloadSeriesCsvMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(await screen.findByTestId("plotly-mock")).toBeInTheDocument();
    expect(exportBtn).not.toBeDisabled();

    fireEvent.click(exportBtn);

    const startMs = Date.parse(run.start_utc);
    const endMs = Date.parse(run.end_utc);
    expect(downloadSeriesCsvMock).toHaveBeenCalledTimes(1);
    expect(downloadSeriesCsvMock).toHaveBeenCalledWith(
      {
        INV_Analog_Input_2: expect.objectContaining({ mode: "raw", point_count: 1 }),
      },
      "WFR26",
      startMs,
      endMs,
    );
    const exported = downloadSeriesCsvMock.mock.calls[0][0];
    expect(exported).not.toHaveProperty("INV_Analog_Input_3");
  });

  it("retries the latest failed series request", async () => {
    const retrySeason: Season = { name: "WFR26", year: 2026, table: "wfr26-retry" };
    querySeriesMock
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(seriesResponse("wfr26-retry", "INV_Analog_Input_2", 7));

    render(
      <AnalysisWorkspace
        season={retrySeason}
        runs={[run]}
        grouped={grouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), {
      target: { value: run.key },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/boom/i);
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(await screen.findByTestId("plotly-mock")).toBeInTheDocument();
    expect(querySeriesMock).toHaveBeenCalledTimes(2);
    expect(querySeriesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        season: "wfr26-retry",
        signals: ["INV_Analog_Input_2"],
        start: run.start_utc,
        end: run.end_utc,
      }),
    );
  });

  it("resets the plot range to the full run window on autorange relayout", async () => {
    const relayoutSeason: Season = { name: "WFR26", year: 2026, table: "wfr26-relayout" };
    querySeriesMock.mockResolvedValue(seriesResponse("wfr26-relayout", "INV_Analog_Input_2", 5));

    render(
      <AnalysisWorkspace
        season={relayoutSeason}
        runs={[run]}
        grouped={grouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), {
      target: { value: run.key },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(await screen.findByTestId("plotly-mock")).toBeInTheDocument();

    const startInput = screen.getByLabelText(/Start \(local/i) as HTMLInputElement;
    const endInput = screen.getByLabelText(/End \(local/i) as HTMLInputElement;
    const fullStart = startInput.value;
    const fullEnd = endInput.value;
    expect(fullStart).not.toBe("");
    expect(fullEnd).not.toBe("");

    fireEvent.click(screen.getByTestId("plotly-zoom"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(querySeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        season: "wfr26-relayout",
        start: "2026-06-08T22:00:00.000Z",
        end: "2026-06-09T00:00:00.000Z",
      }),
    );
    expect(startInput.value).not.toBe(fullStart);

    fireEvent.click(screen.getByTestId("plotly-autorange"));
    expect(startInput.value).toBe(fullStart);
    expect(endInput.value).toBe(fullEnd);
  });
});

describe("multi-plot workspace", () => {
  const runsBySeason: Record<string, RunRecord[]> = {
    WFR26: [run],
    WFR25: [],
  };

  const twoSignalGrouped: SensorsGroupedResponse = {
    ...grouped,
    messages: [
      {
        name: "M160_Temperature_Set_1",
        subsystem: "INV",
        can_id: 160,
        can_id_hex: "0x0A0",
        signals: ["INV_Analog_Input_2", "INV_Analog_Input_3"],
      },
    ],
  };

  function groupedWithSignals(signals: string[]): SensorsGroupedResponse {
    return {
      ...grouped,
      messages: [
        {
          name: "M160_Temperature_Set_1",
          subsystem: "INV",
          can_id: 160,
          can_id_hex: "0x0A0",
          signals,
        },
      ],
    };
  }

  function stubGenericSeries() {
    querySeriesMock.mockImplementation(async (payload) => {
      const series: SeriesResponse["series"] = {};
      for (const signal of payload.signals) {
        series[signal] = {
          mode: "raw",
          resolution_ms: null,
          point_count: 1,
          t: [Date.parse(run.start_utc)],
          v: [1],
        };
      }
      return { season: payload.season, start: "s", end: "e", series };
    });
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    querySeriesMock.mockReset();
    queryStatesMock.mockReset();
    downloadSeriesCsvMock.mockReset();
    window.localStorage.clear();
    requestRangeCalls.length = 0;
    stubGenericSeries();
    queryStatesMock.mockResolvedValue(statesResponse());
  });

  it("requests the flattened signal list once for all groups", async () => {
    render(
      <AnalysisWorkspace
        season={seasons[0]}
        runs={[run]}
        grouped={twoSignalGrouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), { target: { value: run.key } });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_3" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(querySeriesMock).toHaveBeenCalledTimes(1);
    expect(querySeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        season: "wfr26",
        signals: ["INV_Analog_Input_2", "INV_Analog_Input_3"],
      }),
    );
    expect(screen.getAllByTestId("analysis-plot-card")).toHaveLength(2);

    // Regroup the two signals into a single plot; membership is unchanged.
    const trigger = screen.getByLabelText("Plot for INV_Analog_Input_3");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Plot 1" }));

    expect(screen.getAllByTestId("analysis-plot-card")).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // Same membership must not re-fire the series request.
    expect(querySeriesMock).toHaveBeenCalledTimes(1);
  });

  it("persists the layout per season and restores it on remount", async () => {
    window.localStorage.setItem(
      "analysis-layout:WFR26",
      serializeLayout([{ id: "x", signals: ["S1", "S2"], rightAxis: ["S2"] }]),
    );

    render(
      <AnalysisWorkspace
        season={seasons[0]}
        runs={[run]}
        grouped={groupedWithSignals(["S1", "S2"])}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "S1" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("checkbox", { name: "S2" })).toHaveAttribute("aria-checked", "true");

    fireEvent.change(screen.getByLabelText(/Run window/i), { target: { value: run.key } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(screen.getAllByTestId("analysis-plot-card")).toHaveLength(1);
    const card = screen.getByTestId("analysis-plot-card");
    expect(within(card).getByText("S1")).toBeInTheDocument();
    expect(within(card).getByText("S2")).toBeInTheDocument();
  });

  it("prunes persisted signals unknown to the season before the first request", async () => {
    window.localStorage.setItem(
      "analysis-layout:WFR26",
      serializeLayout([{ id: "x", signals: ["S1", "GONE"], rightAxis: [] }]),
    );

    render(
      <AnalysisWorkspace
        season={seasons[0]}
        runs={[run]}
        grouped={groupedWithSignals(["S1"])}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), { target: { value: run.key } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(querySeriesMock).toHaveBeenCalled();
    for (const [payload] of querySeriesMock.mock.calls) {
      expect(payload.signals).toEqual(["S1"]);
      expect(payload.signals).not.toContain("GONE");
    }
  });

  it("never requests a stale persisted signal when the sensor list arrives after the range", async () => {
    // Unique table so the shared series cache never masks the request under test.
    const lateSeason: Season = { name: "WFR26", year: 2026, table: "wfr26-late-grouped" };
    window.localStorage.setItem(
      "analysis-layout:WFR26",
      serializeLayout([{ id: "x", signals: ["S1", "GONE"], rightAxis: [] }]),
    );

    const { rerender } = render(
      <AnalysisWorkspace
        season={lateSeason}
        runs={[run]}
        grouped={null}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    // Establish a view range while the sensor list is still loading.
    fireEvent.change(screen.getByLabelText(/Run window/i), { target: { value: run.key } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(querySeriesMock).not.toHaveBeenCalled();

    // Sensor list arrives without GONE; prune and request now commit together.
    rerender(
      <AnalysisWorkspace
        season={lateSeason}
        runs={[run]}
        grouped={groupedWithSignals(["S1"])}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // The stale signal must never be dispatched at all, not merely coalesced away by
    // the debounce. Assert on the dispatched requestRange args, then on the API boundary.
    expect(requestRangeCalls.length).toBeGreaterThan(0);
    for (const signals of requestRangeCalls) {
      expect(signals).toEqual(["S1"]);
      expect(signals).not.toContain("GONE");
    }

    expect(querySeriesMock).toHaveBeenCalled();
    for (const [payload] of querySeriesMock.mock.calls) {
      expect(payload.signals).toEqual(["S1"]);
      expect(payload.signals).not.toContain("GONE");
    }
  });

  it("recovers to an empty layout from corrupt storage", () => {
    window.localStorage.setItem("analysis-layout:WFR26", "{broken");

    expect(() =>
      render(
        <AnalysisWorkspace
          season={seasons[0]}
          runs={[run]}
          grouped={grouped}
          theme="light"
          runsBySeason={runsBySeason}
        />,
      ),
    ).not.toThrow();

    expect(
      screen.getByText(/Select a run window and one or more signals/i),
    ).toBeInTheDocument();
  });
});

describe("state timeline wiring", () => {
  const runsBySeason: Record<string, RunRecord[]> = {
    WFR26: [run],
    WFR25: [],
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    querySeriesMock.mockReset();
    queryStatesMock.mockReset();
    querySeriesMock.mockResolvedValue(seriesResponse("wfr26", "INV_Analog_Input_2", 5));
    queryStatesMock.mockResolvedValue(statesResponse());
  });

  it("fetches states once when a run window is selected, even with no signals", async () => {
    render(
      <AnalysisWorkspace
        season={seasons[0]}
        runs={[run]}
        grouped={grouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), { target: { value: run.key } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(queryStatesMock).toHaveBeenCalledTimes(1);
    expect(queryStatesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        season: "wfr26",
        start: run.start_utc,
        end: run.end_utc,
      }),
      expect.anything(),
    );
    const timeline = screen.getByTestId("analysis-timeline");
    expect(timeline).toBeInTheDocument();
    // The timeline lives in the plots column so its tracks share the plots' x extent.
    expect(timeline.parentElement).toHaveClass("analysis-plots");
    expect(screen.getByRole("button", { name: "Car DRIVE" })).toBeInTheDocument();
  });

  it("shows a droppable plot zone (not the run-window prompt) once a range is set", async () => {
    render(
      <AnalysisWorkspace
        season={seasons[0]}
        runs={[run]}
        grouped={grouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    expect(screen.getByTestId("analysis-idle-no-selection")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Run window/i), { target: { value: run.key } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(screen.queryByTestId("analysis-idle-no-selection")).toBeNull();
    expect(screen.queryByText(/Select a run window and one or more signals/i)).toBeNull();
    expect(
      screen.getByText(/Select or drop one or more signals to load linked plots/i),
    ).toBeInTheDocument();

    const dt = {
      types: ["application/x-wfr-signals"],
      getData: () => JSON.stringify({ signals: ["INV_Analog_Input_2"] }),
    } as unknown as DataTransfer;
    fireEvent.drop(screen.getByTestId("analysis-new-plot-zone"), { dataTransfer: dt });

    expect(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("does not refetch states on zoom", async () => {
    const zoomSeason: Season = { name: "WFR26", year: 2026, table: "wfr26-states-zoom" };
    render(
      <AnalysisWorkspace
        season={zoomSeason}
        runs={[run]}
        grouped={grouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), { target: { value: run.key } });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(await screen.findByTestId("plotly-mock")).toBeInTheDocument();
    expect(queryStatesMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("plotly-zoom"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // The zoom refires the series request but never the states request.
    expect(queryStatesMock).toHaveBeenCalledTimes(1);
  });

  it("zooms the plots when a timeline segment is clicked", async () => {
    const clickSeason: Season = { name: "WFR26", year: 2026, table: "wfr26-states-click" };
    render(
      <AnalysisWorkspace
        season={clickSeason}
        runs={[run]}
        grouped={grouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), { target: { value: run.key } });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    querySeriesMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Car DRIVE" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    const segStart = new Date(Date.parse(run.start_utc) + 60_000).toISOString();
    const segEnd = new Date(Date.parse(run.start_utc) + 120_000).toISOString();
    expect(querySeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({ start: segStart, end: segEnd }),
    );
  });

  it("shows a timeline error without blocking the plots", async () => {
    const errSeason: Season = { name: "WFR26", year: 2026, table: "wfr26-states-error" };
    queryStatesMock.mockRejectedValue(new Error("states down"));

    render(
      <AnalysisWorkspace
        season={errSeason}
        runs={[run]}
        grouped={grouped}
        theme="light"
        runsBySeason={runsBySeason}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Run window/i), { target: { value: run.key } });
    fireEvent.click(screen.getByRole("checkbox", { name: "INV_Analog_Input_2" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(await screen.findByTestId("plotly-mock")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/states down/i);
  });
});

describe("saved analysis configs", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    querySeriesMock.mockReset();
    queryStatesMock.mockReset();
    queryStatesMock.mockResolvedValue(statesResponse());
  });

  it("routes a cross-season load up to onCrossSeasonLoad", async () => {
    const { fetchAnalysisConfigs } = await import("../api");
    (fetchAnalysisConfigs as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "c1",
        name: "Other season",
        note: "",
        author: "",
        season: "wfr25",
        start: "2026-06-20T15:00:00.000Z",
        end: "2026-06-20T15:05:00.000Z",
        plots: [{ signals: ["Brake_Pressure"], rightAxis: [] }],
        created_at: "2026-06-20T15:06:00.000Z",
        updated_at: "2026-06-20T15:06:00.000Z",
      },
    ]);
    const onCrossSeasonLoad = vi.fn();
    render(
      <AnalysisWorkspace
        season={{ name: "WFR26", year: 2026, table: "wfr26" }}
        runs={[]}
        grouped={null}
        theme="light"
        runsBySeason={{}}
        onCrossSeasonLoad={onCrossSeasonLoad}
      />,
    );
    // The saved-views box is expanded by default; Load appears once configs load.
    fireEvent.click(await screen.findByRole("button", { name: "Load" }));
    // Cross-season load asks for confirmation, then routes up.
    fireEvent.click(screen.getByRole("button", { name: /switch/i }));
    expect(onCrossSeasonLoad).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
  });
});
