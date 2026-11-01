import { describe, expect, it } from "vitest";
import type { Data, PlotRelayoutEvent } from "plotly.js";

import type { SignalSeries } from "../types";
import { buildTraces, parseXRangeRelayout } from "./plot-traces";
import { plotStroke } from "../components/sensor-palette";

/** Plotly can emit numbers, Date, or ISO strings; typings only allow numbers. */
function asRelayout(event: Record<string, unknown>): PlotRelayoutEvent {
  return event as unknown as PlotRelayoutEvent;
}

const raw: SignalSeries = {
  mode: "raw",
  resolution_ms: null,
  point_count: 2,
  t: [0, 1000],
  v: [1, 2],
};

const env: SignalSeries = {
  mode: "envelope",
  resolution_ms: 2500,
  point_count: 2,
  t: [0, 2500],
  min: [1, 2],
  max: [3, 4],
  avg: [2, 3],
};

function asTraces(data: Data[]): Array<Record<string, unknown>> {
  return data as Array<Record<string, unknown>>;
}

describe("buildTraces", () => {
  it("builds one scattergl line for raw series with Date x-values", () => {
    const traces = asTraces(buildTraces("A", raw, "#f47560"));
    expect(traces).toHaveLength(1);
    expect(traces[0].type).toBe("scattergl");
    expect(traces[0].mode).toBe("lines");
    expect(traces[0].name).toBe("A");
    const x = traces[0].x as Date[];
    expect(x).toHaveLength(2);
    expect(x[0]).toBeInstanceOf(Date);
    expect(x[0].getTime()).toBe(0);
    expect(x[1].getTime()).toBe(1000);
    expect(traces[0].y).toEqual([1, 2]);
    expect((traces[0].line as { color: string }).color).toBe("#f47560");
  });

  it("builds max, min band, and avg traces for envelope series", () => {
    const traces = asTraces(buildTraces("A", env, "#f47560"));
    expect(traces).toHaveLength(3);
    const [maxT, minT, avgT] = traces;

    expect(maxT.type).toBe("scattergl");
    expect(minT.type).toBe("scattergl");
    expect(avgT.type).toBe("scattergl");

    expect(minT.fill).toBe("tonexty");
    expect(maxT.showlegend).toBe(false);
    expect(minT.showlegend).toBe(false);
    expect(avgT.name).toContain("A");

    const maxLine = maxT.line as { color: string };
    const minLine = minT.line as { color: string };
    const avgLine = avgT.line as { color: string };
    expect(avgLine.color).toBe("#f47560");
    // Band edges share the signal color family (transparent stroke / tinted fill).
    expect(maxLine.color).toContain("rgba");
    expect(minLine.color).toContain("rgba");
    expect(String(minT.fillcolor)).toContain("rgba");
    expect(minT.fillcolor).toContain("244, 117, 96");

    expect(maxT.y).toEqual([3, 4]);
    expect(minT.y).toEqual([1, 2]);
    expect(avgT.y).toEqual([2, 3]);
  });
});

