import type { WcarsAlert, WcarsConfig } from "./types";
import { DEFAULT_WCARS_CONFIG } from "./types";

const ALERT_KEY = "wcars:alerts";
const LOG_KEY = "wcars:log";
const CONFIG_KEY = "wcars:config";

function safe<T>(op: () => T, fallback: T): T {
  try {
    return op();
  } catch {
    return fallback;
  }
}

export function loadAlerts(): WcarsAlert[] {
  return safe(() => {
    const raw = sessionStorage.getItem(ALERT_KEY);
    return raw ? (JSON.parse(raw) as WcarsAlert[]) : [];
  }, []);
}

export function saveAlerts(alerts: WcarsAlert[]): void {
  safe(() => sessionStorage.setItem(ALERT_KEY, JSON.stringify(alerts)), undefined);
}

export function loadLog(): WcarsAlert[] {
  return safe(() => {
    const raw = sessionStorage.getItem(LOG_KEY);
    return raw ? (JSON.parse(raw) as WcarsAlert[]) : [];
  }, []);
}

export function saveLog(log: WcarsAlert[]): void {
  safe(() => sessionStorage.setItem(LOG_KEY, JSON.stringify(log)), undefined);
}

export function loadConfig(): WcarsConfig {
  return safe(() => {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? { ...DEFAULT_WCARS_CONFIG, ...JSON.parse(raw) } : DEFAULT_WCARS_CONFIG;
  }, DEFAULT_WCARS_CONFIG);
}

export function saveConfig(cfg: WcarsConfig): void {
  safe(() => localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)), undefined);
}
