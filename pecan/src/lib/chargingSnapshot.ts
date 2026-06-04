/**
 * Charging snapshot builder
 *
 * Pure functions that read the current accumulator state and produce the JSON
 * snapshot POSTed to the slackbot charging dashboard. Mirrors the data shown on
 * the Accumulator page (MasterAlertPanel pack stats + per-module ModuleStats).
 *
 * Kept dependency-injectable (`SignalReader`) so it is unit-testable without the
 * live DataStore.
 */

import {
  MODULE_IDS,
  CELLS_PER_MODULE,
  THERMISTORS_PER_MODULE,
  ALERT_THRESHOLDS,
  getCellSignalInfo,
  getThermistorSignalInfo,
  type ModuleId,
} from '../components/accumulator/AccumulatorTypes';

/** Minimal surface of DataStore needed here — easy to mock in tests. */
export interface SignalReader {
  getSignal(msgID: string, signalName: string): { sensorReading: number } | undefined;
}

const BMS_STATUS_ID = '512';
const CHARGING_THRESHOLD = -0.5; // A — negative current = charging (per BatteryStatus.tsx)
const DISCHARGING_THRESHOLD = 0.5; // A

// Telemetry reality (wfr26 audit): PackCurrent reads a dead -3276 sentinel, BMS SOC
// reads constant 0, and there is no PackVoltage signal. We sentinel-guard those so a
// dead value is sent as null (the slackbot's soc_model derives SOC/phase from cell
// voltages instead), and we derive pack voltage from the series-cell sum.
const PLAUSIBLE_CURRENT_A = 1000; // |PackCurrent| beyond this ⇒ treat as invalid/dead

export type AlertChip = 'ok' | 'warn' | 'crit';
export type ChargeState = 'charging' | 'discharging' | 'standby';

export interface ModuleSnapshot {
  id: ModuleId;
  cells: (number | null)[];
  avg: number | null;
  min: number | null;
  max: number | null;
  delta_mv: number | null;
  tmax: number | null;
}

export interface ChargingSnapshot {
  session: string;
  state: ChargeState;
  elapsed_s: number;
  soc: number | null;
  pack_v: number | null;
  current_a: number | null;
  avg_v: number | null;
  delta_mv: number | null;
  min_cell: { v: number; label: string } | null;
  max_cell: { v: number; label: string } | null;
  max_temp: { c: number; label: string } | null;
  min_temp: { c: number | null };
  alerts: { voltdelta: AlertChip; temp: AlertChip; bal: AlertChip; low: AlertChip };
  modules: ModuleSnapshot[];
  source: string;
  env: string;
}

