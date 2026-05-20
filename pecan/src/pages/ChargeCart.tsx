import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BatteryCharging,
  CircleStop,
  Power,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react';
import {
  AccumulatorProvider,
  MODULE_IDS,
  type ModuleId,
  getCellSignalInfo,
  getThermistorSignalInfo,
} from '../components/accumulator';
import { dataStore, type TelemetrySample } from '../lib/DataStore';
import {
  txWebSocketService,
  type ChargecartBalanceCommand,
  type TxHandler,
} from '../services/TxWebSocketService';
import { formatCanId } from '../utils/canProcessor';

const START_BALANCE_CAN_ID = 998;
const STOP_BALANCE_CAN_ID = 999;
const PACK_STATUS_CAN_ID = 1056;
const PACK_INFO_CAN_ID = 1057;
const TORCH_FAULT_CAN_ID = 1000;
const HOT_LED_TEMP_C = 45;
const BALANCE_SKIP_TEMP_C = 115;
const BALANCE_DONE_DELTA_V = 0.015;

const BALANCE_CAN_IDS: Record<ModuleId, number> = {
  M1: 1001,
  M2: 1002,
  M3: 1003,
  M4: 1004,
  M5: 1005,
};

const PACK_STATUS_LABELS: Record<number, string> = {
  0: 'Idle',
  1: 'Precharge Start',
  2: 'Precharging',
  3: 'Active',
  4: 'Charging',
  5: 'Charge Complete',
  6: 'Fault',
};

const FAULT_LABELS: Record<number, string> = {
  69: 'Module overheat',
  70: 'Cell undervolt',
  71: 'Cell overvolt',
  72: 'Open cell',
  73: 'Open thermistor',
  74: 'LTC MUX fault',
  75: 'LTC mute fail',
  76: 'LTC cell voltage register fault',
  77: 'LTC status register fault',
  78: 'LTC auxiliary register fault',
  79: 'LTC ADC mismatch fault',
  80: 'LTC VA out of range',
  81: 'LTC VD out of range',
  82: 'LTC REF2 out of range',
  83: 'LTC overheat',
  84: 'LTC balance PWM setup fail',
  85: 'Balance initiation fail',
  86: 'LTC CRC fail',
  87: 'STM32 CAN read fail',
};

type TxFeedback =
  | null
  | { type: 'sending'; label: string }
  | { type: 'ok'; label: string }
  | { type: 'error'; message: string };

type ModuleBalance = {
  moduleId: ModuleId;
  ageMs: number | null;
  activeCells: number;
  outOfBalance: number | null;
  deltaV: number | null;
  hottestResistorC: number | null;
  state: 'offline' | 'active' | 'settling' | 'done';
};

type BmsSnapshot = {
  packStatus: number | null;
  packStatusLabel: string;
  packCurrentA: number | null;
  socPct: number | null;
  hvActive: boolean;
  faultCode: number | null;
  faultLabel: string | null;
  minCellV: number | null;
  maxCellV: number | null;
  packDeltaV: number | null;
  maxTempC: number | null;
  modules: ModuleBalance[];
  activeModuleCount: number;
  balancingCellCount: number;
  outOfBalanceCellCount: number;
  maxBalanceDeltaV: number | null;
  hottestResistorC: number | null;
  lastUpdateAgeMs: number | null;
};

type WarningItem = {
  level: 'critical' | 'warning' | 'info' | 'ok';
  text: string;
};

type CoveredBalanceButtonProps = {
  label: string;
  detail: string;
  tone: 'start' | 'stop';
  disabled: boolean;
  sending: boolean;
  onConfirm: () => void;
};

