import { describe, expect, it } from "vitest";
import { firstOpen, seriesEnergized } from "./safetyLoop";

describe("seriesEnergized", () => {
  it("keeps the whole loop live when every contact is closed", () => {
    expect(seriesEnergized([true, true, true, true])).toEqual([
      true, true, true, true, true,
    ]);
  });

  it("drops power from the first open contact onward", () => {
    expect(seriesEnergized([true, false, true, true])).toEqual([
      true, true, false, false, false,
    ]);
  });

  it("treats an empty chain as a live source only", () => {
    expect(seriesEnergized([])).toEqual([true]);
  });
});

describe("firstOpen", () => {
  it("returns -1 when the loop is intact", () => {
    expect(firstOpen([true, true, true])).toBe(-1);
  });

  it("returns the index of the broken contact", () => {
    expect(firstOpen([true, true, false, true])).toBe(2);
  });
});
