import pako from "pako";

import type {
  ReplayDirection,
  ReplayFrame,
  ReplayParseResult,
  ReplaySession,
  ReplayValidationError,
  ReplayValidationWarning,
} from "../types/replay";

const SOFT_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const HARD_FILE_SIZE_BYTES = 150 * 1024 * 1024;
const HARD_FRAME_CAP = 1_000_000;
export const REPLAY_FRAME_HARD_CAP = HARD_FRAME_CAP;

function normalizeHex(input: string): string {
  return input.replace(/\s+/g, "").toLowerCase();
}

function isHexEvenLength(input: string): boolean {
  return input.length % 2 === 0 && /^[0-9a-f]*$/.test(input);
}

function parseDirection(value: string): ReplayDirection | null {
  const v = value.trim().toLowerCase();
  if (v === "rx" || v === "tx") return v;
  return null;
}

function parseBooleanBit(value: string): boolean | null {
  const v = value.trim();
  if (v === "1") return true;
  if (v === "0") return false;
  return null;
}

function parseNumber(value: string): number | null {
  if (!value.trim()) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function validateFrame(frame: ReplayFrame, row: number): ReplayValidationError[] {
  const errors: ReplayValidationError[] = [];

  if (!Number.isFinite(frame.tRelMs) || frame.tRelMs < 0) {
    errors.push({ row, field: "t_rel_ms", message: "t_rel_ms must be a non-negative number" });
  }
  if (!Number.isInteger(frame.canId) || frame.canId < 0) {
    errors.push({ row, field: "can_id", message: "can_id must be a non-negative integer" });
  }
  if (!Number.isInteger(frame.dlc) || frame.dlc < 0 || frame.dlc > 8) {
    errors.push({ row, field: "dlc", message: "dlc must be an integer in [0, 8]" });
  }

  const compactHex = normalizeHex(frame.dataHex);
  if (!isHexEvenLength(compactHex)) {
    errors.push({ row, field: "data_hex", message: "data_hex must contain an even number of hex characters" });
  } else if (compactHex.length / 2 !== frame.dlc) {
    errors.push({ row, field: "data_hex", message: "data_hex byte length must match dlc" });
  }

  return errors;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  cells.push(current);
  return cells;
}

function parseCsvHeader(header: string): Map<string, number> {
  const cols = parseCsvLine(header).map((c) => c.trim().toLowerCase());
  const map = new Map<string, number>();
  cols.forEach((name, index) => {
    map.set(name, index);
  });
  return map;
}

function getCsvValue(cells: string[], indexes: Map<string, number>, name: string): string {
  const idx = indexes.get(name);
  if (idx === undefined || idx >= cells.length) return "";
  return cells[idx] ?? "";
}

function parseFrameFromCsvRow(cells: string[], indexes: Map<string, number>, rowNumber: number): ReplayFrame | ReplayValidationError[] {
  const tRelRaw = getCsvValue(cells, indexes, "t_rel_ms");
  const tEpochRaw = getCsvValue(cells, indexes, "t_epoch_ms");
  const canIdRaw = getCsvValue(cells, indexes, "can_id");
  const extRaw = getCsvValue(cells, indexes, "is_extended");
  const dirRaw = getCsvValue(cells, indexes, "direction");
  const dlcRaw = getCsvValue(cells, indexes, "dlc");
  const dataRaw = getCsvValue(cells, indexes, "data_hex");

  const tRel = parseNumber(tRelRaw);
  const tEpoch = parseNumber(tEpochRaw);
  const canId = parseNumber(canIdRaw);
  const dlc = parseNumber(dlcRaw);
  const isExtended = parseBooleanBit(extRaw);
  const direction = parseDirection(dirRaw);

  const errors: ReplayValidationError[] = [];
  if (tRel === null && tEpoch === null) {
    errors.push({ row: rowNumber, field: "t_rel_ms", message: "row must provide t_rel_ms or t_epoch_ms" });
  }
  if (canId === null) {
    errors.push({ row: rowNumber, field: "can_id", message: "can_id is required and must be numeric" });
  }
  if (dlc === null) {
    errors.push({ row: rowNumber, field: "dlc", message: "dlc is required and must be numeric" });
  }
  if (isExtended === null) {
    errors.push({ row: rowNumber, field: "is_extended", message: "is_extended must be 0 or 1" });
  }
  if (direction === null) {
    errors.push({ row: rowNumber, field: "direction", message: "direction must be rx or tx" });
  }

  if (errors.length > 0) {
    return errors;
  }

  const frame: ReplayFrame = {
    tRelMs: tRel ?? 0,
    canId: Math.trunc(canId ?? 0),
    isExtended: isExtended ?? false,
    direction: direction ?? "rx",
    dlc: Math.trunc(dlc ?? 0),
    dataHex: normalizeHex(dataRaw),
    tEpochMs: tEpoch ?? undefined,
    channel: getCsvValue(cells, indexes, "channel") || undefined,
    source: getCsvValue(cells, indexes, "source") || undefined,
  };

  return frame;
}

function deriveTRelFromEpoch(frames: ReplayFrame[]): void {
  const firstEpoch = frames.find((f) => typeof f.tEpochMs === "number")?.tEpochMs;
  if (firstEpoch === undefined) return;

  for (const frame of frames) {
    if (frame.tRelMs === 0 && typeof frame.tEpochMs === "number") {
      frame.tRelMs = Math.max(0, frame.tEpochMs - firstEpoch);
    }
  }
}

function appendFrameCapWarning(frames: ReplayFrame[], warnings: ReplayValidationWarning[]): void {
  if (frames.length <= HARD_FRAME_CAP) {
    return;
  }
  warnings.push({
    code: "frame-cap-exceeded",
    message: `Frame count ${frames.length.toLocaleString()} exceeds hard cap of ${HARD_FRAME_CAP.toLocaleString()}. Choose a timestamp clip range to import.`,
  });
}

function parseWFRECUEpochBaseMsFromFilename(fileName?: string): number | undefined {
  if (!fileName) return undefined;

  // Expected: "YYYY-MM-DD-HH-mm-ss.csv" (time is the record start time in local time).
  const match = fileName.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return undefined;

  const [
    _full,
    yearRaw,
    monthRaw,
    dayRaw,
    hourRaw,
    minuteRaw,
    secondRaw,
  ] = match;

  const year = Number(yearRaw);
  const monthIndex = Number(monthRaw) - 1;
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);

  if (![year, monthIndex, day, hour, minute, second].every((n) => Number.isFinite(n))) return undefined;

  // Validate against Date rollover so invalid dates don't silently pass.
  const d = new Date(year, monthIndex, day, hour, minute, second);
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== monthIndex ||
    d.getDate() !== day ||
    d.getHours() !== hour ||
    d.getMinutes() !== minute ||
    d.getSeconds() !== second
  ) {
    return undefined;
  }

  return d.getTime();
}