function read(reader: SignalReader, msgID: string, name: string): number | null {
  const s = reader.getSignal(msgID, name);
  return s ? s.sensorReading : null;
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export interface BuildOptions {
  session: string;
  startMs: number;
  now?: number;
  source?: string;
  env?: string;
}

export function buildChargingSnapshot(reader: SignalReader, opts: BuildOptions): ChargingSnapshot {
  const now = opts.now ?? Date.now();

  const rawCurrent = read(reader, BMS_STATUS_ID, 'PackCurrent');
  const current = rawCurrent !== null && Math.abs(rawCurrent) <= PLAUSIBLE_CURRENT_A ? rawCurrent : null;
  const rawSoc = read(reader, BMS_STATUS_ID, 'StateOfCharge') ?? read(reader, BMS_STATUS_ID, 'SOC');
  const soc = rawSoc !== null && rawSoc > 0 && rawSoc <= 100 ? rawSoc : null;

  // Pack-wide extremes (with cell/thermistor labels), per-module aggregates.
  let minCell: { v: number; label: string } | null = null;
  let maxCell: { v: number; label: string } | null = null;
  let maxTemp: { c: number; label: string } | null = null;
  let minTemp: number | null = null;
  const allCellValues: number[] = [];
  const moduleAvgs: number[] = [];

  const modules: ModuleSnapshot[] = MODULE_IDS.map((id) => {
    const cells: (number | null)[] = [];
    const cellValues: number[] = [];
    for (let i = 1; i <= CELLS_PER_MODULE; i++) {
      const { msgId, signalName } = getCellSignalInfo(id, i);
      const v = read(reader, msgId, signalName);
      cells.push(v);
      if (v !== null) {
        cellValues.push(v);
        allCellValues.push(v);
        const label = `${id}·C${i}`;
        if (minCell === null || v < minCell.v) minCell = { v, label };
        if (maxCell === null || v > maxCell.v) maxCell = { v, label };
      }
    }

    let tmax: number | null = null;
    for (let i = 1; i <= THERMISTORS_PER_MODULE; i++) {
      const { msgId, signalName } = getThermistorSignalInfo(id, i);
      const t = read(reader, msgId, signalName);
      if (t !== null) {
        const label = `${id}·T${i}`;
        if (tmax === null || t > tmax) tmax = t;
        if (maxTemp === null || t > maxTemp.c) maxTemp = { c: t, label };
        if (minTemp === null || t < minTemp) minTemp = t;
      }
    }

    const mAvg = avg(cellValues);
    if (mAvg !== null) moduleAvgs.push(mAvg);
    const mMin = cellValues.length ? Math.min(...cellValues) : null;
    const mMax = cellValues.length ? Math.max(...cellValues) : null;
    return {
      id,
      cells,
      avg: mAvg,
      min: mMin,
      max: mMax,
      delta_mv: mMin !== null && mMax !== null ? Math.round((mMax - mMin) * 1000) : null,
      tmax,
    };
  });

  // PackVoltage signal is absent in telemetry → derive the stack voltage as the sum
  // of the (series) cell voltages. Prefer a real PackVoltage signal if one ever appears.
  const rawPackV = read(reader, BMS_STATUS_ID, 'PackVoltage');
  const packV =
    rawPackV !== null && rawPackV > 0
      ? rawPackV
      : allCellValues.length
        ? allCellValues.reduce((a, b) => a + b, 0)
        : null;

  const packDelta =
    minCell !== null && maxCell !== null ? (maxCell as { v: number }).v - (minCell as { v: number }).v : null;
  const imbalance =
    moduleAvgs.length > 1 ? Math.max(...moduleAvgs) - Math.min(...moduleAvgs) : null;

  let state: ChargeState = 'standby';
  if (current !== null) {
    if (current < CHARGING_THRESHOLD) state = 'charging';
    else if (current > DISCHARGING_THRESHOLD) state = 'discharging';
  }

  return {
    session: opts.session,
    state,
    elapsed_s: Math.max(0, Math.round((now - opts.startMs) / 1000)),
    soc,
    pack_v: packV,
    current_a: current,
    avg_v: avg(allCellValues),
    delta_mv: packDelta !== null ? Math.round(packDelta * 1000) : null,
    min_cell: minCell,
    max_cell: maxCell,
    max_temp: maxTemp,
    min_temp: { c: minTemp },
    alerts: {
      voltdelta: chipHigh(packDelta, ALERT_THRESHOLDS.voltageDiff.warning, ALERT_THRESHOLDS.voltageDiff.critical),
      temp: chipHigh(maxTemp ? (maxTemp as { c: number }).c : null, ALERT_THRESHOLDS.overTemp.warning, ALERT_THRESHOLDS.overTemp.critical),
      bal: chipHigh(imbalance, ALERT_THRESHOLDS.moduleImbalance.warning, ALERT_THRESHOLDS.moduleImbalance.critical),
      low: chipLow(minCell ? (minCell as { v: number }).v : null, ALERT_THRESHOLDS.lowVoltage.warning, ALERT_THRESHOLDS.lowVoltage.critical),
    },
    modules,
    source: opts.source ?? 'kvaser-bridge',
    env: opts.env ?? 'pecan-dev',
  };
}

/** Higher value = worse (delta, temp, imbalance). */
export function chipHigh(value: number | null, warn: number, crit: number): AlertChip {
  if (value === null) return 'ok';
  if (value >= crit) return 'crit';
  if (value >= warn) return 'warn';
  return 'ok';
}

/** Lower value = worse (min cell voltage). */
export function chipLow(value: number | null, warn: number, crit: number): AlertChip {
  if (value === null) return 'ok';
  if (value <= crit) return 'crit';
  if (value <= warn) return 'warn';
  return 'ok';
}
