export type ReplayDirection = "rx" | "tx";

export interface ReplayFrame {
  tRelMs: number;
  canId: number;
  isExtended: boolean;
  direction: ReplayDirection;
  dlc: number;
  dataHex: string;
  tEpochMs?: number;
  tLocalTime?: string;
  channel?: string;
  source?: string;
}

export interface ReplayDecodeEmbeddedDBC {
  format: "dbc";
  encoding: "utf-8";
  content: string;
}

export interface ReplayDecodeMetadata {
  dbcName?: string;
  dbcHashSha256?: string;
  importFormat?: string;
  dbcEmbedded?: ReplayDecodeEmbeddedDBC;
}

export interface ReplayCheckpoint {
  id?: string;
  label: string;
  tRelMs: number;
}

export interface ReplayTimelineMetadata {
  checkpoints?: ReplayCheckpoint[];
  windowMs?: number;
  lastCursorMs?: number;
}

export interface ReplayPlotSeries {
  msgId: string;
  signalName: string;
  yAxis?: "left" | "right";
}

export interface ReplayPlotLayout {
  id: string;
  title?: string;
  series: ReplayPlotSeries[];
}

export interface ReplayPlotsMetadata {
  layouts?: ReplayPlotLayout[];
}

export interface ReplaySession {
  format: "pecan-session";
  version: 1;
  frames: ReplayFrame[];
  decode?: ReplayDecodeMetadata;
  timeline?: ReplayTimelineMetadata;
  plots?: ReplayPlotsMetadata;
}

export interface ReplayValidationWarning {
  code: string;
  message: string;
}

export interface ReplayValidationError {
  row?: number;
  field?: string;
  message: string;
}

export interface ReplayParseResult {
  frames: ReplayFrame[];
  warnings: ReplayValidationWarning[];
  errors: ReplayValidationError[];
  sessionMeta?: {
    decode?: ReplayDecodeMetadata;
    timeline?: ReplayTimelineMetadata;
    plots?: ReplayPlotsMetadata;
  };
}
