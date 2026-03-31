import { describe, expect, it } from "vitest";
import {
  parsePecanSessionJson,
  parseWFRECUCsv,
  parseReplayCsv,
  validateFileSize,
} from "./replayParser";

describe("replayParser", () => {
  describe("validateFileSize", () => {
    it("returns warning above soft limit", () => {
      const result = validateFileSize(120 * 1024 * 1024);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings[0]?.code).toBe("file-size-soft-limit");
    });

    it("returns error above hard limit", () => {
      const result = validateFileSize(151 * 1024 * 1024);
      expect(result.errors[0]?.message).toContain("Hard limit");
    });
  });

  describe("parseReplayCsv", () => {
    it("parses valid CSV", () => {
      const csv = [
        "t_rel_ms,can_id,is_extended,direction,dlc,data_hex,source",
        "0,256,0,rx,2,0A0B,test",
        "100,512,1,tx,4,01020304,test",
      ].join("\n");

      const result = parseReplayCsv(csv);
      expect(result.errors).toHaveLength(0);
      expect(result.frames).toHaveLength(2);
      expect(result.frames[0]).toMatchObject({
        tRelMs: 0,
        canId: 256,
        isExtended: false,
        direction: "rx",
        dlc: 2,
        dataHex: "0a0b",
      });
    });

    it("fails when required column is missing", () => {
      const csv = [
        "t_rel_ms,can_id,is_extended,direction,data_hex",
        "0,256,0,rx,0A0B",
      ].join("\n");

      const result = parseReplayCsv(csv);
      expect(result.errors.some((e) => e.field === "dlc")).toBe(true);
    });

    it("fails when both t_rel_ms and t_epoch_ms are missing", () => {
      const csv = [
        "can_id,is_extended,direction,dlc,data_hex",
        "256,0,rx,2,0A0B",
      ].join("\n");

      const result = parseReplayCsv(csv);
      expect(result.errors.some((e) => e.message.includes("t_rel_ms or t_epoch_ms"))).toBe(true);
    });

    it("derives t_rel_ms from t_epoch_ms when needed", () => {
      const csv = [
        "t_rel_ms,t_epoch_ms,can_id,is_extended,direction,dlc,data_hex",
        "0,1700000000100,256,0,rx,1,AA",
        "0,1700000000200,257,0,rx,1,BB",
      ].join("\n");

      const result = parseReplayCsv(csv);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings.some((w) => w.code === "derived-t-rel")).toBe(true);
      expect(result.frames[0].tRelMs).toBe(0);
      expect(result.frames[1].tRelMs).toBe(100);
    });

    it("fails when data length mismatches dlc", () => {
      const csv = [
        "t_rel_ms,can_id,is_extended,direction,dlc,data_hex",
        "0,256,0,rx,4,ABCD",
      ].join("\n");

      const result = parseReplayCsv(csv);
      expect(result.errors.some((e) => e.field === "data_hex")).toBe(true);
    });

    it("fails on invalid direction", () => {
      const csv = [
        "t_rel_ms,can_id,is_extended,direction,dlc,data_hex",
        "0,256,0,bad,1,AA",
      ].join("\n");

      const result = parseReplayCsv(csv);
      expect(result.errors.some((e) => e.field === "direction")).toBe(true);
    });

    it("handles quoted CSV fields", () => {
      const csv = [
        "t_rel_ms,can_id,is_extended,direction,dlc,data_hex,source",
        "0,256,0,rx,1,AA,\"quoted,source\"",
      ].join("\n");

      const result = parseReplayCsv(csv);
      expect(result.errors).toHaveLength(0);
      expect(result.frames[0].source).toBe("quoted,source");
    });

    it("flags when frame count exceeds hard cap", () => {
      const rows: string[] = ["t_rel_ms,can_id,is_extended,direction,dlc,data_hex"];
      for (let i = 0; i < 1_000_005; i += 1) {
        rows.push(`${i},256,0,rx,1,AA`);
      }

      const result = parseReplayCsv(rows.join("\n"));
      expect(result.errors).toHaveLength(0);
      expect(result.frames).toHaveLength(1_000_005);
      expect(result.warnings.some((w) => w.code === "frame-cap-exceeded")).toBe(true);
    });
  });

  describe("parseWFRECUCsv", () => {
    it("maps headerless ECU rows into PECAN replay frames", () => {
      const fileName = "2026-03-29-20-06-42.csv";
      const content = [
        "42504,CAN,176,0,0,248,255,0,0,4,0",
        "42505,CAN,160,11,1,16,1,13,1,102,1",
      ].join("\n");

      const result = parseWFRECUCsv(content, fileName);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings.some((w) => w.code === "ecu-epoch-from-filename-missing")).toBe(false);
      expect(result.frames).toHaveLength(2);

      expect(result.frames[0]).toMatchObject({
        tRelMs: 42504,
        canId: 176,
        direction: "rx",
        isExtended: false,
        dlc: 8,
        dataHex: "0000f8ff00000400",
        source: "wfrecu",
      });
    });

    it("derives tEpochMs from filename start time + ECU ms since start", () => {
      const fileName = "2026-03-29-20-06-42.csv";
      const tRelMs = 42504;
      const content = [`${tRelMs},CAN,176,0,0,248,255,0,0,4,0`].join("\n");

      const expectedEpochBaseMs = new Date(2026, 2, 29, 20, 6, 42).getTime();
      const result = parseWFRECUCsv(content, fileName);

      expect(result.errors).toHaveLength(0);
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0].tEpochMs).toBe(expectedEpochBaseMs + tRelMs);
    });

    it("accepts trailing comma (12-column) ECU rows", () => {
      const fileName = "2026-03-29-20-06-42.csv";
      const content = [
        "70026,CAN,2048,0,0,0,0,0,0,0,0,",
      ].join("\n");

      const result = parseWFRECUCsv(content, fileName);
      expect(result.errors).toHaveLength(0);
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0]).toMatchObject({
        canId: 2048,
        isExtended: true,
        dlc: 8,
        direction: "rx",
        dataHex: "0000000000000000",
      });
    });

    it("flags oversized ECU imports for clipping", () => {
      const fileName = "2026-03-29-20-06-42.csv";
      const rows: string[] = [];
      for (let i = 0; i < 1_000_002; i += 1) {
        rows.push(`${i},CAN,176,0,0,1,0,0,0,4,0`);
      }

      const result = parseWFRECUCsv(rows.join("\n"), fileName);
      expect(result.errors).toHaveLength(0);
      expect(result.frames).toHaveLength(1_000_002);
      expect(result.warnings.some((w) => w.code === "frame-cap-exceeded")).toBe(true);
    });
  });

  describe("parsePecanSessionJson", () => {
    it("parses valid v2 pecan session", () => {
      // flags: 0 = rx + standard
      const content = JSON.stringify({
        format: "pecan-session",
        version: 2,
        columns: ["tRelMs", "canId", "flags", "dataHex"],
        frames: [[0, 256, 0, "0a0b"]],
        timeline: { windowMs: 30000 },
      });

      const result = parsePecanSessionJson(content);
      expect(result.errors).toHaveLength(0);
      expect(result.frames).toHaveLength(1);
      expect(result.frames[0]).toMatchObject({
        tRelMs: 0,
        canId: 256,
        isExtended: false,
        direction: "rx",
        dlc: 2,
        dataHex: "0a0b",
      });
      expect(result.sessionMeta?.timeline?.windowMs).toBe(30000);
    });

    it("decodes flags correctly (tx + extended)", () => {
      // flags: 3 = isExtended(bit0=1) + isTx(bit1=1)
      const content = JSON.stringify({
        format: "pecan-session",
        version: 2,
        columns: ["tRelMs", "canId", "flags", "dataHex"],
        frames: [[100, 512, 3, "01020304"]],
      });

      const result = parsePecanSessionJson(content);
      expect(result.errors).toHaveLength(0);
      expect(result.frames[0]).toMatchObject({
        isExtended: true,
        direction: "tx",
        dlc: 4,
      });
    });

    it("derives tEpochMs from epochBaseMs", () => {
      const epochBaseMs = 1700000000000;
      const content = JSON.stringify({
        format: "pecan-session",
        version: 2,
        columns: ["tRelMs", "canId", "flags", "dataHex"],
        epochBaseMs,
        frames: [[500, 256, 0, "aa"]],
      });

      const result = parsePecanSessionJson(content);
      expect(result.errors).toHaveLength(0);
      expect(result.frames[0].tEpochMs).toBe(epochBaseMs + 500);
    });

    it("fails on invalid JSON", () => {
      const result = parsePecanSessionJson("{bad");
      expect(result.errors[0]?.message).toContain("Invalid JSON");
    });

    it("fails on wrong format/version", () => {
      const result = parsePecanSessionJson(
        JSON.stringify({ format: "x", version: 99, frames: [] })
      );
      expect(result.errors.some((e) => e.field === "format")).toBe(true);
      expect(result.errors.some((e) => e.field === "version")).toBe(true);
    });

    it("fails on malformed frame tuple", () => {
      const result = parsePecanSessionJson(
        JSON.stringify({
          format: "pecan-session",
          version: 2,
          columns: ["tRelMs", "canId", "flags", "dataHex"],
          frames: [[123]],
        })
      );
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("fails frame validation on negative tRelMs", () => {
      const result = parsePecanSessionJson(
        JSON.stringify({
          format: "pecan-session",
          version: 2,
          columns: ["tRelMs", "canId", "flags", "dataHex"],
          frames: [[-1, 256, 0, "aa"]],
        })
      );
      expect(result.errors.some((e) => e.field === "t_rel_ms")).toBe(true);
    });
  });
});