function isLikelyWFRECUCsv(content: string): boolean {
  const firstLine = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return false;

  const cells = parseCsvLine(firstLine);
  if (cells.length !== 11 && cells.length !== 12) return false;

  const bus = (cells[1] ?? "").trim().toUpperCase();
  if (bus !== "CAN") return false;

  const tRel = Number(cells[0]);
  const canId = Number(cells[2]);
  if (!Number.isFinite(tRel) || !Number.isFinite(canId)) return false;
  if (tRel < 0 || canId < 0) return false;

  // Validate the 8 payload bytes quickly; final field may be empty if there is a trailing comma.
  const bytes = cells.slice(3, 11);
  if (bytes.length !== 8) return false;
  return bytes.every((b) => {
    const n = Number(b);
    return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

export function parseWFRECUCsv(content: string, fileName?: string): ReplayParseResult {
  const warnings: ReplayValidationWarning[] = [];
  const errors: ReplayValidationError[] = [];

  const epochBaseMs = parseWFRECUEpochBaseMsFromFilename(fileName);
  if (epochBaseMs === undefined) {
    warnings.push({
      code: "ecu-epoch-from-filename-missing",
      message: "Could not parse ECU record start time from filename; t_epoch_ms may be derived at import time.",
    });
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      frames: [],
      warnings,
      errors: [{ message: "ECU CSV must contain at least one data row." }],
    };
  }

  const frames: ReplayFrame[] = [];

  // ECU format (WFRECU):
  //   t_ms_since_ecu_start,CAN,can_id,b0,b1,b2,b3,b4,b5,b6,b7
  // Optional trailing comma may produce an extra empty field (12 columns).
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]!;
    const rowNumber = idx + 1;
    const cells = parseCsvLine(line);

    if (cells.length !== 11 && cells.length !== 12) {
      errors.push({ row: rowNumber, message: `ECU CSV expected 11 columns, got ${cells.length}.` });
      continue;
    }

    const tRelRaw = cells[0] ?? "";
    const bus = (cells[1] ?? "").trim().toUpperCase();
    const canIdRaw = cells[2] ?? "";

    const tRel = Number(tRelRaw);
    const canId = Number(canIdRaw);

    if (!Number.isFinite(tRel) || tRel < 0 || !Number.isInteger(tRel)) {
      errors.push({ row: rowNumber, field: "t_rel_ms", message: "t_ms_since_ecu_start must be a non-negative integer" });
      continue;
    }

    if (!Number.isFinite(canId) || canId < 0 || !Number.isInteger(canId)) {
      errors.push({ row: rowNumber, field: "can_id", message: "can_id must be a non-negative integer" });
      continue;
    }

    // If bus isn't CAN, don't hard-fail: just still attempt the mapping.
    if (bus !== "CAN") {
      warnings.push({
        code: "ecu-non-can-bus",
        message: `Row ${rowNumber}: expected bus "CAN", got "${bus}". Proceeding with mapping.`,
      });
    }

    const bytes = cells.slice(3, 11);
    if (bytes.length !== 8) {
      errors.push({ row: rowNumber, field: "payload", message: "Expected exactly 8 payload byte columns." });
      continue;
    }

    const byteNumbers: number[] = [];
    let byteParseFailed = false;
    for (const b of bytes) {
      const n = Number(b);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 255) {
        byteParseFailed = true;
        break;
      }
      byteNumbers.push(n);
    }

    if (byteParseFailed) {
      errors.push({ row: rowNumber, field: "payload", message: "Payload bytes must be integers in [0, 255]." });
      continue;
    }

    const dataHex = byteNumbers
      .map((n) => Math.trunc(n).toString(16).padStart(2, "0"))
      .join("");

    const frame: ReplayFrame = {
      tRelMs: tRel,
      canId: canId,
      // 11-bit vs 29-bit is determined from the numeric arbitration id.
      // WFRECU currently uses ids up to 2048, so extended frames are represented with can_id > 0x7FF.
      isExtended: canId > 0x7ff,
      direction: "rx",
      dlc: 8,
      dataHex,
      tEpochMs: epochBaseMs !== undefined ? epochBaseMs + tRel : undefined,
      source: "wfrecu",
      channel: "CAN",
    };

    const frameErrors = validateFrame(frame, rowNumber);
    if (frameErrors.length > 0) {
      errors.push(...frameErrors);
      continue;
    }

    frames.push(frame);
  }

  appendFrameCapWarning(frames, warnings);
  return { frames, warnings, errors };
}

