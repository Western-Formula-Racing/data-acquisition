import { useState, useEffect } from 'react';
import { Radio, AlertTriangle } from 'lucide-react';
import { useLatestMessage } from '../../lib/useDataStore';
import type { TelemetrySample } from '../../lib/DataStore';

interface Props {
  radioData: TelemetrySample | undefined;
}

function StatPill({
  label,
  value,
  unit,
  color = 'text-white',
}: {
  label: string;
  value: string;
  unit?: string;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-data-textbox-bg border border-sidebarfg/15">
      <span className="text-xs text-sidebarfg font-footer">{label}</span>
      <span className={`text-sm font-bold uppercase tracking-wider ${color}`}>
        {value}
        {unit && (
          <span className="text-xs text-sidebarfg font-footer ml-0.5">
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}

export default function RadioStatChips({ radioData }: Props) {
  const [now, setNow] = useState(Date.now());
  const heartbeatData = useLatestMessage('1999');

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const isPipelineAlive = heartbeatData && (now - heartbeatData.timestamp) < 3000;

  if (!radioData) {
    return (
      <div className="flex flex-col gap-1 opacity-40">
        <div className="flex items-center gap-2">
          <Radio className="w-3 h-3 text-sidebarfg" />
          <span className="text-xs text-sidebarfg font-footer uppercase tracking-wider">
            Radio (not configured)
          </span>
        </div>
        <StatPill
          label="Pipeline"
          value={isPipelineAlive ? 'Alive' : 'Dead'}
          color={isPipelineAlive ? 'text-emerald-400' : 'text-rose-400'}
        />
      </div>
    );
  }

  // Error case
  if (radioData.data.error?.sensorReading === 1) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 mb-0.5">
          <Radio className="w-3 h-3 text-sidebarfg" />
          <span className="text-xs text-sidebarfg font-footer uppercase tracking-wider">
            Radio
          </span>
        </div>
        <div className="flex items-center gap-2 text-amber-400 px-3 py-1.5 rounded-lg bg-data-textbox-bg border border-sidebarfg/15">
          <AlertTriangle className="w-3 h-3" />
          <span className="text-xs font-footer">
            {radioData.rawData || 'Unreachable'}
          </span>
        </div>
        <StatPill
          label="Pipeline"
          value={isPipelineAlive ? 'Alive' : 'Dead'}
          color={isPipelineAlive ? 'text-emerald-400' : 'text-rose-400'}
        />
      </div>
    );
  }

  const rssi = radioData.data.rssi_dbm?.sensorReading;
  const txMbps = radioData.data.tx_mbps?.sensorReading;
  const rxMbps = radioData.data.rx_mbps?.sensorReading;
  const ccq = radioData.data.ccq_pct?.sensorReading;

  const rssiColor =
    rssi == null
      ? 'text-sidebarfg'
      : rssi > -65
        ? 'text-emerald-400'
        : rssi > -80
          ? 'text-amber-400'
          : 'text-rose-400';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 mb-0.5">
        <Radio className="w-3 h-3 text-sidebarfg" />
        <span className="text-xs text-sidebarfg font-footer uppercase tracking-wider">
          Radio
        </span>
      </div>
      <StatPill
        label="Pipeline"
        value={isPipelineAlive ? 'Alive' : 'Dead'}
        color={isPipelineAlive ? 'text-emerald-400' : 'text-rose-400'}
      />
      {rssi != null && (
        <StatPill label="RSSI" value={`${rssi}`} unit="dBm" color={rssiColor} />
      )}
      {txMbps != null && (
        <StatPill label="TX" value={txMbps.toFixed(1)} unit="Mbps" />
      )}
      {rxMbps != null && (
        <StatPill label="RX" value={rxMbps.toFixed(1)} unit="Mbps" />
      )}
      {ccq != null && (
        <StatPill label="CCQ" value={`${ccq.toFixed(0)}`} unit="%" />
      )}
    </div>
  );
}
