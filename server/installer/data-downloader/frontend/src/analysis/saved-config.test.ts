import { describe, expect, it } from "vitest";

import type { PlotLayout } from "./plot-layout";
import { layoutToPlots, plotsToLayout } from "./saved-config";

describe("layoutToPlots", () => {
  it("strips group ids and copies signal arrays", () => {
    const layout: PlotLayout = [{ id: "g1", signals: ["A", "B"], rightAxis: ["B"] }];
    expect(layoutToPlots(layout)).toEqual([{ signals: ["A", "B"], rightAxis: ["B"] }]);
  });
});

describe("plotsToLayout", () => {
  it("assigns fresh unique ids to each group", () => {
    const layout = plotsToLayout([
      { signals: ["A"], rightAxis: [] },
      { signals: ["B"], rightAxis: [] },
    ]);
    expect(layout).toHaveLength(2);
    expect(layout[0].id).not.toEqual(layout[1].id);
  });

  it("drops empty groups and non-string signals", () => {
    const layout = plotsToLayout([
      { signals: [], rightAxis: [] },
      { signals: ["A", 5 as unknown as string], rightAxis: [] },
    ]);
    expect(layout).toHaveLength(1);
    expect(layout[0].signals).toEqual(["A"]);
  });

  it("intersects rightAxis with signals", () => {
    const layout = plotsToLayout([{ signals: ["A"], rightAxis: ["A", "B"] }]);
    expect(layout[0].rightAxis).toEqual(["A"]);
  });
});