export function validateFileSize(fileSizeBytes: number): {
  warnings: ReplayValidationWarning[];
  errors: ReplayValidationError[];
} {
  const warnings: ReplayValidationWarning[] = [];
  const errors: ReplayValidationError[] = [];

  if (fileSizeBytes > HARD_FILE_SIZE_BYTES) {
    errors.push({ message: `File is too large (${Math.round(fileSizeBytes / (1024 * 1024))} MB). Hard limit is 150 MB.` });
  } else if (fileSizeBytes > SOFT_FILE_SIZE_BYTES) {
    warnings.push({
      code: "file-size-soft-limit",
      message: `Large file (${Math.round(fileSizeBytes / (1024 * 1024))} MB). Replay import may be slower.`,
    });
  }

  return { warnings, errors };
}

export function parsePecanSessionJson(content: string): ReplayParseResult {
  const warnings: ReplayValidationWarning[] = [];
  const errors: ReplayValidationError[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      frames: [],
      warnings,
      errors: [{ message: "Invalid JSON format." }],
    };
  }

  const session = parsed as Partial<ReplaySession>;
  const versionRaw = (parsed as Record<string, unknown>).version;
  if (session.format !== "pecan-session") {
    errors.push({ field: "format", message: "format must be 'pecan-session'" });
  }
  if (versionRaw === 1) {
    errors.push({ field: "version", message: "This .pecan file was exported in v1 format (named-object frames) which is no longer supported. Re-import from the original data source and re-export as v2." });
  } else if (versionRaw !== 2) {
    errors.push({ field: "version", message: `Unsupported session version: ${versionRaw}. Only v2 is supported.` });
  }
  if (!Array.isArray(session.frames)) {
    errors.push({ field: "frames", message: "frames must be an array" });
  }

  if (errors.length > 0) {
    return { frames: [], warnings, errors };
  }

  const frames: ReplayFrame[] = [];
  const rawEpochBase = (session as Record<string, unknown>).epochBaseMs;
  const epochBase: number | undefined = Number.isFinite(rawEpochBase as number)
    ? rawEpochBase as number
    : undefined;

  (session.frames as unknown[]).forEach((row, idx) => {
    if (!Array.isArray(row) || row.length < 4) {
      errors.push({ row: idx + 1, message: "frame must be a 4-element array [tRelMs, canId, flags, dataHex]" });
      return;
    }

    const [tRelMs, canId, flags, dataHexRaw] = row as [unknown, unknown, unknown, unknown];
    const flagsNum = Number(flags);
    if (!Number.isFinite(flagsNum) || !Number.isInteger(flagsNum)) {
      errors.push({ row: idx + 1, field: "flags", message: "flags must be an integer" });
      return;
    }
    const tRelNum = Number(tRelMs);
    const dataHex = normalizeHex(String(dataHexRaw ?? ""));
    const dlc = dataHex.length / 2;

    const frame: ReplayFrame = {
      tRelMs: tRelNum,
      canId: Number(canId),
      isExtended: Boolean(flagsNum & 1),
      direction: (flagsNum & 2) ? "tx" : "rx",
      dlc,
      dataHex,
      tEpochMs: epochBase !== undefined && Number.isFinite(tRelNum) ? epochBase + tRelNum : undefined,
    };

    const frameErrors = validateFrame(frame, idx + 1);
    if (frameErrors.length > 0) {
      errors.push(...frameErrors);
      return;
    }

    frames.push(frame);
  });

  appendFrameCapWarning(frames, warnings);

  return {
    frames,
    warnings,
    errors,
    sessionMeta: {
      decode: session.decode,
      timeline: session.timeline,
      plots: session.plots,
    },
  };
}

