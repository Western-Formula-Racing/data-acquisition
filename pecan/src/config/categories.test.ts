import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATEGORY,
  determineCategory,
  getAllCategoryNames,
  getCategoryColor,
  getCategoryConfigString,
  updateCategories,
} from "./categories";

describe("categories config", () => {
  it("parses valid categories with ranges and ids", () => {
    updateCategories([
      "POWER,bg-red-500,256,257",
      "BMS,bg-green-500,300-302",
    ].join("\n"));

    expect(determineCategory("256")).toBe("POWER");
    expect(determineCategory("301")).toBe("BMS");
  });

  it("ignores comments and empty lines", () => {
    updateCategories([
      "# comment",
      "",
      "// comment 2",
      "CORE,bg-blue-500,10",
    ].join("\n"));

    expect(getAllCategoryNames()).toEqual(["CORE"]);
  });

  it("falls back to default for unknown or invalid ids", () => {
    updateCategories("CORE,bg-blue-500,10");
    expect(determineCategory("99999")).toBe(DEFAULT_CATEGORY.name);
    expect(determineCategory("not-an-id")).toBe(DEFAULT_CATEGORY.name);
  });

  it("supports hex and decimal msg ids", () => {
    updateCategories("TEST,bg-yellow-500,26");
    expect(determineCategory("26")).toBe("TEST");
    expect(determineCategory("0x1A")).toBe("TEST");
  });

  it("uses explicit category override", () => {
    updateCategories("POWER,bg-red-500,256");
    expect(determineCategory("256", "MANUAL")).toBe("MANUAL");
  });

  it("returns configured color and fallback color", () => {
    updateCategories("POWER,bg-red-500,256");
    expect(getCategoryColor("POWER")).toBe("bg-red-500");
    expect(getCategoryColor("UNKNOWN")).toBe(DEFAULT_CATEGORY.color);
  });

  it("stores and returns raw config text", () => {
    const cfg = "A,bg-a,1\nB,bg-b,2";
    updateCategories(cfg);
    expect(getCategoryConfigString()).toBe(cfg);
  });

  it("skips invalid lines that are too short", () => {
    updateCategories([
      "broken",
      "VALID,bg-cyan-500,100",
    ].join("\n"));

    expect(getAllCategoryNames()).toEqual(["VALID"]);
  });
});
