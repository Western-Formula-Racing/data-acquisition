import { describe, expect, it } from "vitest";

import {
  CHARGECART_PATH,
  isChargecartPath,
  isChargecartTelemetryCanId,
} from "./chargecartRuntime";

describe("chargecartRuntime", () => {
  describe("isChargecartPath", () => {
    it("matches the canonical chargecart path", () => {
      expect(isChargecartPath(CHARGECART_PATH)).toBe(true);
    });

    it("matches the chargecart path with a trailing slash (nginx redirect)", () => {
      expect(isChargecartPath("/chargecart/")).toBe(true);
    });

    it("does not match unrelated chargecart-prefixed paths", () => {
      expect(isChargecartPath("/chargecart-debug")).toBe(false);
      expect(isChargecartPath("/chargecart/extra")).toBe(false);
    });

    it("rejects empty / nullish input", () => {
      expect(isChargecartPath("")).toBe(false);
      expect(isChargecartPath(null)).toBe(false);
      expect(isChargecartPath(undefined)).toBe(false);
    });
  });

  describe("isChargecartTelemetryCanId", () => {
    it("accepts heartbeat IDs", () => {
      expect(isChargecartTelemetryCanId(1999)).toBe(true);
      expect(isChargecartTelemetryCanId(0x7FD)).toBe(true);
    });

    it("accepts BMS and balance sequence IDs", () => {
      expect(isChargecartTelemetryCanId(992)).toBe(true);
      expect(isChargecartTelemetryCanId(998)).toBe(true);
      expect(isChargecartTelemetryCanId(1000)).toBe(true);
      expect(isChargecartTelemetryCanId(1057)).toBe(true);
    });

    it("rejects unrelated CAN IDs", () => {
      expect(isChargecartTelemetryCanId(0x100)).toBe(false);
      expect(isChargecartTelemetryCanId(991)).toBe(false);
      expect(isChargecartTelemetryCanId(1058)).toBe(false);
    });
  });
});