function signal(sample: TelemetrySample | undefined, name: string): number | null {
  const value = sample?.data[name]?.sensorReading;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function latest(canId: number): TelemetrySample | undefined {
  return dataStore.getLatest(formatCanId(canId));
}

function freshAge(sample: TelemetrySample | undefined, now: number): number | null {
  if (!sample?.timestamp) return null;
  return Math.max(0, now - sample.timestamp);
}

function computeBmsSnapshot(): BmsSnapshot {
  const now = Date.now();
  const pack = latest(PACK_STATUS_CAN_ID);
  const packInfo = latest(PACK_INFO_CAN_ID);
  const fault = latest(TORCH_FAULT_CAN_ID);
  const packStatus = signal(pack, 'PackStatus');
  const faultCode = signal(fault, 'Error_code');
  const packInfoMin = signal(packInfo, 'MinCellVoltage');
  const packInfoMax = signal(packInfo, 'MaxCellVoltage');

  const cellValues: number[] = [];
  const tempValues: number[] = [];
  const sensorAges: number[] = [];
  for (const moduleId of MODULE_IDS) {
    for (let i = 1; i <= 20; i += 1) {
      const info = getCellSignalInfo(moduleId, i);
      const sample = dataStore.getLatest(info.msgId);
      const value = signal(sample, info.signalName);
      if (value !== null) cellValues.push(value);
      const age = freshAge(sample, now);
      if (age !== null) sensorAges.push(age);
    }
    for (let i = 1; i <= 18; i += 1) {
      const info = getThermistorSignalInfo(moduleId, i);
      const sample = dataStore.getLatest(info.msgId);
      const value = signal(sample, info.signalName);
      if (value !== null) tempValues.push(value);
      const age = freshAge(sample, now);
      if (age !== null) sensorAges.push(age);
    }
  }

  const minCellV = packInfoMin ?? (cellValues.length ? Math.min(...cellValues) : null);
  const maxCellV = packInfoMax ?? (cellValues.length ? Math.max(...cellValues) : null);
  const maxTempC = signal(packInfo, 'MaxTemp') ?? (tempValues.length ? Math.max(...tempValues) : null);

  const modules = MODULE_IDS.map((moduleId): ModuleBalance => {
    const sample = latest(BALANCE_CAN_IDS[moduleId]);
    const moduleCellValues: number[] = [];
    const moduleTempValues: number[] = [];
    for (let i = 1; i <= 20; i += 1) {
      const info = getCellSignalInfo(moduleId, i);
      const value = signal(dataStore.getLatest(info.msgId), info.signalName);
      if (value !== null) moduleCellValues.push(value);
    }
    for (let i = 1; i <= 18; i += 1) {
      const info = getThermistorSignalInfo(moduleId, i);
      const value = signal(dataStore.getLatest(info.msgId), info.signalName);
      if (value !== null) moduleTempValues.push(value);
    }

    const activeCells = Array.from({ length: 20 }, (_, i) => signal(sample, `Cell_${i + 1}_balance_flag`) ?? 0)
      .filter((value) => value > 0).length;
    const outOfBalanceFromVoltages = minCellV !== null
      ? moduleCellValues.filter((value) => value - minCellV > BALANCE_DONE_DELTA_V).length
      : null;
    const outOfBalance = signal(sample, 'Out_of_balance_cell_count') ?? outOfBalanceFromVoltages;
    const deltaFromVoltages = moduleCellValues.length > 1
      ? Math.max(...moduleCellValues) - Math.min(...moduleCellValues)
      : null;
    const deltaV = signal(sample, 'Max_cell_voltage_delta') ?? deltaFromVoltages;
    const hottestTemp = moduleTempValues.length ? Math.max(...moduleTempValues) : null;
    const hottestResistorC = signal(sample, 'Resistor_hottest_temperature') ?? hottestTemp;
    const ageMs = freshAge(sample, now);
    const recent = ageMs !== null && ageMs < 6000;

    let state: ModuleBalance['state'] = 'offline';
    if (recent && activeCells > 0) {
      state = 'active';
    } else if (recent && (outOfBalance ?? 0) > 0) {
      state = 'settling';
    } else if (recent) {
      state = 'done';
    }

    return { moduleId, ageMs, activeCells, outOfBalance, deltaV, hottestResistorC, state };
  });

  const activeModuleCount = modules.filter((m) => m.state === 'active' || m.state === 'settling').length;
  const balancingCellCount = modules.reduce((sum, m) => sum + m.activeCells, 0);
  const outOfBalanceCellCount = modules.reduce((sum, m) => sum + (m.outOfBalance ?? 0), 0);
  const balanceDeltas = modules.map((m) => m.deltaV).filter((v): v is number => v !== null);
  const resistorTemps = modules.map((m) => m.hottestResistorC).filter((v): v is number => v !== null);
  const ages = [freshAge(pack, now), freshAge(packInfo, now), freshAge(fault, now), ...modules.map((m) => m.ageMs), ...sensorAges]
    .filter((age): age is number => age !== null);

  return {
    packStatus,
    packStatusLabel: packStatus !== null ? PACK_STATUS_LABELS[packStatus] ?? `State ${packStatus}` : 'No Data',
    packCurrentA: signal(pack, 'PackCurrent'),
    socPct: signal(pack, 'SOC'),
    hvActive: (signal(pack, 'HV_Active') ?? 0) > 0,
    faultCode,
    faultLabel: faultCode !== null ? FAULT_LABELS[faultCode] ?? `Fault ${faultCode}` : null,
    minCellV,
    maxCellV,
    packDeltaV: minCellV !== null && maxCellV !== null ? maxCellV - minCellV : null,
    maxTempC,
    modules,
    activeModuleCount,
    balancingCellCount,
    outOfBalanceCellCount,
    maxBalanceDeltaV: balanceDeltas.length ? Math.max(...balanceDeltas) : null,
    hottestResistorC: resistorTemps.length ? Math.max(...resistorTemps) : null,
    lastUpdateAgeMs: ages.length ? Math.min(...ages) : null,
  };
}

function useBmsSnapshot() {
  const [snapshot, setSnapshot] = useState(() => computeBmsSnapshot());

  useEffect(() => {
    const update = () => setSnapshot(computeBmsSnapshot());
    const unsubscribe = dataStore.subscribe(update);
    const interval = window.setInterval(update, 1000);
    update();
    return () => {
      unsubscribe();
      window.clearInterval(interval);
    };
  }, []);

  return snapshot;
}

function buildWarnings(snapshot: BmsSnapshot, txConnected: boolean, rxOnly: boolean): WarningItem[] {
  const warnings: WarningItem[] = [];

  if (snapshot.lastUpdateAgeMs === null) {
    warnings.push({ level: 'warning', text: 'No BMS telemetry yet. Verify UTS is reading can0.' });
  } else if (snapshot.lastUpdateAgeMs > 5000) {
    warnings.push({ level: 'warning', text: `BMS telemetry stale: ${(snapshot.lastUpdateAgeMs / 1000).toFixed(1)}s old.` });
  }

  if (snapshot.faultCode !== null) {
    warnings.push({ level: 'critical', text: `BMS fault ${snapshot.faultCode}: ${snapshot.faultLabel}. Balancing cannot start.` });
  }

  if (snapshot.packStatus === 6) {
    warnings.push({ level: 'critical', text: 'PackStatus is Fault. Power cycle required after resolving the fault.' });
  }

  if (snapshot.hvActive || snapshot.packStatus === 3) {
    warnings.push({ level: 'critical', text: 'HV active / AIRs closed. BMS will ignore or abort balancing.' });
  }

  if ((snapshot.hottestResistorC ?? 0) >= BALANCE_SKIP_TEMP_C) {
    warnings.push({ level: 'critical', text: `Balance resistor ${snapshot.hottestResistorC?.toFixed(1)}C. BMS skips balancing above ${BALANCE_SKIP_TEMP_C}C.` });
  } else if ((snapshot.hottestResistorC ?? 0) >= HOT_LED_TEMP_C) {
    warnings.push({ level: 'warning', text: `HOT LED threshold exceeded: resistor ${snapshot.hottestResistorC?.toFixed(1)}C.` });
  }

  if ((snapshot.maxBalanceDeltaV ?? snapshot.packDeltaV ?? Infinity) <= BALANCE_DONE_DELTA_V && snapshot.outOfBalanceCellCount === 0) {
    warnings.push({ level: 'ok', text: 'Cells are within 15 mV target. Balancing is effectively complete.' });
  } else if (snapshot.outOfBalanceCellCount > 0) {
    warnings.push({ level: 'info', text: `${snapshot.outOfBalanceCellCount} cells still above the 15 mV balance target.` });
  }

  if (!rxOnly && !txConnected) {
    warnings.push({ level: 'warning', text: 'TX bridge offline. Display is live, but commands cannot be sent.' });
  }

  if (rxOnly) {
    warnings.push({ level: 'info', text: 'Broadcast mode is RX-only. Commands are hidden on this hostname.' });
  }

  return warnings.slice(0, 4);
}

function CoveredBalanceButton({
  label,
  detail,
  tone,
  disabled,
  sending,
  onConfirm,
}: CoveredBalanceButtonProps) {
  const [coverOpen, setCoverOpen] = useState(false);
  const isStart = tone === 'start';
  const color = isStart ? 'emerald' : 'red';
  const Icon = isStart ? Power : CircleStop;

  const handleConfirm = () => {
    onConfirm();
    setCoverOpen(false);
  };

  return (
    <div className={`relative h-[118px] overflow-hidden rounded-lg border-2 bg-data-textbox-bg shadow-inner ${disabled ? 'border-gray-700 opacity-80' : isStart ? 'border-emerald-500/60' : 'border-red-500/60'}`}>
      <button
        type="button"
        disabled={disabled || sending || !coverOpen}
        onClick={handleConfirm}
        className={`absolute inset-3 flex flex-col items-center justify-center rounded-md border-2 transition-all duration-200 ${
          coverOpen ? 'scale-100 opacity-100' : 'scale-95 opacity-10'
        } ${
          isStart
            ? 'border-emerald-300 bg-emerald-600 text-white shadow-[0_0_20px_rgba(16,185,129,0.25)]'
            : 'border-red-300 bg-red-700 text-white shadow-[0_0_20px_rgba(239,68,68,0.25)]'
        } disabled:cursor-not-allowed disabled:saturate-50`}
      >
        <Icon className="h-5 w-5" />
        <span className="mt-1 text-[12px] font-black uppercase tracking-wide">{sending ? 'Sending' : label}</span>
        <span className="text-[10px] font-semibold uppercase opacity-75">CAN {isStart ? '998' : '999'}</span>
      </button>

      <button
        type="button"
        onClick={() => setCoverOpen((open) => !open)}
        aria-pressed={coverOpen}
        className={`absolute inset-0 z-10 flex flex-col justify-end border transition-transform duration-300 ${
          coverOpen ? '-translate-y-[72%]' : 'translate-y-0'
        } ${isStart ? 'border-emerald-200/40' : 'border-red-200/40'}`}
        style={{
          background:
            `linear-gradient(135deg, rgba(255,255,255,0.55), rgba(255,255,255,0.16) 34%, rgba(255,255,255,0.28) 35%, rgba(255,255,255,0.08) 74%), var(--${color}-cover)`,
          boxShadow: 'inset 0 1px 18px rgba(255,255,255,0.26), inset 0 -10px 20px rgba(15,23,42,0.34)',
        }}
      >
        <div className="absolute left-0 right-0 top-0 h-2 bg-white/25" />
        <div className="px-3 pb-2 text-left">
          <div className="flex items-center gap-2 text-white">
            {coverOpen ? <ShieldOff className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
            <span className="text-[9px] font-black uppercase tracking-[0.16em]">
              {coverOpen ? 'Cover Open' : 'Lift Cover'}
            </span>
          </div>
          <div className="mt-0.5 text-[12px] font-bold uppercase text-white">{label}</div>
          <div className="text-[9px] text-white/70">{detail}</div>
        </div>
      </button>
    </div>
  );
}

function MetricTile({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'ok' | 'warn' | 'critical' }) {
  const color = tone === 'critical' ? 'text-red-300 border-red-500 bg-red-500/10'
    : tone === 'warn' ? 'text-amber-200 border-orange-500 bg-orange-500/10'
      : tone === 'ok' ? 'text-emerald-200 border-emerald-500 bg-emerald-500/10'
        : 'text-white border-gray-700 bg-data-module-bg';
  return (
    <div className={`min-h-0 overflow-hidden rounded-lg border-2 px-3 py-2 ${color}`}>
      <div className="truncate text-[9px] font-bold uppercase tracking-[0.12em] text-gray-400">{label}</div>
      <div className="mt-1 truncate text-[16px] font-black leading-none">{value}</div>
    </div>
  );
}

function ModuleBalanceCard({ module }: { module: ModuleBalance }) {
  const stateClass = module.state === 'active' ? 'border-emerald-500/60 bg-emerald-500/10'
    : module.state === 'settling' ? 'border-blue-500/50 bg-blue-500/10'
      : module.state === 'done' ? 'border-slate-600 bg-slate-800/60'
        : 'border-slate-800 bg-slate-900/70';
  const stateLabel = module.state === 'active' ? 'Balancing'
    : module.state === 'settling' ? 'Settling'
      : module.state === 'done' ? 'Done'
        : 'No Balance';
  const hot = (module.hottestResistorC ?? 0) >= HOT_LED_TEMP_C;

  return (
    <div className={`min-h-0 overflow-hidden rounded-lg border-2 p-2 transition-colors ${stateClass.replace('border-slate-800', 'border-gray-700').replace('bg-slate-900/70', 'bg-data-module-bg')}`}>
      <div className="flex items-center justify-between">
        <div className="text-[16px] font-black leading-none text-white">{module.moduleId}</div>
        <div className={`truncate text-[9px] font-black uppercase ${module.state === 'active' ? 'text-emerald-300' : 'text-slate-300'}`}>
          {stateLabel}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1 text-center">
        <div>
          <div className="text-[9px] uppercase text-slate-500">Cells</div>
          <div className="font-mono text-[13px] text-white">{module.activeCells}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase text-slate-500">Delta</div>
          <div className="font-mono text-[13px] text-white">{module.deltaV !== null ? `${(module.deltaV * 1000).toFixed(0)}` : '--'}mV</div>
        </div>
        <div>
          <div className="text-[9px] uppercase text-slate-500">Hot</div>
          <div className={`font-mono text-[13px] ${hot ? 'text-amber-300' : 'text-white'}`}>
            {module.hottestResistorC !== null ? module.hottestResistorC.toFixed(0) : '--'}C
          </div>
        </div>
      </div>
    </div>
  );
}

function WarningPanel({ warnings }: { warnings: WarningItem[] }) {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {warnings.map((warning, index) => {
        const className = warning.level === 'critical' ? 'border-red-500/50 bg-red-500/15 text-red-100'
          : warning.level === 'warning' ? 'border-amber-500/50 bg-amber-500/15 text-amber-100'
            : warning.level === 'ok' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
              : 'border-blue-500/40 bg-blue-500/10 text-blue-100';
        return (
          <div key={`${warning.text}-${index}`} className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-tight ${className}`}>
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>{warning.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function ChargeCart() {
  const rxOnly = window.location.hostname === 'chargecart.westernformularacing.org';
  const snapshot = useBmsSnapshot();
  const [txConnected, setTxConnected] = useState(false);
  const [feedback, setFeedback] = useState<TxFeedback>(null);
  const pendingTxRef = useRef<string | null>(null);
  const ackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (rxOnly) return;

    txWebSocketService.connect();
    setTxConnected(txWebSocketService.connected);

    const clearPending = () => {
      pendingTxRef.current = null;
      if (ackTimeoutRef.current !== null) {
        window.clearTimeout(ackTimeoutRef.current);
        ackTimeoutRef.current = null;
      }
    };

    const onTxMessage: TxHandler = (msg) => {
      if (msg.type === 'uplink_ack' && pendingTxRef.current === msg.ref) {
        const label = pendingTxRef.current.includes('start') ? 'Start balancing sent' : 'Stop balancing sent';
        clearPending();
        setFeedback({ type: 'ok', label });
        return;
      }

      if (msg.type === 'error' && pendingTxRef.current) {
        clearPending();
        setFeedback({ type: 'error', message: `${msg.code}: ${msg.message}` });
      }
    };

    const pollInterval = window.setInterval(() => {
      setTxConnected(txWebSocketService.connected);
    }, 1000);

    txWebSocketService.onMessage(onTxMessage);

    return () => {
      txWebSocketService.offMessage(onTxMessage);
      window.clearInterval(pollInterval);
      if (ackTimeoutRef.current !== null) window.clearTimeout(ackTimeoutRef.current);
    };
  }, [rxOnly]);

  const sendBalanceCommand = useCallback((
    canId: number,
    label: string,
    command: ChargecartBalanceCommand,
  ) => {
    if (rxOnly) {
      setFeedback({ type: 'error', message: 'This broadcast page is RX-only.' });
      return;
    }

    if (!txWebSocketService.isConnected()) {
      setFeedback({ type: 'error', message: 'TX bridge not connected. Check UTS on port 9078.' });
      return;
    }

    if (ackTimeoutRef.current !== null) window.clearTimeout(ackTimeoutRef.current);

    const ref = `chargecart-${command}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    pendingTxRef.current = ref;
    setFeedback({ type: 'sending', label });

    ackTimeoutRef.current = window.setTimeout(() => {
      if (pendingTxRef.current === ref) {
        pendingTxRef.current = null;
        ackTimeoutRef.current = null;
        setFeedback({ type: 'error', message: 'No TX acknowledgement received.' });
      }
    }, 10_000);

    const sent = txWebSocketService.sendChargecartBalance(command, ref);
    if (!sent) {
      pendingTxRef.current = null;
      if (ackTimeoutRef.current !== null) {
        window.clearTimeout(ackTimeoutRef.current);
        ackTimeoutRef.current = null;
      }
      setFeedback({ type: 'error', message: 'Failed to send. TX bridge disconnected.' });
      return;
    }

    dataStore.ingestMessage({
      msgID: formatCanId(canId),
      messageName: canId === START_BALANCE_CAN_ID ? 'TORCH_START_BALANCE' : 'TORCH_STOP_BALANCE',
      data: {},
      rawData: '00 00 00 00 00 00 00 00',
      timestamp: Date.now(),
      direction: 'tx',
    });
  }, [rxOnly]);

  const warnings = useMemo(() => buildWarnings(snapshot, txConnected, rxOnly), [snapshot, txConnected, rxOnly]);
  const startDisabled = rxOnly || !txConnected || snapshot.faultCode !== null || snapshot.packStatus === 6 || snapshot.hvActive || (snapshot.hottestResistorC ?? 0) >= BALANCE_SKIP_TEMP_C;
  const stopDisabled = rxOnly || !txConnected;
  const isSending = feedback?.type === 'sending';
  const isCharging = (snapshot.packCurrentA ?? 0) < -0.5 || snapshot.packStatus === 4;

  return (
    <AccumulatorProvider>
      <div
        className="h-screen min-h-[600px] overflow-hidden bg-sidebar text-white"
        style={{
          ['--emerald-cover' as string]: 'rgba(16,185,129,0.34)',
          ['--red-cover' as string]: 'rgba(239,68,68,0.34)',
        }}
      >
        <div className="grid h-full grid-rows-[56px_minmax(0,1fr)] gap-2 p-3">
          <header className="grid min-h-0 grid-cols-[160px_repeat(4,minmax(0,1fr))] gap-2">
            <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border-2 border-gray-700 bg-data-module-bg px-3">
              <BatteryCharging className={`h-4 w-4 flex-shrink-0 ${isCharging ? 'animate-pulse text-emerald-300' : 'text-slate-400'}`} />
              <div className="min-w-0 overflow-hidden leading-none">
                <h1 className="truncate font-black uppercase text-white" style={{ fontSize: 14, lineHeight: '15px' }}>Charge</h1>
                <h2 className="truncate font-black uppercase text-white" style={{ fontSize: 14, lineHeight: '15px' }}>Cart</h2>
                <p className="mt-0.5 truncate text-[8px] uppercase tracking-[0.08em] text-gray-400">
                  {rxOnly ? 'RX broadcast' : txConnected ? 'Local TX ready' : 'Local TX offline'}
                </p>
              </div>
            </div>
            <MetricTile label="BMS State" value={snapshot.packStatusLabel} tone={snapshot.packStatus === 6 ? 'critical' : snapshot.hvActive ? 'warn' : 'ok'} />
            <MetricTile label="Pack Delta" value={snapshot.packDeltaV !== null ? `${(snapshot.packDeltaV * 1000).toFixed(0)} mV` : '--'} tone={(snapshot.packDeltaV ?? 0) <= BALANCE_DONE_DELTA_V ? 'ok' : 'warn'} />
            <MetricTile label="Balancing" value={`${snapshot.activeModuleCount} mod / ${snapshot.balancingCellCount} cells`} tone={snapshot.activeModuleCount > 0 ? 'ok' : 'neutral'} />
            <MetricTile label="Hottest" value={snapshot.hottestResistorC !== null ? `${snapshot.hottestResistorC.toFixed(1)} C` : snapshot.maxTempC !== null ? `${snapshot.maxTempC.toFixed(1)} C` : '--'} tone={(snapshot.hottestResistorC ?? 0) >= BALANCE_SKIP_TEMP_C ? 'critical' : (snapshot.hottestResistorC ?? 0) >= HOT_LED_TEMP_C ? 'warn' : 'neutral'} />
          </header>

          <main className="grid min-h-0 grid-cols-[minmax(0,1fr)_270px] gap-2">
            <section className="grid min-h-0 grid-rows-[96px_92px_minmax(0,1fr)] gap-2">
              <div className="grid min-h-0 grid-cols-5 gap-2">
                {snapshot.modules.map((module) => (
                  <ModuleBalanceCard key={module.moduleId} module={module} />
                ))}
              </div>

              <div className="grid min-h-0 grid-cols-4 gap-2">
                <MetricTile label="Min Cell" value={snapshot.minCellV !== null ? `${snapshot.minCellV.toFixed(3)} V` : '--'} />
                <MetricTile label="Max Cell" value={snapshot.maxCellV !== null ? `${snapshot.maxCellV.toFixed(3)} V` : '--'} />
                <MetricTile label="Current" value={snapshot.packCurrentA !== null ? `${snapshot.packCurrentA.toFixed(1)} A` : '--'} tone={isCharging ? 'ok' : 'neutral'} />
                <MetricTile label="SOC" value={snapshot.socPct !== null ? `${snapshot.socPct.toFixed(1)} %` : '--'} />
              </div>

              <div className="min-h-0 rounded-lg border-2 border-gray-700 bg-data-module-bg p-3">
                <div className="mb-3 flex items-center gap-2 text-[13px] font-black uppercase tracking-[0.14em] text-gray-300">
                  <AlertTriangle className="h-4 w-4 text-amber-300" />
                  Balance Warnings
                </div>
                <WarningPanel warnings={warnings} />
              </div>
            </section>

            <aside className="grid min-h-0 grid-rows-[74px_minmax(0,1fr)_minmax(40px,auto)] gap-2 rounded-lg border-2 border-gray-700 bg-data-module-bg p-3">
              <div className="rounded-lg border-2 border-gray-700 bg-data-textbox-bg px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-black uppercase tracking-[0.14em] text-gray-300">Commands</span>
                  <span className={`text-[10px] font-bold uppercase ${rxOnly ? 'text-blue-300' : txConnected ? 'text-emerald-300' : 'text-amber-300'}`}>
                    {rxOnly ? 'RX Only' : txConnected ? 'TX Ready' : 'No TX'}
                  </span>
                </div>
                <div className="mt-2 text-[10px] leading-tight text-gray-400">
                  Start is blocked on fault, HV active, or balance resistor overheat.
                </div>
              </div>

              {rxOnly ? (
                <div className="rounded border border-blue-500/40 bg-blue-500/10 px-3 py-3 text-sm text-blue-100">
                  <div className="font-black uppercase tracking-[0.18em]">Broadcast Mode</div>
                  <div className="mt-1 text-xs text-blue-100/75">
                    This page monitors BMS balancing only. TX is not exposed through Zero Trust.
                  </div>
                </div>
              ) : (
                <div className="grid content-start gap-3">
                  <CoveredBalanceButton
                    label="Start Balancing"
                    detail="TORCH_START_BALANCE"
                    tone="start"
                    disabled={startDisabled}
                    sending={isSending}
                    onConfirm={() => sendBalanceCommand(START_BALANCE_CAN_ID, 'Starting balancing', 'start')}
                  />

                  <CoveredBalanceButton
                    label="Stop Balancing"
                    detail="TORCH_STOP_BALANCE"
                    tone="stop"
                    disabled={stopDisabled}
                    sending={isSending}
                    onConfirm={() => sendBalanceCommand(STOP_BALANCE_CAN_ID, 'Stopping balancing', 'stop')}
                  />
                </div>
              )}

              {feedback ? (
                <div
                  className={`rounded-md border px-3 py-2 text-xs font-semibold ${
                    feedback.type === 'error'
                      ? 'border-red-500/40 bg-red-500/10 text-red-200'
                      : feedback.type === 'ok'
                        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                        : 'border-blue-500/40 bg-blue-500/10 text-blue-200'
                  }`}
                >
                  {feedback.type === 'error' ? feedback.message : feedback.label}
                </div>
              ) : (
                <div className="rounded-md border border-gray-700 bg-data-textbox-bg px-3 py-2 text-xs font-semibold text-gray-400">
                  Waiting for command.
                </div>
              )}
            </aside>
          </main>
        </div>
      </div>
    </AccumulatorProvider>
  );
}

export default ChargeCart;
