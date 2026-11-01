import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NEW_PLOT } from "../analysis/plot-layout";
import type { SensorsGroupedResponse } from "../types";
import { AnalysisSignalPicker } from "./AnalysisSignalPicker";
import { SIGNALS_MIME } from "./AnalysisPlotStack";
import { subsystemColor } from "./sensor-palette";

// The picker imports SIGNALS_MIME from AnalysisPlotStack, which pulls in
// react-plotly.js; stub it so plotly.js never loads under jsdom.
vi.mock("react-plotly.js", () => ({ default: () => null }));

const grouped: SensorsGroupedResponse = {
  updated_at: null,
  dbc_source: "test.dbc",
  messages: [
    {
      name: "PDU_Status",
      subsystem: "Powertrain",
      can_id: 256,
      can_id_hex: "0x100",
      signals: ["battery_voltage"],
    },
  ],
  ungrouped: [],
};

afterEach(() => {
  cleanup();
});

describe("AnalysisSignalPicker", () => {
  it("updates subsystem palette styles when theme prop changes", () => {
    const lightBorder = subsystemColor("Powertrain", "light").border;
    const darkBorder = subsystemColor("Powertrain", "dark").border;
    expect(lightBorder).not.toBe(darkBorder);

    const { rerender } = render(
      <AnalysisSignalPicker
        grouped={grouped}
        selected={new Set()}
        onToggle={vi.fn()}
        theme="light"
      />,
    );

    const header = screen.getByRole("button", { name: /PDU_Status/i });
    expect(header).toHaveStyle({ borderLeftColor: lightBorder });

    rerender(
      <AnalysisSignalPicker
        grouped={grouped}
        selected={new Set()}
        onToggle={vi.fn()}
        theme="dark"
      />,
    );

    expect(header).toHaveStyle({ borderLeftColor: darkBorder });
  });
});

const groupedFixture: SensorsGroupedResponse = {
  updated_at: null,
  dbc_source: "file",
  messages: [
    {
      name: "M167_Voltage",
      subsystem: "INV",
      can_id: 167,
      can_id_hex: "0x0A7",
      signals: ["INV_DC_Bus_Voltage", "INV_Output_Voltage"],
    },
  ],
  ungrouped: [],
};

describe("picker grouping interactions", () => {
  it("double-clicking a message header assigns all its signals to a new plot", () => {
    const onAssignSignals = vi.fn();
    render(
      <AnalysisSignalPicker
        grouped={groupedFixture}
        selected={new Set()}
        onToggle={vi.fn()}
        onAssignSignals={onAssignSignals}
        theme="light"
      />,
    );
    fireEvent.doubleClick(screen.getByRole("button", { name: /M167_Voltage/ }));
    expect(onAssignSignals).toHaveBeenCalledWith(
      ["INV_DC_Bus_Voltage", "INV_Output_Voltage"],
      NEW_PLOT,
    );
  });

  it("sets the drag payload on signal chip dragstart", () => {
    render(
      <AnalysisSignalPicker
        grouped={groupedFixture}
        selected={new Set()}
        onToggle={vi.fn()}
        onAssignSignals={vi.fn()}
        theme="light"
      />,
    );
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByRole("checkbox", { name: "INV_DC_Bus_Voltage" }), {
      dataTransfer: { setData, effectAllowed: "" },
    });
    expect(setData).toHaveBeenCalledWith(
      SIGNALS_MIME,
      JSON.stringify({ signals: ["INV_DC_Bus_Voltage"] }),
    );
  });

  it("shows a plot dropdown for selected signals and emits assignment", () => {
    const onAssignSignals = vi.fn();
    render(
      <AnalysisSignalPicker
        grouped={groupedFixture}
        selected={new Set(["INV_DC_Bus_Voltage"])}
        onToggle={vi.fn()}
        onAssignSignals={onAssignSignals}
        assignments={{ INV_DC_Bus_Voltage: 1 }}
        plotOptions={[{ id: "g1", label: "Plot 1" }]}
        theme="light"
      />,
    );
    const trigger = screen.getByLabelText("Plot for INV_DC_Bus_Voltage");
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "New plot" }));
    expect(onAssignSignals).toHaveBeenCalledWith(["INV_DC_Bus_Voltage"], NEW_PLOT);
  });
});
