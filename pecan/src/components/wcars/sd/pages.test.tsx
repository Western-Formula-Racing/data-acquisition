import { describe, it, expect } from "vitest";
import { SD_PAGES, PAGE_ORDER, ruleToPage } from "./pages";

describe("SD pages registry", () => {
  it("has all six pages in order", () => {
    expect(PAGE_ORDER).toEqual(["WHEEL", "ELEC", "MOTOR", "COOL", "STS", "MSG"]);
    for (const id of PAGE_ORDER) {
      expect(SD_PAGES[id].label).toBeTruthy();
      expect(SD_PAGES[id].Component).toBeTruthy();
    }
  });
  it("maps subsystem warning rules to pages", () => {
    expect(ruleToPage("TORCH_CELL_TEMP")).toBe("ELEC");
    expect(ruleToPage("INV_FAULT")).toBe("MOTOR");
    expect(ruleToPage("UNKNOWN_RULE")).toBeNull();
  });
});
