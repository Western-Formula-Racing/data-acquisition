import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PLOT_AREA_MARGIN } from "../analysis/plot-traces";
import type { StatesResponse } from "../types";
import { AnalysisStateTimeline } from "./AnalysisStateTimeline";

const data: StatesResponse = {
  season: "wfr26",
  start: "s",
  end: "e",
  lanes: [
    {
      id: "car",
      signal: "State",
      label: "Car",
      segments: [
        { start_ms: 0, end_ms: 4000, value: 4, label: "DRIVE" },
        { start_ms: 4000, end_ms: 4100, value: 6, label: "DEVICE_FAULT" },
        { start_ms: 20000, end_ms: 30000, value: 4, label: "DRIVE" },
      ],
    },
    {
      id: "inverter",
      signal: "INV_VSM_State",
      label: "Inverter",
      segments: [{ start_ms: 0, end_ms: 10000, value: 6, label: "Motor Running State" }],
    },
  ],
  faults: [
    {
      name: "Over-current Fault",
      source: "run",
      segments: [{ start_ms: 4000, end_ms: 4100 }],
    },
  ],
};

const baseProps = {
  data,
  loading: false,
  error: null as string | null,
  viewRange: [0, 10000] as [number, number],
  onSelectRange: vi.fn(),
  onRetry: vi.fn(),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("AnalysisStateTimeline", () => {
  it("renders lane labels and segments within the view range", () => {
    render(<AnalysisStateTimeline {...baseProps} />);
    expect(screen.getByText("Car")).toBeInTheDocument();
    expect(screen.getByText("Inverter")).toBeInTheDocument();
    expect(screen.getByText("Faults")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Car DRIVE/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Car DEVICE_FAULT" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Fault Over-current Fault" }),
    ).toBeInTheDocument();
  });

  it("aligns lane gutters with the shared plot-area margins", () => {
    render(<AnalysisStateTimeline {...baseProps} />);
    const label = screen.getByText("Car");
    expect(label).toHaveStyle({ width: `${PLOT_AREA_MARGIN.left}px` });
    const track = label.nextElementSibling as HTMLElement;
    expect(track).toHaveStyle({ marginRight: `${PLOT_AREA_MARGIN.right}px` });
  });

  it("zooms to a clicked segment with minimum-span padding", () => {
    render(<AnalysisStateTimeline {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Car DEVICE_FAULT" }));
    // 100 ms segment padded to 1000 ms centered on [4000, 4100].
    expect(baseProps.onSelectRange).toHaveBeenCalledWith(3550, 4550);
  });

  it("shows an error with retry", () => {
    render(<AnalysisStateTimeline {...baseProps} data={null} error="boom" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/boom/);
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(baseProps.onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows an empty notice when there is no state data", () => {
    render(
      <AnalysisStateTimeline
        {...baseProps}
        data={{ season: "wfr26", start: "s", end: "e", lanes: [], faults: [] }}
      />,
    );
    expect(screen.getByText(/No state data in this window/i)).toBeInTheDocument();
  });

  it("collapses, persists the flag, and restores it", () => {
    const { unmount } = render(<AnalysisStateTimeline {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /State timeline/i }));
    expect(screen.queryByText("Car")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("analysis-timeline-collapsed")).toBe("1");
    unmount();

    render(<AnalysisStateTimeline {...baseProps} />);
    expect(screen.queryByText("Car")).not.toBeInTheDocument();
  });
});
