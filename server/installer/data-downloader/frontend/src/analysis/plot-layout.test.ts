// src/analysis/plot-layout.test.ts
import { describe, expect, it } from "vitest";

import {
  MAX_TOTAL_SIGNALS,
  NEW_PLOT,
  type PlotLayout,
  assignSignals,
  clearRightAxisForSignals,
  flattenSignals,
  parseLayout,
  pruneUnknown,
  serializeLayout,
  toggleRightAxis,
  toggleSignal,
} from "./plot-layout";

function group(id: string, signals: string[], rightAxis: string[] = []) {
  return { id, signals, rightAxis };
}

describe("toggleSignal", () => {
  it("adds an unknown signal as a new solo group at the end", () => {
    const next = toggleSignal([group("a", ["S1"])], "S2");
    expect(next).toHaveLength(2);
    expect(next[1].signals).toEqual(["S2"]);
    expect(next[1].rightAxis).toEqual([]);
  });

  it("removes a present signal and prunes the emptied group", () => {
    const next = toggleSignal([group("a", ["S1"]), group("b", ["S2", "S3"])], "S1");
    expect(next).toEqual([group("b", ["S2", "S3"])]);
  });

  it("drops the signal from rightAxis when removed", () => {
    const next = toggleSignal([group("a", ["S1", "S2"], ["S1"])], "S1");
    expect(next).toEqual([group("a", ["S2"])]);
  });

  it("rejects adds beyond the total cap by returning the input unchanged", () => {
    const layout: PlotLayout = [
      group("a", Array.from({ length: MAX_TOTAL_SIGNALS }, (_, i) => `S${i}`)),
    ];
    expect(toggleSignal(layout, "OVER")).toBe(layout);
  });
});

describe("assignSignals", () => {
  it("moves an already placed signal into the target group", () => {
    const next = assignSignals([group("a", ["S1"]), group("b", ["S2"])], ["S1"], "b");
    expect(next).toEqual([group("b", ["S2", "S1"])]);
  });

  it("adds missing signals and moves existing ones together", () => {
    const next = assignSignals([group("a", ["S1"])], ["S1", "S2"], NEW_PLOT);
    expect(next).toHaveLength(1);
    expect(next[0].signals).toEqual(["S1", "S2"]);
    expect(next[0].id).not.toBe("a");
  });

  it("is a no-op for an unknown target group id", () => {
    const layout = [group("a", ["S1"])];
    expect(assignSignals(layout, ["S2"], "missing")).toBe(layout);
  });

  it("does not duplicate a signal already in the target", () => {
    const next = assignSignals([group("a", ["S1", "S2"])], ["S2"], "a");
    expect(next[0].signals).toEqual(["S1", "S2"]);
  });

  it("rejects the assignment when new signals would exceed the cap", () => {
    const layout: PlotLayout = [
      group("a", Array.from({ length: MAX_TOTAL_SIGNALS - 1 }, (_, i) => `S${i}`)),
    ];
    expect(assignSignals(layout, ["N1", "N2"], "a")).toBe(layout);
  });

  it("keeps rightAxis membership when moving a signal between groups", () => {
    const next = assignSignals(
      [group("a", ["S1"], ["S1"]), group("b", ["S2"])],
      ["S1"],
      "b",
    );
    expect(next).toEqual([group("b", ["S2", "S1"], ["S1"])]);
  });

  it("clears rightAxis when a moved signal is assigned to the left axis", () => {
    const moved = assignSignals(
      [group("a", ["S1"], ["S1"]), group("b", ["S2"])],
      ["S1"],
      "b",
    );
    const next = clearRightAxisForSignals(moved, ["S1"]);
    expect(next).toEqual([group("b", ["S2", "S1"])]);
  });
});

describe("clearRightAxisForSignals", () => {
  it("removes listed signals from rightAxis and is a no-op when none match", () => {
    const layout = [group("a", ["S1", "S2"], ["S2"])];
    expect(clearRightAxisForSignals(layout, ["S2"])).toEqual([group("a", ["S1", "S2"])]);
    expect(clearRightAxisForSignals(layout, ["S9"])).toBe(layout);
  });
});

describe("toggleRightAxis", () => {
  it("adds then removes a signal from rightAxis", () => {
    const once = toggleRightAxis([group("a", ["S1", "S2"])], "a", "S2");
    expect(once[0].rightAxis).toEqual(["S2"]);
    const twice = toggleRightAxis(once, "a", "S2");
    expect(twice[0].rightAxis).toEqual([]);
  });

  it("ignores signals not in the group and unknown group ids", () => {
    const layout = [group("a", ["S1"])];
    expect(toggleRightAxis(layout, "a", "S9")).toBe(layout);
    expect(toggleRightAxis(layout, "zz", "S1")).toBe(layout);
  });
});

describe("flattenSignals and pruneUnknown", () => {
  it("flattens in draw order", () => {
    expect(flattenSignals([group("a", ["S2", "S1"]), group("b", ["S3"])])).toEqual([
      "S2",
      "S1",
      "S3",
    ]);
  });

  it("prunes unknown signals and emptied groups, keeping reference when unchanged", () => {
    const layout = [group("a", ["S1", "GONE"], ["GONE"]), group("b", ["GONE2"])];
    const pruned = pruneUnknown(layout, new Set(["S1"]));
    expect(pruned).toEqual([group("a", ["S1"])]);
    expect(pruneUnknown(pruned, new Set(["S1"]))).toBe(pruned);
  });
});

describe("serializeLayout and parseLayout", () => {
  it("round-trips signals and rightAxis with fresh ids", () => {
    const layout = [group("a", ["S1", "S2"], ["S2"])];
    const parsed = parseLayout(serializeLayout(layout));
    expect(parsed).not.toBeNull();
    expect(parsed!.layout[0].signals).toEqual(["S1", "S2"]);
    expect(parsed!.layout[0].rightAxis).toEqual(["S2"]);
    expect(parsed!.layout[0].id).toBeTruthy();
    expect(parsed!.colorOverrides).toEqual({});
  });

  it("round-trips v2 with color overrides", () => {
    const layout = [group("a", ["S1"])];
    const colors = { S1: "#ff0000" };
    const serialized = serializeLayout(layout, colors);
    const parsed = parseLayout(serialized);
    expect(parsed).not.toBeNull();
    expect(parsed!.layout[0].signals).toEqual(["S1"]);
    expect(parsed!.colorOverrides).toEqual({ S1: "#ff0000" });
  });

  it("parses legacy v1 layout without errors", () => {
    const raw = '{"v":1,"plots":[{"signals":["S1"],"rightAxis":[]}]}';
    const parsed = parseLayout(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.layout[0].signals).toEqual(["S1"]);
    expect(parsed!.colorOverrides).toEqual({});
  });

  it.each([null, "", "not json", '{"v":3,"plots":[]}', '{"v":1,"plots":"x"}', '{"v":1,"plots":[{"signals":"x"}]}'])(
    "returns null for corrupt or wrong-version input %#",
    (raw) => {
      expect(parseLayout(raw as string | null)).toBeNull();
    },
  );

  it("drops non-string entries and keeps rightAxis a subset on parse", () => {
    const parsed = parseLayout('{"v":1,"plots":[{"signals":["S1",5],"rightAxis":["S1","GHOST"]}]}');
    expect(parsed!.layout).toEqual([
      { id: expect.any(String), signals: ["S1"], rightAxis: ["S1"] },
    ]);
  });
});
