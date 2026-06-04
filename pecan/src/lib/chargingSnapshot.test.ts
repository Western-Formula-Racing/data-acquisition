import { describe, it, expect } from 'vitest';
import {
  buildChargingSnapshot,
  chipHigh,
  chipLow,
  type SignalReader,
} from './chargingSnapshot';
import {
  MODULE_IDS,
  CELLS_PER_MODULE,
  getCellSignalInfo,
  getThermistorSignalInfo,
  type ModuleId,
} from '../components/accumulator/AccumulatorTypes';

interface ReaderOpts {
  current?: number;
  soc?: number;
  packV?: number;
  cells?: Partial<Record<ModuleId, number[]>>;
  temps?: Partial<Record<ModuleId, number[]>>;
}

function makeReader(opts: ReaderOpts): SignalReader {
  const map = new Map<string, number>();
  const put = (msgId: string, sig: string, v: number) => map.set(`${msgId}::${sig}`, v);

  if (opts.current !== undefined) put('512', 'PackCurrent', opts.current);
  if (opts.soc !== undefined) put('512', 'StateOfCharge', opts.soc);
  if (opts.packV !== undefined) put('512', 'PackVoltage', opts.packV);

  for (const id of MODULE_IDS) {
    (opts.cells?.[id] ?? []).forEach((v, idx) => {
      const { msgId, signalName } = getCellSignalInfo(id, idx + 1);
      put(msgId, signalName, v);
    });
    (opts.temps?.[id] ?? []).forEach((t, idx) => {
      const { msgId, signalName } = getThermistorSignalInfo(id, idx + 1);
      put(msgId, signalName, t);
    });
  }

  return {
    getSignal(msgID, signalName) {
      const v = map.get(`${msgID}::${signalName}`);
      return v === undefined ? undefined : { sensorReading: v };
    },
  };
}

const flat = (v: number) => Array(CELLS_PER_MODULE).fill(v);

describe('chipHigh / chipLow', () => {
  it('chipHigh escalates with value', () => {
    expect(chipHigh(null, 0.1, 0.2)).toBe('ok');
    expect(chipHigh(0.05, 0.1, 0.2)).toBe('ok');
    expect(chipHigh(0.1, 0.1, 0.2)).toBe('warn');
    expect(chipHigh(0.25, 0.1, 0.2)).toBe('crit');
  });
  it('chipLow escalates as value drops', () => {
    expect(chipLow(null, 3.2, 3.0)).toBe('ok');
    expect(chipLow(3.5, 3.2, 3.0)).toBe('ok');
    expect(chipLow(3.2, 3.2, 3.0)).toBe('warn');
    expect(chipLow(2.9, 3.2, 3.0)).toBe('crit');
  });
});

describe('buildChargingSnapshot — aggregation', () => {
  const cells: Partial<Record<ModuleId, number[]>> = {
    M1: flat(3.85),
    M2: (() => {
      const a = flat(3.84);
      a[0] = 3.99; // global max cell → M2·C1
      return a;
    })(),
    M3: (() => {
      const a = flat(3.83);
      a[9] = 3.65; // global min cell → M3·C10
      return a;
    })(),
    M4: flat(3.86),
    M5: flat(3.86),
  };
  const temps: Partial<Record<ModuleId, number[]>> = {
    M1: [30, 31],
    M4: [56], // critical temp → M4·T1
  };

  const reader = makeReader({ current: -12.4, soc: 67, cells, temps });
  const snap = buildChargingSnapshot(reader, { session: 's1', startMs: 1_000, now: 61_000 });

  it('reports five modules with correct per-module stats', () => {
    expect(snap.modules.map((m) => m.id)).toEqual([...MODULE_IDS]);
    const m3 = snap.modules.find((m) => m.id === 'M3')!;
    expect(m3.min).toBeCloseTo(3.65, 5);
    expect(m3.max).toBeCloseTo(3.83, 5);
    expect(m3.delta_mv).toBe(180);
    const m1 = snap.modules.find((m) => m.id === 'M1')!;
    expect(m1.delta_mv).toBe(0);
    expect(m1.avg).toBeCloseTo(3.85, 5);
  });

  it('finds pack-wide min/max cells with labels', () => {
    expect(snap.min_cell).toEqual({ v: 3.65, label: 'M3·C10' });
    expect(snap.max_cell).toEqual({ v: 3.99, label: 'M2·C1' });
    expect(snap.delta_mv).toBe(340); // (3.99 - 3.65) * 1000
  });

  it('derives pack voltage as the series-cell sum (no PackVoltage signal)', () => {
    const expected =
      3.85 * 20 + (3.84 * 19 + 3.99) + (3.83 * 19 + 3.65) + 3.86 * 20 + 3.86 * 20;
    expect(snap.pack_v).toBeCloseTo(expected, 3);
  });

  it('maps temps and alert chips', () => {
    expect(snap.max_temp).toEqual({ c: 56, label: 'M4·T1' });
    expect(snap.min_temp.c).toBe(30);
    expect(snap.alerts.voltdelta).toBe('crit'); // 0.34 V ≥ 0.2
    expect(snap.alerts.temp).toBe('crit'); // 56 ≥ 55
    expect(snap.alerts.low).toBe('ok'); // 3.65 > 3.2
  });

  it('computes elapsed seconds and passes through valid current/soc', () => {
    expect(snap.elapsed_s).toBe(60);
    expect(snap.current_a).toBe(-12.4);
    expect(snap.soc).toBe(67);
    expect(snap.state).toBe('charging');
  });
});

describe('buildChargingSnapshot — dead-signal guards', () => {
  it('nulls the dead PackCurrent sentinel and the dead 0 SOC', () => {
    const reader = makeReader({ current: -3276, soc: 0, cells: { M1: flat(3.8) } });
    const snap = buildChargingSnapshot(reader, { session: 's', startMs: 0 });
    expect(snap.current_a).toBeNull();
    expect(snap.soc).toBeNull();
    expect(snap.state).toBe('standby'); // unknown current → not charging/discharging
    expect(snap.pack_v).toBeCloseTo(3.8 * 20, 5); // still derived from cells
  });

  it('classifies discharging when current is positive and valid', () => {
    const reader = makeReader({ current: 12, cells: { M1: flat(3.8) } });
    const snap = buildChargingSnapshot(reader, { session: 's', startMs: 0 });
    expect(snap.state).toBe('discharging');
  });
});
