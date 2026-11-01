import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NEW_PLOT } from "../analysis/plot-layout";
import type { SeriesMap } from "../analysis/series-cache";
import { AnalysisPlotStack, SIGNALS_MIME, readSignalsPayload } from "./AnalysisPlotStack";

vi.mock("react-plotly.js", () => ({
  default: (props: {
    style?: CSSProperties;
    className?: string;
    data?: unknown[];
  }) => (
    <div
      data-testid="plotly-mock"
      className={props.className}
      style={props.style}
      data-trace-count={props.data?.length ?? 0}
    />
  ),
}));

afterEach(() => {
  cleanup();
});

const rawSeries = (v: number[]): SeriesMap[string] => ({
  mode: "raw",
  resolution_ms: null,
  point_count: v.length,
  t: v.map((_, i) => i * 1000),
  v,
});

function makeDataTransfer(payload: unknown): DataTransfer {
  const data: Record<string, string> = {
    [SIGNALS_MIME]: JSON.stringify(payload),
  };
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
    setData: (type: string, value: string) => {
      data[type] = value;
    },
    dropEffect: "move",
    effectAllowed: "move",
  } as unknown as DataTransfer;
}

const baseProps = {
  seriesBySignal: { S1: rawSeries([1, 2]), S2: rawSeries([3, 4]) } as SeriesMap,
  range: [0, 2000] as [number, number],
  onRangeChange: vi.fn(),
  onAssignSignals: vi.fn(),
  onRemoveSignal: vi.fn(),
  onToggleRightAxis: vi.fn(),
  theme: "light" as const,
};

