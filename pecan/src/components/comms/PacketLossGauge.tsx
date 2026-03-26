import { Activity, AlertTriangle } from 'lucide-react';
import type { TelemetrySample } from '../../lib/DataStore';

interface Props {
  stats: TelemetrySample['data'] | undefined;
}

export default function PacketLossGauge({ stats }: Props) {
  const received = stats?.received?.sensorReading ?? null;
  const missing = stats?.missing?.sensorReading ?? null;
  const recovered = stats?.recovered?.sensorReading ?? null;

  const total = (received ?? 0) + (missing ?? 0);
  const lossPct = total > 0 ? ((missing ?? 0) / total) * 100 : null;

  const lossColor =
    lossPct === null
      ? 'text-sidebarfg'
      : lossPct === 0
        ? 'text-emerald-400'
        : lossPct < 5
          ? 'text-amber-400'
          : 'text-rose-400';

  return (
    <div className="flex flex-col gap-1.5">
      {/* Packet rate */}
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-data-textbox-bg border border-sidebarfg/15">
        <Activity className="w-3 h-3 text-emerald-400 flex-shrink-0" />
        <span className="text-xs text-sidebarfg font-footer">Packets/s</span>
        <span className="text-sm font-bold uppercase tracking-wider text-white/80 ml-auto">
          {received !== null ? received : '—'}
        </span>
      </div>

      {/* Loss */}
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-data-textbox-bg border border-sidebarfg/15">
        {(lossPct ?? 0) > 0 ? (
          <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0" />
        ) : (
          <Activity className="w-3 h-3 text-emerald-400 flex-shrink-0" />
        )}
        <span className="text-xs text-sidebarfg font-footer">Loss</span>
        <span className={`text-sm font-bold uppercase tracking-wider ml-auto ${lossColor}`}>
          {lossPct !== null ? `${lossPct.toFixed(1)}%` : '—'}
        </span>
      </div>

      {/* Recovered (only when non-zero) */}
      {(recovered ?? 0) > 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-data-textbox-bg border border-sidebarfg/15">
          <Activity className="w-3 h-3 text-sky-400 flex-shrink-0" />
          <span className="text-xs text-sidebarfg font-footer">Recovered/s</span>
          <span className="text-sm font-bold uppercase tracking-wider text-white/80 ml-auto">{recovered}</span>
        </div>
      )}
    </div>
  );
}
