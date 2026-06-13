export type Severity = "WARNING" | "CAUTION" | "MEMO";

export interface WcarsAlert {
  id: string;
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  value: number | null;
  ts: number;
  replay: boolean;
}

export interface WcarsThresholds {
  torch_cell_temp_c: number;
  torch_cell_imbalance_v: number;
  rearm_seconds: number;
}

export interface WcarsAudioConfig {
  enabled: boolean;
  volume: number;
}

export interface WcarsConfig {
  thresholds: WcarsThresholds;
  audio: WcarsAudioConfig;
}

export const DEFAULT_WCARS_CONFIG: WcarsConfig = {
  thresholds: {
    torch_cell_temp_c: 55.0,
    torch_cell_imbalance_v: 0.10,
    rearm_seconds: 10,
  },
  audio: { enabled: true, volume: 0.5 },
};

export type WcarsFrame =
  | { type: "wcars_alert"; alert: WcarsAlert }
  | { type: "wcars_backlog"; alerts: WcarsAlert[] }
  | { type: "wcars_config_ack"; config: WcarsConfig };