describe("AnalysisPlotStack groups", () => {
  it("renders one card per group with a legend chip per signal", () => {
    render(
      <AnalysisPlotStack
        {...baseProps}
        layout={[{ id: "g1", signals: ["S1", "S2"], rightAxis: [] }]}
      />,
    );
    expect(screen.getAllByTestId("analysis-plot-card")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /remove S1/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove S2/i })).toBeInTheDocument();
  });

  it("toggles the right axis from the legend chip axis badge", () => {
    const onToggleRightAxis = vi.fn();
    render(
      <AnalysisPlotStack
        {...baseProps}
        onToggleRightAxis={onToggleRightAxis}
        layout={[{ id: "g1", signals: ["S1", "S2"], rightAxis: [] }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /move S2 to the right axis/i }));
    expect(onToggleRightAxis).toHaveBeenCalledWith("g1", "S2");
  });

  it("hides axis badges on single-signal cards", () => {
    render(
      <AnalysisPlotStack
        {...baseProps}
        layout={[{ id: "g1", signals: ["S1"], rightAxis: [] }]}
      />,
    );
    expect(screen.queryByRole("button", { name: /right axis/i })).toBeNull();
  });

  it("dispatches onAssignSignals when a payload drops on a card", () => {
    const onAssignSignals = vi.fn();
    render(
      <AnalysisPlotStack
        {...baseProps}
        onAssignSignals={onAssignSignals}
        layout={[{ id: "g1", signals: ["S1"], rightAxis: [] }]}
      />,
    );
    fireEvent.drop(screen.getByTestId("analysis-plot-card"), {
      dataTransfer: makeDataTransfer({ signals: ["S2"] }),
    });
    expect(onAssignSignals).toHaveBeenCalledWith(["S2"], "g1");
  });

  it("dispatches NEW_PLOT when dropped on the new-plot zone", () => {
    const onAssignSignals = vi.fn();
    render(
      <AnalysisPlotStack
        {...baseProps}
        onAssignSignals={onAssignSignals}
        layout={[{ id: "g1", signals: ["S1"], rightAxis: [] }]}
      />,
    );
    fireEvent.drop(screen.getByTestId("analysis-new-plot-zone"), {
      dataTransfer: makeDataTransfer({ signals: ["S2"] }),
    });
    expect(onAssignSignals).toHaveBeenCalledWith(["S2"], NEW_PLOT);
  });

  it("ignores foreign drop payloads", () => {
    const onAssignSignals = vi.fn();
    render(
      <AnalysisPlotStack
        {...baseProps}
        onAssignSignals={onAssignSignals}
        layout={[{ id: "g1", signals: ["S1"], rightAxis: [] }]}
      />,
    );
    const dt = {
      types: ["text/plain"],
      getData: () => "",
    } as unknown as DataTransfer;
    fireEvent.drop(screen.getByTestId("analysis-plot-card"), { dataTransfer: dt });
    expect(onAssignSignals).not.toHaveBeenCalled();
  });

  it("shows a droppable empty-stack zone when the layout has no groups", () => {
    const onAssignSignals = vi.fn();
    render(
      <AnalysisPlotStack {...baseProps} onAssignSignals={onAssignSignals} layout={[]} />,
    );
    expect(
      screen.getByText(/select or drop one or more signals to load linked plots/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("analysis-plot-card")).toBeNull();
    fireEvent.drop(screen.getByTestId("analysis-new-plot-zone"), {
      dataTransfer: makeDataTransfer({ signals: ["S1"] }),
    });
    expect(onAssignSignals).toHaveBeenCalledWith(["S1"], NEW_PLOT);
  });

  it("passes Plotly an explicit 180px height (not percentage) so plots stay in-card", () => {
    render(
      <AnalysisPlotStack
        {...baseProps}
        layout={[{ id: "g1", signals: ["S1"], rightAxis: [] }]}
        theme="dark"
      />,
    );
    const plot = screen.getByTestId("plotly-mock");
    expect(Number(plot.getAttribute("data-trace-count"))).toBeGreaterThan(0);
    expect(plot).toHaveStyle({ width: "100%", height: "180px" });
    expect(plot.style.height).not.toBe("100%");
  });

  it("dispatches onAssignSignalsToAxis when dropped on left or right axis overlay zones", () => {
    const onAssignSignalsToAxis = vi.fn();
    render(
      <AnalysisPlotStack
        {...baseProps}
        onAssignSignalsToAxis={onAssignSignalsToAxis}
        layout={[{ id: "g1", signals: ["S1"], rightAxis: [] }]}
      />,
    );
    const card = screen.getByTestId("analysis-plot-card");
    const dt = makeDataTransfer({ signals: ["S2"] });

    // Drag enter to reveal zones
    fireEvent.dragEnter(card, { dataTransfer: dt });

    const leftZone = screen.getByText(/left axis/i);

    fireEvent.drop(leftZone, { dataTransfer: dt });
    expect(onAssignSignalsToAxis).toHaveBeenCalledWith(["S2"], "g1", "left");

    onAssignSignalsToAxis.mockClear();
    fireEvent.dragEnter(card, { dataTransfer: dt });
    const rightZoneAfter = screen.getByText(/right axis/i);
    fireEvent.drop(rightZoneAfter, { dataTransfer: dt });
    expect(onAssignSignalsToAxis).toHaveBeenCalledWith(["S2"], "g1", "right");
  });

  it("opens color picker on swatch click and dispatches color handlers", () => {
    const onSetSignalColor = vi.fn();
    const onClearSignalColor = vi.fn();
    render(
      <AnalysisPlotStack
        {...baseProps}
        colorOverrides={{ S1: "#ff0000" }}
        onSetSignalColor={onSetSignalColor}
        onClearSignalColor={onClearSignalColor}
        layout={[{ id: "g1", signals: ["S1"], rightAxis: [] }]}
      />,
    );

    const swatch = screen.getByRole("button", { name: /change color for S1/i });
    fireEvent.click(swatch);

    expect(screen.getByText(/custom color/i)).toBeInTheDocument();
    const resetButton = screen.getByRole("button", { name: /reset/i });
    expect(resetButton).toBeInTheDocument();

    fireEvent.click(resetButton);
    expect(onClearSignalColor).toHaveBeenCalledWith("S1");
  });
});

describe("readSignalsPayload", () => {
  it("parses a valid payload and rejects junk", () => {
    expect(readSignalsPayload(makeDataTransfer({ signals: ["A", "B"] }))).toEqual(["A", "B"]);
    expect(readSignalsPayload(makeDataTransfer({ signals: "A" }))).toBeNull();
    expect(readSignalsPayload(null)).toBeNull();
  });
});
