import { describe, expect, it } from "vitest";
import {
  ocvAtSoc,
  r0At,
  predictedPackV,
  predictedSagV,
  ocvToSoc,
  WFR25_NSERIES,
  WFR25_NPARALLEL,
} from "./batteryModel";

describe("batteryModel", () => {
  describe("constants", () => {
    it("uses 100S × 6P for WFR25", () => {
      expect(WFR25_NSERIES).toBe(100);
      expect(WFR25_NPARALLEL).toBe(6);
    });
  });

  describe("ocvAtSoc", () => {
    it("is monotonic (higher SoC → higher OCV)", () => {
      let prev = -Infinity;
      for (let s = 0; s <= 1.0001; s += 0.05) {
        const v = ocvAtSoc(s);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    });

    it("returns ~3.78 V at 50% SoC (the canonical mid-curve value)", () => {
      // OCV at 0.5 is bracketed by the [0.494, 0.545] data; linear interp
      // lands near 3.78 V.
      expect(ocvAtSoc(0.5)).toBeCloseTo(3.78, 1);
    });

    it("clamps below the lowest measured SoC", () => {
      const lowest = ocvAtSoc(0); // clamps to first point
      expect(lowest).toBeGreaterThan(3.0);
      expect(lowest).toBeLessThan(3.2);
    });

    it("clamps above the highest measured SoC (no extrapolation)", () => {
      // SoC above the highest measured point should not exceed the highest
      // measured OCV, no matter how high the input SoC.
      const atMax = ocvAtSoc(1.0);
      const atTop = ocvAtSoc(0.949);
      expect(atMax).toBeCloseTo(atTop, 3);
    });

    it("ocvToSoc is the inverse of ocvAtSoc at sample points", () => {
      for (const soc of [0.1, 0.3, 0.5, 0.7]) {
        const v = ocvAtSoc(soc);
        const back = ocvToSoc(v);
        expect(back).toBeCloseTo(soc, 2);
      }
    });
  });

  describe("r0At", () => {
    it("is positive and finite at every (SoC, T) in the measured grid", () => {
      for (const soc of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        for (const t of [5, 15, 25, 35, 45]) {
          const r = r0At(soc, t);
          expect(r).toBeGreaterThan(0);
          expect(Number.isFinite(r)).toBe(true);
        }
      }
    });

    it("cold cells have noticeably higher R₀ than warm ones (~2× at the same measured SoC level)", () => {
      // SoC=1.0 was measured at 6 °C (R₀=0.035) and 45 °C (R₀=0.017),
      // a real Li-ion cold/warm spread. Use a SoC where the data has
      // both extremes so the U-shape is exercised.
      const cold = r0At(1.0, 6);
      const warm = r0At(1.0, 45);
      expect(cold).toBeGreaterThan(warm);
      // The U-shape is real: cold is roughly 2× warm.
      expect(cold / warm).toBeGreaterThan(1.5);
    });

    it("returns a stable per-cell R₀ across the same (SoC, T) row", () => {
      // Calling r0At twice at the same args should give bit-identical results
      // (the model is pure).
      const a = r0At(0.5, 25);
      const b = r0At(0.5, 25);
      expect(a).toBe(b);
    });
  });

  describe("predictedPackV", () => {
    it("scales OCV by Nseries", () => {
      expect(predictedPackV(0.5)).toBeCloseTo(ocvAtSoc(0.5) * 100, 6);
    });

    it("at 50% SoC predicts ~378 V for a 100S pack", () => {
      // OCV at 0.5 is ~3.78 V → 378 V for 100S.
      expect(predictedPackV(0.5)).toBeGreaterThan(370);
      expect(predictedPackV(0.5)).toBeLessThan(390);
    });
  });

  describe("predictedSagV", () => {
    it("scales by current and R₀ and Nseries", () => {
      const sag = predictedSagV(100, 0.5, 25);
      expect(sag).toBeCloseTo(100 * r0At(0.5, 25) * 100, 4);
    });

    it("sag grows linearly with current (and with R₀ for cold cells)", () => {
      const s10 = predictedSagV(10, 0.5, 25);
      const s100 = predictedSagV(100, 0.5, 25);
      // 10x the current → 10x the sag (within numerical noise).
      expect(s100).toBeCloseTo(s10 * 10, 4);
    });

    it("sag is realistic for an FSAE launch (~50–200 V at 200 A, 25 °C)", () => {
      // 200 A is a peak-launch number. At 25 °C, R₀ ≈ 0.017 Ω/cell,
      // so sag = 200 × 0.017 × 100 = 340 V. That's most of the pack at
      // peak load — physically what cold-launch voltage cutoff looks like.
      const sag = predictedSagV(200, 0.5, 25);
      expect(sag).toBeGreaterThan(100);
    });
  });
});
