import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SavedConfig } from "../types";
import { AnalysisConfigMenu } from "./AnalysisConfigMenu";

function config(overrides: Partial<SavedConfig> = {}): SavedConfig {
  return {
    id: "c1",
    name: "Brake event",
    note: "sharp decel",
    author: "haorui",
    season: "wfr26",
    start: "2026-06-20T15:00:00.000Z",
    end: "2026-06-20T15:05:00.000Z",
    plots: [{ signals: ["Brake_Pressure"], rightAxis: [] }],
    created_at: "2026-06-20T15:06:00.000Z",
    updated_at: "2026-06-20T15:06:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderMenu(props: Partial<React.ComponentProps<typeof AnalysisConfigMenu>> = {}) {
  const onSave = vi.fn();
  const onLoad = vi.fn();
  const onDelete = vi.fn();
  const onToggleCollapse = vi.fn();
  render(
    <AnalysisConfigMenu
      configs={props.configs ?? [config()]}
      activeSeasonTable={props.activeSeasonTable ?? "wfr26"}
      saveDisabled={props.saveDisabled ?? false}
      collapsed={props.collapsed ?? false}
      onToggleCollapse={onToggleCollapse}
      onSave={onSave}
      onLoad={onLoad}
      onDelete={onDelete}
    />,
  );
  return { onSave, onLoad, onDelete, onToggleCollapse };
}

describe("AnalysisConfigMenu", () => {
  it("loads a config when Load is clicked", () => {
    const { onLoad } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
  });

  it("requires a title before saving and persists the author", () => {
    const { onSave } = renderMenu({ configs: [] });
    fireEvent.click(screen.getByRole("button", { name: "Save current view" }));
    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Config title"), { target: { value: "My view" } });
    fireEvent.change(screen.getByLabelText("Config author"), { target: { value: "hz" } });
    fireEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledWith({ name: "My view", note: "", author: "hz" });
    expect(window.localStorage.getItem("analysis-config-author")).toBe("hz");
  });

  it("confirms before deleting", () => {
    const { onDelete } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete?" }));
    expect(onDelete).toHaveBeenCalledWith("c1");
  });

  it("shows the plot grouping summary for each config", () => {
    renderMenu({
      configs: [
        config({ plots: [{ signals: ["Speed", "RPM"], rightAxis: [] }, { signals: ["Brake_Pressure"], rightAxis: [] }] }),
      ],
    });
    expect(screen.getByText("[Speed, RPM][Brake_Pressure]")).toBeInTheDocument();
  });

  it("notes that saved views are shared with everyone", () => {
    renderMenu();
    expect(screen.getByText(/shared with everyone/i)).toBeInTheDocument();
  });

  it("collapses to a tab that expands on click", () => {
    const { onToggleCollapse } = renderMenu({ collapsed: true });
    // Collapsed: the list is hidden, only the expand tab remains.
    expect(screen.queryByRole("button", { name: "Load" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand saved views" }));
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  it("collapses when the collapse control is clicked", () => {
    const { onToggleCollapse } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: "Collapse saved views" }));
    expect(onToggleCollapse).toHaveBeenCalled();
  });

  it("marks configs from another season", () => {
    renderMenu({ activeSeasonTable: "wfr26base" });
    const badge = screen.getByText("wfr26");
    expect(badge.className).toContain("is-other");
  });

  it("filters and caps the rendered list", () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      config({ id: `c${i}`, name: `View ${i}` }),
    );
    renderMenu({ configs: many });
    // Capped at 200 rows, so the "more" hint shows.
    expect(screen.getByText(/more/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter saved views"), {
      target: { value: "View 137" },
    });
    expect(screen.getByText("View 137")).toBeInTheDocument();
    expect(screen.queryByText(/more/i)).not.toBeInTheDocument();
  });
});
