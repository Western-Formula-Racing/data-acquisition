import type { PlotLayout } from "./plot-layout";
import type { SavedConfigPlot } from "../types";

let idCounter = 0;

function createGroupId(): string {
  idCounter += 1;
  return `cfg-${Date.now().toString(36)}-${idCounter}`;
}

export function layoutToPlots(layout: PlotLayout): SavedConfigPlot[] {
  return layout.map((g) => ({ signals: [...g.signals], rightAxis: [...g.rightAxis] }));
}

// Mirror parseLayout's defensiveness: a config may have been saved by an older
// client, so drop empty groups, non-string signals, and stray rightAxis entries.
export function plotsToLayout(plots: SavedConfigPlot[]): PlotLayout {
  const layout: PlotLayout = [];
  for (const entry of plots) {
    if (!entry || !Array.isArray(entry.signals)) continue;
    const signals = entry.signals.filter((s): s is string => typeof s === "string");
    if (signals.length === 0) continue;
    const right = Array.isArray(entry.rightAxis)
      ? entry.rightAxis.filter((s): s is string => typeof s === "string")
      : [];
    layout.push({
      id: createGroupId(),
      signals,
      rightAxis: right.filter((s) => signals.includes(s)),
    });
  }
  return layout;
}