export function parseReplayCsv(content: string): ReplayParseResult {
  const warnings: ReplayValidationWarning[] = [];
  const errors: ReplayValidationError[] = [];

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return {
      frames: [],
      warnings,
      errors: [{ message: "CSV must contain a header row and at least one data row." }],
    };
  }

  const headerIndexes = parseCsvHeader(lines[0]);
  const requiredColumns = ["can_id", "is_extended", "direction", "dlc", "data_hex"];
  for (const col of requiredColumns) {
    if (!headerIndexes.has(col)) {
      errors.push({ field: col, message: `Missing required column: ${col}` });
    }
  }
  if (!headerIndexes.has("t_rel_ms") && !headerIndexes.has("t_epoch_ms")) {
    errors.push({ field: "t_rel_ms", message: "CSV must include t_rel_ms or t_epoch_ms" });
  }

  if (errors.length > 0) {
    return { frames: [], warnings, errors };
  }

  const frames: ReplayFrame[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const rowNumber = i + 1;
    const parsedFrame = parseFrameFromCsvRow(cells, headerIndexes, rowNumber);

    if (Array.isArray(parsedFrame)) {
      errors.push(...parsedFrame);
      continue;
    }

    const frameErrors = validateFrame(parsedFrame, rowNumber);
    if (frameErrors.length > 0) {
      errors.push(...frameErrors);
      continue;
    }

    frames.push(parsedFrame);
  }

  if (frames.length > 0 && frames.every((f) => f.tRelMs === 0 && typeof f.tEpochMs === "number")) {
    deriveTRelFromEpoch(frames);
    warnings.push({
      code: "derived-t-rel",
      message: "Derived t_rel_ms from t_epoch_ms because explicit t_rel_ms was not provided.",
    });
  }

  appendFrameCapWarning(frames, warnings);
  return { frames, warnings, errors };
}

