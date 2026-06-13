// pecan/src/lib/wcars/sdSignals.test.ts
import { describe, it, expect } from "vitest";
import { classifyStatus, SD_SIGNALS, type SdSignalDef } from "./sdSignals";

const def: SdSignalDef = {
  msgId: "0xA2", signal: "INV_Motor_Temp", unit: "°C",
  range: [0, 160], amber: 120, red: 140,
};
const soc: SdSignalDef = {
  msgId: "0x6B0", signal: "Pack_SOC", unit: "%",
  range: [0, 100], amberLow: 30, redLow: 15,
};

describe("classifyStatus", () => {
  it("returns missing for null/undefined", () => {
    expect(classifyStatus(null, def)).toBe("missing");
    expect(classifyStatus(undefined, def)).toBe("missing");
  });
  it("high-side thresholds: normal < amber <= caution < red <= warning", () => {
    expect(classifyStatus(100, def)).toBe("normal");
    expect(classifyStatus(120, def)).toBe("caution");
    expect(classifyStatus(139, def)).toBe("caution");
    expect(classifyStatus(140, def)).toBe("warning");
  });
  it("low-side thresholds for SoC", () => {
    expect(classifyStatus(50, soc)).toBe("normal");
    expect(classifyStatus(30, soc)).toBe("caution");
    expect(classifyStatus(15, soc)).toBe("warning");
  });
  it("SD_SIGNALS is keyed and every def has a hex msgId + range", () => {
    for (const d of Object.values(SD_SIGNALS)) {
      expect(d.msgId).toMatch(/^0x[0-9A-Fa-f]+$/);
      expect(d.range[1]).toBeGreaterThan(d.range[0]);
    }
  });
});