describe("parseXRangeRelayout", () => {
  it("uses finite numbers as epoch ms (including 0)", () => {
    expect(
      parseXRangeRelayout(
        asRelayout({
          "xaxis.range[0]": 0,
          "xaxis.range[1]": 1000,
        }),
      ),
    ).toEqual([0, 1000]);

    expect(parseXRangeRelayout(asRelayout({ "xaxis.range": [0, 1000] }))).toEqual([
      0, 1000,
    ]);
  });

  it("accepts Date bounds via getTime", () => {
    const start = new Date(0);
    const end = new Date(1000);
    expect(
      parseXRangeRelayout(
        asRelayout({
          "xaxis.range[0]": start,
          "xaxis.range[1]": end,
        }),
      ),
    ).toEqual([0, 1000]);
    expect(parseXRangeRelayout(asRelayout({ "xaxis.range": [start, end] }))).toEqual([
      0, 1000,
    ]);
  });

  it("parses ISO date strings", () => {
    expect(
      parseXRangeRelayout(
        asRelayout({
          "xaxis.range[0]": "1970-01-01T00:00:00.000Z",
          "xaxis.range[1]": "1970-01-01T00:00:01.000Z",
        }),
      ),
    ).toEqual([0, 1000]);
    expect(
      parseXRangeRelayout(
        asRelayout({
          "xaxis.range": ["1970-01-01T00:00:00.000Z", "1970-01-01T00:00:01.000Z"],
        }),
      ),
    ).toEqual([0, 1000]);
  });

  it("returns null for malformed values", () => {
    expect(
      parseXRangeRelayout(
        asRelayout({
          "xaxis.range[0]": "not-a-date",
          "xaxis.range[1]": 1000,
        }),
      ),
    ).toBeNull();
    expect(parseXRangeRelayout(asRelayout({ "xaxis.range": ["bad", "worse"] }))).toBeNull();
    expect(
      parseXRangeRelayout(
        asRelayout({
          "xaxis.range[0]": { foo: 1 },
          "xaxis.range[1]": 1000,
        }),
      ),
    ).toBeNull();
  });

  it("returns null for non-finite values", () => {
    expect(
      parseXRangeRelayout(
        asRelayout({
          "xaxis.range[0]": Number.NaN,
          "xaxis.range[1]": 1000,
        }),
      ),
    ).toBeNull();
    expect(
      parseXRangeRelayout(
        asRelayout({
          "xaxis.range": [0, Number.POSITIVE_INFINITY],
        }),
      ),
    ).toBeNull();
    expect(
      parseXRangeRelayout(
        asRelayout({
          "xaxis.range[0]": new Date(Number.NaN),
          "xaxis.range[1]": new Date(1000),
        }),
      ),
    ).toBeNull();
  });

  it("returns null for reversed or equal bounds", () => {
    expect(
      parseXRangeRelayout(
        asRelayout({
          "xaxis.range[0]": 1000,
          "xaxis.range[1]": 0,
        }),
      ),
    ).toBeNull();
    expect(parseXRangeRelayout(asRelayout({ "xaxis.range": [500, 500] }))).toBeNull();
  });

  it("returns [NaN, NaN] only for explicit autorange", () => {
    const auto = parseXRangeRelayout(asRelayout({ "xaxis.autorange": true }));
    expect(auto).not.toBeNull();
    expect(Number.isNaN(auto![0])).toBe(true);
    expect(Number.isNaN(auto![1])).toBe(true);

    expect(parseXRangeRelayout(asRelayout({}))).toBeNull();
    expect(parseXRangeRelayout(asRelayout({ "yaxis.range": [0, 1] }))).toBeNull();
  });
});

describe("plotStroke", () => {
  it("returns the shared palette border color and is case-insensitive", () => {
    expect(plotStroke("ws_fl", "light")).toBe(plotStroke("WS_FL", "light"));
    expect(plotStroke("WS_FL", "light")).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("buildTraces yAxis", () => {
  const raw = { mode: "raw" as const, resolution_ms: null, point_count: 1, t: [0], v: [1] };

  it("defaults every trace to the left axis", () => {
    for (const trace of buildTraces("S1", raw, "#2563eb")) {
      expect((trace as { yaxis?: string }).yaxis).toBe("y");
    }
  });

  it("assigns y2 to all traces of a right-axis signal, including envelope bands", () => {
    const env = {
      mode: "envelope" as const,
      resolution_ms: 1000,
      point_count: 1,
      t: [0],
      min: [0],
      max: [2],
      avg: [1],
    };
    const traces = buildTraces("S1", env, "#2563eb", "y2");
    expect(traces).toHaveLength(3);
    for (const trace of traces) {
      expect((trace as { yaxis?: string }).yaxis).toBe("y2");
    }
  });

  it("fills the envelope band at 0.15 alpha", () => {
    const env = {
      mode: "envelope" as const,
      resolution_ms: 1000,
      point_count: 1,
      t: [0],
      min: [0],
      max: [2],
      avg: [1],
    };
    const [, minTrace] = buildTraces("S1", env, "#2563eb");
    expect((minTrace as { fillcolor?: string }).fillcolor).toBe("rgba(37, 99, 235, 0.15)");
  });
});
