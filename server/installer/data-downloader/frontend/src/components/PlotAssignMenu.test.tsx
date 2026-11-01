import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NEW_PLOT } from "../analysis/plot-layout";
import type { PlotAssignOption } from "./PlotAssignMenu";
import { PlotAssignMenu } from "./PlotAssignMenu";

const options: PlotAssignOption[] = [
  { id: "g1", label: "Plot 1" },
  { id: "g2", label: "Plot 2" },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderMenu(value = "g1") {
  const onAssign = vi.fn();
  render(<PlotAssignMenu signal="S" value={value} options={options} onAssign={onAssign} />);
  return { onAssign };
}

describe("PlotAssignMenu", () => {
  it("renders the current value as the trigger label", () => {
    renderMenu();
    const trigger = screen.getByLabelText("Plot for S");
    expect(trigger.textContent).toContain("Plot 1");
  });

  it("opens the listbox, selects an option, and assigns", () => {
    const { onAssign } = renderMenu();
    fireEvent.click(screen.getByLabelText("Plot for S"));
    fireEvent.click(screen.getByRole("option", { name: "Plot 2" }));
    expect(onAssign).toHaveBeenCalledWith("g2");
  });

  it("exposes a New plot item that assigns NEW_PLOT", () => {
    const { onAssign } = renderMenu();
    fireEvent.click(screen.getByLabelText("Plot for S"));
    fireEvent.click(screen.getByRole("option", { name: "New plot" }));
    expect(onAssign).toHaveBeenCalledWith(NEW_PLOT);
  });

  it("closes on Escape and ignores further key events", () => {
    const { onAssign } = renderMenu();
    fireEvent.click(screen.getByLabelText("Plot for S"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onAssign).not.toHaveBeenCalled();
  });

  it("navigates with arrow keys and assigns on Enter", () => {
    const { onAssign } = renderMenu("g1");
    fireEvent.click(screen.getByLabelText("Plot for S"));
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onAssign).toHaveBeenCalledWith("g2");
  });

  it("checks the row matching the current value", () => {
    renderMenu("g2");
    fireEvent.click(screen.getByLabelText("Plot for S"));
    const selected = screen.getByRole("option", { name: "Plot 2" });
    expect(selected).toHaveAttribute("aria-selected", "true");
  });
});
