import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { WcarsAlert, WcarsConfig, WcarsFrame } from "../lib/wcars/types";
import { loadAlerts, saveAlerts, loadLog, saveLog, loadConfig, saveConfig } from "../lib/wcars/storage";
import { playChime } from "../lib/wcars/audio";

const LOG_CAP = 500;

interface WcarsContextValue {
  alerts: WcarsAlert[];
  log: WcarsAlert[];
  config: WcarsConfig;
  setConfig: (cfg: WcarsConfig) => void;
  clear: (id: string) => void;
  clearAll: () => void;
  sendTestAlert: () => void;
}

const WcarsContext = createContext<WcarsContextValue | undefined>(undefined);

const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? "ws://localhost:9080";

function mergeConfig(prev: WcarsConfig, next: WcarsConfig): WcarsConfig {
  return {
    thresholds: { ...prev.thresholds, ...next.thresholds },
    audio: { ...prev.audio, ...next.audio },
  };
}

export const WcarsProvider = ({ children }: { children: ReactNode }) => {
  const [alerts, setAlerts] = useState<WcarsAlert[]>(() => loadAlerts());
  const [log, setLog] = useState<WcarsAlert[]>(() => loadLog());
  const [config, setConfigState] = useState<WcarsConfig>(() => loadConfig());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  useEffect(() => { saveAlerts(alerts); }, [alerts]);
  useEffect(() => { saveLog(log); }, [log]);
  useEffect(() => { saveConfig(config); }, [config]);

  const ingest = useCallback((incoming: WcarsAlert[]) => {
    if (incoming.length === 0) return;
    setLog((prev) => {
      const next = [...incoming.slice().reverse(), ...prev].slice(0, LOG_CAP);
      return next;
    });
    setAlerts((prev) => {
      const liveOnes = incoming.filter((a) => !a.replay);
      const known = new Set(prev.map((a) => a.id));
      const merged = [...prev, ...liveOnes.filter((a) => !known.has(a.id))];
      merged.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.ts - a.ts);
      return merged;
    });
    for (const a of incoming) {
      if (!a.replay) playChime(a.severity, configRef.current.audio);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const connect = () => {
      if (!alive) return;
      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;
        ws.onopen = () => {
          try { ws.send(JSON.stringify({ type: "wcars_config", config: configRef.current })); } catch { /* ignore */ }
        };
        ws.onmessage = (ev) => {
          let frame: WcarsFrame;
          try { frame = JSON.parse(ev.data) as WcarsFrame; } catch { return; }
          if (frame.type === "wcars_alert") ingest([frame.alert]);
          else if (frame.type === "wcars_backlog") ingest(frame.alerts);
          else if (frame.type === "wcars_config_ack") {
            setConfigState((prev) => mergeConfig(prev, frame.config));
          }
        };
        ws.onclose = () => {
          wsRef.current = null;
          if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
          reconnectRef.current = window.setTimeout(connect, 2000);
        };
        ws.onerror = () => { ws.close(); };
      } catch {
        reconnectRef.current = window.setTimeout(connect, 2000);
      }
    };
    connect();
    return () => {
      alive = false;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [ingest]);

  const setConfig = useCallback((next: WcarsConfig) => {
    setConfigState((prev) => {
      const merged = mergeConfig(prev, next);
      try { wsRef.current?.send(JSON.stringify({ type: "wcars_config", config: merged })); } catch { /* ignore */ }
      return merged;
    });
  }, []);

  const clear = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setAlerts([]);
  }, []);

  const sendTestAlert = useCallback(() => {
    const a: WcarsAlert = {
      id: `test-${Date.now()}`,
      rule: "TEST",
      severity: "WARNING",
      title: "WCARS TEST",
      detail: "manual test alert",
      value: null,
      ts: Date.now(),
      replay: false,
    };
    ingest([a]);
  }, [ingest]);

  const value = useMemo<WcarsContextValue>(() => ({ alerts, log, config, setConfig, clear, clearAll, sendTestAlert }),
    [alerts, log, config, setConfig, clear, clearAll, sendTestAlert]);

  return <WcarsContext.Provider value={value}>{children}</WcarsContext.Provider>;
};

export function useWcars(): WcarsContextValue {
  const ctx = useContext(WcarsContext);
  if (!ctx) throw new Error("useWcars must be used inside WcarsProvider");
  return ctx;
}

function severityRank(s: WcarsAlert["severity"]): number {
  return s === "WARNING" ? 3 : s === "CAUTION" ? 2 : 1;
}