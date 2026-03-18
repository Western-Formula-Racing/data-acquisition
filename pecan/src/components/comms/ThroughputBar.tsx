import type { TelemetrySample } from '../../lib/DataStore';

const MAX_MBPS = 54; // Ubiquiti airMax theoretical max — visual scale reference

interface Props {
  throughputData: TelemetrySample | undefined;
}

export default function ThroughputBar({ throughputData }: Props) {
  const mbps = throughputData?.data.mbps?.sensorReading;
  const lossPct = throughputData?.data.loss_pct?.sensorReading;
  const ts = throughputData?.timestamp;

  const ageSeconds = ts ? Math.round((Date.now() - ts) / 1000) : null;
  const isStale = ageSeconds !== null && ageSeconds > 45;

  if (mbps === undefined || mbps < 0) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex justify-between">
          <span className="text-xs text-sidebarfg font-footer uppercase tracking-wider">
            Throughput
          </span>
          <span className="text-xs text-sidebarfg/50 font-footer">
            {ageSeconds === null ? 'pending first test...' : isStale ? `tested ${ageSeconds}s ago` : ''}
          </span>
        </div>
        <div className="h-3 bg-data-textbox-bg rounded-full overflow-hidden">
          <div className="h-full w-0 rounded-full bg-sidebarfg/30 animate-pulse" />
        </div>
      </div>
    );
  }

  const pct = Math.min(100, (mbps / MAX_MBPS) * 100);
  const barColor =
    mbps > 20 ? 'bg-emerald-500' : mbps > 8 ? 'bg-amber-500' : 'bg-rose-500';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between items-baseline">
        <span className="text-xs text-sidebarfg font-footer uppercase tracking-wider">
          Throughput
        </span>
        <span
          className={`text-sm font-bold uppercase tracking-wider ${isStale ? 'text-sidebarfg' : 'text-white'}`}
        >
          {mbps.toFixed(1)}{' '}
          <span className="text-xs text-sidebarfg font-footer">Mbps</span>
        </span>
      </div>
      <div className="h-3 bg-data-textbox-bg rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {(lossPct ?? 0) > 0 && (
        <p className="text-xs text-amber-400 font-footer">
          {lossPct?.toFixed(1)}% burst loss
        </p>
      )}
      {isStale && (
        <p className="text-xs text-sidebarfg/50 font-footer">
          tested {ageSeconds}s ago
        </p>
      )}
    </div>
  );
}
