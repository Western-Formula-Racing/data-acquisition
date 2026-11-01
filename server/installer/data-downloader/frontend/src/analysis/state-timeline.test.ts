import { describe, expect, it } from "vitest";

import type { StatesResponse } from "../types";
import {
  faultNamesAt,
  formatDuration,
  MIN_ZOOM_SPAN_MS,
  padRange,
  segmentBox,
  severityFor,
} from "./state-timeline";

describe("severityFor", () => {
  it("classifies car states", () => {
    expect(severityFor("car", 4)).toBe("ok");
    expect(severityFor("car", 0)).toBe("transitional");
    expect(severityFor("car", 5)).toBe("fault");
    expect(severityFor("car", 6)).toBe("fault");
    expect(severityFor("car", 99)).toBe("unknown");
  });

  it("classifies inverter VSM states", () => {
    expect(severityFor("inverter", 6)).toBe("ok");
    expect(severityFor("inverter", 2)).toBe("transitional");
    expect(severityFor("inverter", 7)).toBe("fault");
    expect(severityFor("inverter", 14)).toBe("transitional");
    expect(severityFor("inverter", 42)).toBe("unknown");
  });

  it("returns unknown for unknown lanes", () => {
    expect(severityFor("nope", 4)).toBe("unknown");
  });
});

describe("segmentBox", () => {
  const view: [number, number] = [1000, 11000];

  it("maps a segment inside the view to percentages", () => {
    expect(segmentBox(1000, 6000, view)).toEqual({ leftPct: 0, widthPct: 50 });
  });

  it("clips segments that overflow the view", () => {
    const box = segmentBox(0, 21000, view);
    expect(box).toEqual({ leftPct: 0, widthPct: 100 });
  });

  it("returns null for segments outside the view or invalid spans", () => {
    expect(segmentBox(11000, 12000, view)).toBeNull();
    expect(segmentBox(0, 1000, view)).toBeNull();
    expect(segmentBox(2000, 3000, [5, 5])).toBeNull();
  });

  it("enforces a minimum visible width", () => {
    const box = segmentBox(5000, 5001, view);
    expect(box).not.toBeNull();
    expect(box!.widthPct).toBeGreaterThan(0.3);
  });
});

describe("padRange", () => {
  it("passes wide ranges through", () => {
    expect(padRange(0, 5000)).toEqual([0, 5000]);
  });

  it("pads short ranges to the minimum span, centered", () => {
    const [start, end] = padRange(1000, 1200);
    expect(end - start).toBe(MIN_ZOOM_SPAN_MS);
    expect(start).toBe(600);
    expect(end).toBe(1600);
  });
});

describe("formatDuration", () => {
  it("formats ms, seconds, minutes, and hours", () => {
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(3200)).toBe("3.2 s");
    expect(formatDuration(72000)).toBe("1 m 12 s");
    expect(formatDuration(3_660_000)).toBe("1 h 1 m");
  });
});

describe("faultNamesAt", () => {
  const data: StatesResponse = {
    season: "wfr26",
    start: "s",
    end: "e",
    lanes: [],
    faults: [
      {
        name: "Over-current Fault",
        source: "run",
        segments: [{ start_ms: 100, end_ms: 200 }],
      },
      {
        name: "Precharge Timeout",
        source: "post",
        segments: [{ start_ms: 150, end_ms: 400 }],
      },
    ],
  };

  it("lists every fault overlapping the interval", () => {
    expect(faultNamesAt(data, 150, 180)).toEqual([
      "Over-current Fault",
      "Precharge Timeout",
    ]);
    expect(faultNamesAt(data, 300, 350)).toEqual(["Precharge Timeout"]);
    expect(faultNamesAt(data, 500, 600)).toEqual([]);
  });
});
