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
  if (session.format !== "pecan-session") {
    errors.push({ field: "format", message: "format must be 'pecan-session'" });
  }
  if (session.version !== 2) {
    errors.push({ field: "version", message: "version must be 2" });
  }
  if (!Array.isArray(session.frames)) {
    errors.push({ field: "frames", message: "frames must be an array" });
  }

  if (errors.length > 0) {
    return { frames: [], warnings, errors };
  }

  const frames: ReplayFrame[] = [];
  const epochBase: number | undefined = typeof (session as Record<string, unknown>).epochBaseMs === "number"
    ? (session as Record<string, unknown>).epochBaseMs as number
    : undefined;

  (session.frames as unknown[]).forEach((row, idx) => {
    if (!Array.isArray(row) || row.length < 4) {
      errors.push({ row: idx + 1, message: "frame must be a 4-element array [tRelMs, canId, flags, dataHex]" });
      return;
    }

    const [tRelMs, canId, flags, dataHexRaw] = row as [unknown, unknown, unknown, unknown];
    const dataHex = normalizeHex(String(dataHexRaw ?? ""));
    const dlc = dataHex.length / 2;

    const frame: ReplayFrame = {
      tRelMs: Number(tRelMs),
      canId: Number(canId),
      isExtended: Boolean(Number(flags) & 1),
      direction: (Number(flags) & 2) ? "tx" : "rx",
      dlc,
      dataHex,
      tEpochMs: epochBase !== undefined ? epochBase + Number(tRelMs) : undefined,
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

export async function parseReplayFile(file: File): Promise<ReplayParseResult> {
  const sizeValidation = validateFileSize(file.size);
  if (sizeValidation.errors.length > 0) {
    return { frames: [], warnings: sizeValidation.warnings, errors: sizeValidation.errors };
  }

  const content = await file.text();
  const lower = file.name.toLowerCase();

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
