import {
  RunRecord,
  RunsResponse,
  ScannerStatus,
  Season,
  SensorDataResponse,
  SensorsResponse
} from "./types";

const RAW_API_BASE = import.meta.env.VITE_API_BASE_URL?.trim() ?? "";
const SANITIZED_API_BASE = RAW_API_BASE.replace(/\/$/, "");
const LOCAL_BASE_PATTERN = /:\/\/(localhost|127\.0\.0\.1|\[?::1]?)/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const runningOnLocalhost = typeof window !== "undefined" && LOCAL_HOSTS.has(window.location.hostname);
const preferRelativeBase =
  SANITIZED_API_BASE === "" || (!runningOnLocalhost && LOCAL_BASE_PATTERN.test(SANITIZED_API_BASE));
const API_BASE = preferRelativeBase ? "" : SANITIZED_API_BASE;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    },
    ...init
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed (${response.status})`);
  }
  if (response.status === 204) {
    return {} as T;
  }
  return (await response.json()) as T;
}

export function fetchSeasons(): Promise<Season[]> {
  return request("/api/seasons");
}

export function fetchRuns(season?: string): Promise<RunsResponse> {
  const query = season ? `?season=${encodeURIComponent(season)}` : "";
  return request(`/api/runs${query}`);
}

export function fetchSensors(season?: string): Promise<SensorsResponse> {
  const query = season ? `?season=${encodeURIComponent(season)}` : "";
  return request(`/api/sensors${query}`);
}

export function fetchScannerStatus(): Promise<ScannerStatus> {
  return request("/api/scanner-status");
}

export function triggerScan(season?: string): Promise<{ status: string }> {
  const query = season ? `?season=${encodeURIComponent(season)}` : "";
  return request(`/api/scan${query}`, { method: "POST" });
}

export function updateNote(key: string, note: string, season?: string): Promise<RunRecord> {
  const query = season ? `?season=${encodeURIComponent(season)}` : "";
  return request(`/api/runs/${encodeURIComponent(key)}/note${query}`, {
    method: "POST",
    body: JSON.stringify({ note })
  });
}

export interface DataQueryPayload {
  signal: string;
  start: string;
  end: string;
  limit?: number;
  no_limit?: boolean;
}

export function querySensorData(payload: DataQueryPayload, season?: string): Promise<SensorDataResponse> {
  const query = season ? `?season=${encodeURIComponent(season)}` : "";
  return request(`/api/query${query}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
