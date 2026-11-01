export interface RunRecord {
  key: string;
  start_utc: string;
  end_utc: string;
  start_local: string;
  end_local: string;
  bins: number;
  row_count?: number;
  note?: string;
  note_updated_at?: string | null;
  timezone?: string;
}

export interface RunsResponse {
  updated_at: string | null;
  runs: RunRecord[];
}

export interface SensorsResponse {
  updated_at: string | null;
  sensors: string[];
}

export interface SensorDataPoint {
  time: string;
  value: number;
}

export interface SensorDataResponse {
  signal: string;
  start: string;
  end: string;
  row_count: number;
  limit: number | null;
  points: SensorDataPoint[];
  sql: string;
}

export interface ScannerStatus {
  scanning: boolean;
  started_at: string | null;
  finished_at: string | null;
  source: string | null;
  last_result?: "success" | "error" | null;
  error?: string | null;
  updated_at: string | null;
}

export interface Season {
  name: string;
  year: number;
  table: string;
  color?: string;
}

export interface RawSignalSeries {
  mode: "raw";
  resolution_ms: null;
  point_count: number;
  t: number[];
  v: number[];
}

export interface EnvelopeSignalSeries {
  mode: "envelope";
  resolution_ms: number;
  point_count: number;
  t: number[];
  min: number[];
  max: number[];
  avg: number[];
}

export type SignalSeries = RawSignalSeries | EnvelopeSignalSeries;

export interface SeriesRequest {
  season: string;
  signals: string[];
  start: string;
  end: string;
  target_points: number;
}

export interface SeriesResponse {
  season: string;
  start: string;
  end: string;
  series: Record<string, SignalSeries>;
}

export interface MessageGroup {
  name: string;
  subsystem: string;
  can_id: number;
  can_id_hex: string;
  signals: string[];
}

export interface SensorsGroupedResponse {
  updated_at: string | null;
  dbc_source: string;
  messages: MessageGroup[];
  ungrouped: string[];
}

export interface StateSegment {
  start_ms: number;
  end_ms: number;
  value: number;
  label: string;
}

export interface StateLane {
  id: string;
  signal: string;
  label: string;
  segments: StateSegment[];
}

export interface FaultEntry {
  name: string;
  source: "post" | "run";
  segments: { start_ms: number; end_ms: number }[];
}

export interface StatesRequest {
  season: string;
  start: string;
  end: string;
}

export interface StatesResponse {
  season: string;
  start: string;
  end: string;
  lanes: StateLane[];
  faults: FaultEntry[];
}

export interface SavedConfigPlot {
  signals: string[];
  rightAxis: string[];
}

export interface SavedConfig {
  id: string;
  name: string;
  note: string;
  author: string;
  season: string;
  start: string;
  end: string;
  plots: SavedConfigPlot[];
  colors?: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface CreateConfigPayload {
  name: string;
  note: string;
  author: string;
  season: string;
  start: string;
  end: string;
  plots: SavedConfigPlot[];
  colors?: Record<string, string>;
}
