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
  database: string;
  color?: string;
}