/**
 * BLF (Binary Log Format) is used by TSMaster and Vector tools.
 * This parses the CAN_MESSAGE objects (type 0x01) from BLF files.
 * BLF is little-endian. Object structure:
 *   - object_header (24 bytes): magic, header_size, header_version, object_size, object_type
 *   - object_data (object_size - header_size bytes)
 *
 * TSMaster BLF files may use zlib compression. This function handles both
 * uncompressed and zlib-compressed BLF files.
 */
export function parseTSMasterBlf(buffer: ArrayBuffer, _fileName?: string): ReplayParseResult {
  const warnings: ReplayValidationWarning[] = [];
  const errors: ReplayValidationError[] = [];
  const frames: ReplayFrame[] = [];

  const uint8 = new Uint8Array(buffer);
  const dataView = new DataView(buffer);
  const totalBytes = buffer.byteLength;

  if (totalBytes < 28) {
    return {
      frames: [],
      warnings,
      errors: [{ message: "BLF file too small to be valid." }],
    };
  }

  const fileTag = String.fromCharCode(uint8[0], uint8[1], uint8[2], uint8[3]);

  if (fileTag === "LOGG") {
    // Standard Vector BLF format: sequential LOBJ containers after the LOGG file header.
    // Each LOG_COMPRESSED container (type 0x0a) holds a zlib stream of LOBJ CAN_MESSAGE
    // (type 0x01) records, each exactly 48 bytes:
    //   bytes 0-3:   "LOBJ" signature
    //   bytes 4-5:   header_size (32)
    //   bytes 6-7:   header_version (1)
    //   bytes 8-11:  object_size (48)
    //   bytes 12-15: object_type (1 = CAN_MESSAGE)
    //   bytes 16-23: reserved / index
    //   bytes 24-31: timestamp (uint64 LE, 100 ns ticks)
    //   bytes 32-33: channel (uint16 LE)
    //   byte 34:     flags  (bit 0x10 = TX direction)
    //   byte 35:     DLC
    //   bytes 36-39: CAN arbitration ID (uint32 LE)
    //   bytes 40-47: CAN data (8 bytes)
    //
    // Blocks may have up to 3 bytes of padding between them; scan 1 byte at a time when
    // not on an LOBJ/LOGG boundary.
    let offset = 0;
    while (offset + 4 <= totalBytes) {
      const tag = String.fromCharCode(uint8[offset], uint8[offset + 1], uint8[offset + 2], uint8[offset + 3]);

      if (tag === "LOGG") {
        const headerSize = dataView.getUint32(offset + 4, true);
        offset += Math.max(headerSize, 4);
        continue;
      }

      if (tag !== "LOBJ") {
        offset += 1;
        continue;
      }

      const objSize = dataView.getUint32(offset + 8, true);
      const objType = dataView.getUint32(offset + 12, true);

      if (objSize < 16 || offset + objSize > totalBytes) {
        break;
      }

      if (objType === 0x0a) {
        // LOG_COMPRESSED: 16-byte LOBJ header + 16-byte metadata + zlib stream
        const zlibOffset = offset + 32;
        if (zlibOffset < offset + objSize && uint8[zlibOffset] === 0x78) {
          try {
            const zlibData = uint8.slice(zlibOffset, offset + objSize);
            const decompressed = pako.inflate(zlibData);
            const decompView = new DataView(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
            const decompLen = decompressed.length;

            for (let i = 0; i + 48 <= decompLen; i += 48) {
              if (
                decompressed[i] !== 0x4c ||
                decompressed[i + 1] !== 0x4f ||
                decompressed[i + 2] !== 0x42 ||
                decompressed[i + 3] !== 0x4a ||
                decompView.getUint32(i + 12, true) !== 0x01
              ) continue;

              const tsLo = decompView.getUint32(i + 24, true);
              const tsHi = decompView.getUint32(i + 28, true);
              const tRelMs = Number(BigInt(tsLo) + (BigInt(tsHi) << 32n)) / 1_000_000;

              const flags = decompressed[i + 34];
              const direction: ReplayDirection = (flags & 0x10) ? "tx" : "rx";
              const dlc = Math.min(decompressed[i + 35], 8);
              const canId = decompView.getUint32(i + 36, true);
              const isExtended = canId > 0x7ff;

              let dataHex = "";
              for (let j = 0; j < dlc; j++) {
                dataHex += decompressed[i + 40 + j].toString(16).padStart(2, "0");
              }

              const frame: ReplayFrame = {
                tRelMs,
                canId: canId & (isExtended ? 0x1fffffff : 0x7ff),
                isExtended,
                direction,
                dlc,
                dataHex,
                source: "tsmaster",
                channel: "CAN",
              };

              const frameErrors = validateFrame(frame, frames.length + 1);
              if (frameErrors.length === 0) {
                frames.push(frame);
              }
            }
          } catch (e) {
            warnings.push({
              code: "blf-block-failed",
              message: `Failed to decompress BLF block at offset ${offset}: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        }
      }

      offset += objSize;
    }
  } else {
    // Non-LOGG BLF: try zlib decompression at offset 176 then parse as LOBJ or standard BLF.
    let dataToParse: Uint8Array = uint8;
    if (totalBytes > 176 && uint8[176] === 0x78 && uint8[177] === 0xda) {
      try {
        const compressed = uint8.slice(176);
        const decompressed = pako.inflate(compressed);
        dataToParse = new Uint8Array(decompressed);
        warnings.push({
          code: "blf-decompressed",
          message: "TSMaster BLF file was zlib-compressed. Decompressed successfully.",
        });
      } catch (e) {
        errors.push({
          message: `Failed to decompress TSMaster BLF file: ${e instanceof Error ? e.message : String(e)}`,
        });
        return { frames: [], warnings, errors };
      }
    }

    const parseView = new DataView(dataToParse.buffer, dataToParse.byteOffset, dataToParse.byteLength);
    const parseBytes = dataToParse.length;

    const sigAt0 = String.fromCharCode(
      dataToParse[0],
      dataToParse[1],
      dataToParse[2],
      dataToParse[3],
    );

    if (sigAt0 === "LOBJ") {
      // Decompressed LOBJ 48-byte fixed records
      const recordSize = 48;
      const numRecords = Math.floor(parseBytes / recordSize);

      for (let rec = 0; rec < numRecords; rec++) {
        const base = rec * recordSize;

        if (
          dataToParse[base] !== 0x4c ||
          dataToParse[base + 1] !== 0x4f ||
          dataToParse[base + 2] !== 0x42 ||
          dataToParse[base + 3] !== 0x4a
        ) {
          continue;
        }

        const tsLo = parseView.getUint32(base + 24, true);
        const tsHi = parseView.getUint32(base + 28, true);
        const tRelMs = Number(BigInt(tsLo) + (BigInt(tsHi) << 32n)) / 1_000_000;

        const flags = dataToParse[base + 34];
        const direction: ReplayDirection = (flags & 0x10) ? "tx" : "rx";
        const dlc = Math.min(dataToParse[base + 35], 8);
        const canId = parseView.getUint32(base + 36, true);
        const isExtended = canId > 0x7ff;

        let dataHex = "";
        for (let i = 0; i < dlc; i++) {
          dataHex += dataToParse[base + 40 + i].toString(16).padStart(2, "0");
        }

        const frame: ReplayFrame = {
          tRelMs,
          canId: canId & (isExtended ? 0x1fffffff : 0x7ff),
          isExtended,
          direction,
          dlc,
          dataHex,
          source: "tsmaster",
          channel: "CAN",
        };

        const frameErrors = validateFrame(frame, frames.length + 1);
        if (frameErrors.length === 0) {
          frames.push(frame);
        }
      }
    } else {
      // Standard BLF format: variable-size objects
      const signature = String.fromCharCode(
        dataView.getUint8(4),
        dataView.getUint8(5),
        dataView.getUint8(6),
        dataView.getUint8(7),
      );

    if (
      signature !== "BLF\x0a" &&
      signature !== "BLF\x0d" &&
      signature !== "BLF " &&
      sigAt0 !== "LOGG"
    ) {
      warnings.push({
        code: "blf-unexpected-signature",
        message: `File does not have expected BLF signature. Proceeding with generic parse.`,
      });
    }

    // Scan for CAN_MESSAGE objects starting from offset 24
    // Object header format:
    // offset +0: object_size (4 bytes)
    // offset +4: object_header_size (4 bytes)
    // offset +8: object_version (2 bytes)
    // offset +10: object_type (2 bytes)
    // offset +12: object_data_size (4 bytes)

    for (let offset = 24; offset + 24 <= parseBytes; offset += 4) {
      const objectSize = parseView.getUint32(offset, true);
      const objectHeaderSize = parseView.getUint32(offset + 4, true);
      const objectType = parseView.getUint16(offset + 10, true);

      // Validate object
      if (objectSize < 24 || objectSize > parseBytes - offset) {
        break;
      }

      // Skip if header size is unreasonably large
      if (objectHeaderSize > 1000 || objectHeaderSize < 16) {
        continue;
      }

      // CAN_MESSAGE object type = 0x01, CANFD_MESSAGE = 0x32
      if (objectType === 0x01) {
        // Parse CAN message data
        const headerStart = offset + objectHeaderSize;
        const canDataOffset = headerStart + 8;

        if (canDataOffset + 8 <= offset + objectSize) {
          const arbId = parseView.getUint32(canDataOffset, true);
          const flags = parseView.getUint8(canDataOffset + 5);
          const isExtended = Boolean(flags & 0x01);
          const directionBit = parseView.getUint8(canDataOffset + 4);
          const direction: ReplayDirection = directionBit & 0x80 ? "rx" : "tx";
          const dlc = Math.min(parseView.getUint8(canDataOffset + 6), 8);
          const dataStart = canDataOffset + 8;
          let dataHex = "";
          for (let i = 0; i < dlc; i++) {
            dataHex += parseView.getUint8(dataStart + i).toString(16).padStart(2, "0");
          }

          let tRelMs = 0;
          if (headerStart + 8 <= offset + objectSize) {
            const timestampNs = parseView.getBigUint64(headerStart, true);
            tRelMs = Number(timestampNs) / 1_000_000;
          }

          const frame: ReplayFrame = {
            tRelMs,
            canId: arbId & (isExtended ? 0x1fffffff : 0x7ff),
            isExtended,
            direction,
            dlc,
            dataHex,
            source: "tsmaster",
            channel: "CAN",
          };

          const frameErrors = validateFrame(frame, frames.length + 1);
          if (frameErrors.length === 0) {
            frames.push(frame);
          }
        }
      } else if (objectType === 0x32) {
        // CANFD_MESSAGE
        const headerStart = offset + objectHeaderSize;
        const canFdDataOffset = headerStart + 12;

        if (canFdDataOffset + 8 <= offset + objectSize) {
          const arbId = parseView.getUint32(canFdDataOffset, true);
          const flags = parseView.getUint8(canFdDataOffset + 5);
          const isExtended = Boolean(flags & 0x01);
          const directionBit = parseView.getUint8(canFdDataOffset + 4);
          const direction: ReplayDirection = directionBit & 0x80 ? "rx" : "tx";
          const rawDlc = parseView.getUint8(canFdDataOffset + 6);
          let dlc = rawDlc;
          if (rawDlc > 15) dlc = [12, 16, 20, 24, 32, 48, 64][rawDlc - 16] ?? 64;

          const dataStart = canFdDataOffset + 8;
          let dataHex = "";
          for (let i = 0; i < Math.min(dlc, 64); i++) {
            dataHex += parseView.getUint8(dataStart + i).toString(16).padStart(2, "0");
          }

          let tRelMs = 0;
          if (headerStart + 8 <= offset + objectSize) {
            const timestampNs = parseView.getBigUint64(headerStart, true);
            tRelMs = Number(timestampNs) / 1_000_000;
          }

          const frame: ReplayFrame = {
            tRelMs,
            canId: arbId & (isExtended ? 0x1fffffff : 0x7ff),
            isExtended,
            direction,
            dlc,
            dataHex,
            source: "tsmaster",
            channel: "CANFD",
          };

          const frameErrors = validateFrame(frame, frames.length + 1);
          if (frameErrors.length === 0) {
            frames.push(frame);
          }
        }
      }

      // Move to next object
      if (objectSize < 24) break;
      offset = offset + objectSize - 24;
    }
  }
  }

  // Sort frames by tRelMs to ensure chronological order
  frames.sort((a, b) => a.tRelMs - b.tRelMs);

  // Normalize tRelMs to start from 0
  if (frames.length > 0 && frames[0].tRelMs > 0) {
    const baseT = frames[0].tRelMs;
    for (const frame of frames) {
      frame.tRelMs = Math.max(0, frame.tRelMs - baseT);
      if (frame.tEpochMs !== undefined) {
        frame.tEpochMs = frame.tEpochMs - baseT;
      }
    }
  }

  appendFrameCapWarning(frames, warnings);
  return { frames, warnings, errors };
}

export async function parseReplayFile(file: File): Promise<ReplayParseResult> {
  const sizeValidation = validateFileSize(file.size);
  if (sizeValidation.errors.length > 0) {
    return { frames: [], warnings: sizeValidation.warnings, errors: sizeValidation.errors };
  }

  const lower = file.name.toLowerCase();

  // Handle binary formats
  if (lower.endsWith(".blf")) {
    const buffer = await file.arrayBuffer();
    const result = parseTSMasterBlf(buffer, file.name);
    return {
      ...result,
      warnings: [...sizeValidation.warnings, ...result.warnings],
    };
  }

  const content = await file.text();

  const parsed = lower.endsWith(".pecan") || lower.endsWith(".json")
    ? parsePecanSessionJson(content)
    : isLikelyWFRECUCsv(content)
      ? parseWFRECUCsv(content, file.name)
      : parseReplayCsv(content);

  return {
    ...parsed,
    warnings: [...sizeValidation.warnings, ...parsed.warnings],
  };
}
