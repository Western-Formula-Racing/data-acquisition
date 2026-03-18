import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useMessageHistory, useSignal, useLatestMessage } from '../../lib/useDataStore';
import { DIAG_MSG_IDS } from '../../services/TelemetryHandler';
import QualityIndicatorDot, { type QualityLevel } from './QualityIndicatorDot';
import PingSparkline from './PingSparkline';
import PacketLossGauge from './PacketLossGauge';
import ThroughputBar from './ThroughputBar';
import RadioStatChips from './RadioStatChips';

function computeLinkQuality(rtt: number | undefined, lossPerSec: number | undefined, hasData: boolean): {
  level: QualityLevel;
  label: string;
  color: string;
} {
  if (!hasData) return { level: 'unknown', label: 'No Data', color: 'bg-sidebarfg/20 text-sidebarfg' };

  // Timeout (rtt == -1 sentinel) or very high RTT
  if (rtt !== undefined && (rtt < 0 || rtt > 80)) {
    return { level: 'critical', label: 'Critical', color: 'bg-rose-500/20 text-rose-400' };
  }
  if ((lossPerSec ?? 0) > 2) {
    return { level: 'critical', label: 'Critical', color: 'bg-rose-500/20 text-rose-400' };
  }

  if ((rtt !== undefined && rtt > 20) || (lossPerSec ?? 0) > 0) {
    return { level: 'warning', label: 'Degraded', color: 'bg-amber-500/20 text-amber-400' };
  }

  return { level: 'good', label: 'Good', color: 'bg-emerald-500/20 text-emerald-400' };
}

export default function LinkHealthPanel() {
  const [collapsed, setCollapsed] = useState(true);

  const pingHistory = useMessageHistory(DIAG_MSG_IDS.LINK_PING, 60_000);
  const latestPing = useSignal(DIAG_MSG_IDS.LINK_PING, 'rtt_ms');
  const latestStats = useLatestMessage(DIAG_MSG_IDS.SYSTEM_STATS);
  const latestTput = useLatestMessage(DIAG_MSG_IDS.LINK_THROUGHPUT);
  const latestRadio = useLatestMessage(DIAG_MSG_IDS.LINK_RADIO);

  const rttMs = latestPing?.sensorReading;
  const lossPerSec = latestStats?.data.missing?.sensorReading;
  const hasData = latestPing !== undefined || latestStats !== undefined;
  const quality = computeLinkQuality(rttMs, lossPerSec, hasData);

  return (
    <div className="bg-data-module-bg rounded-xl border border-sidebarfg/10 flex-shrink-0">
      {/* Header — always visible */}
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-4 py-2.5 cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <QualityIndicatorDot level={quality.level} />
          <span className="text-sm font-bold uppercase text-white/70">Link Health</span>
          <span
            className={`text-xs font-footer px-2 py-0.5 rounded-full ${quality.color}`}
          >
            {quality.label}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {rttMs !== undefined && rttMs >= 0 && (
            <span className="text-xs font-footer text-sidebarfg">
              {rttMs.toFixed(1)} ms
            </span>
          )}
          {latestStats && (
            <span className="text-xs font-footer text-sidebarfg">
              {latestStats.data.received?.sensorReading ?? 0} pkt/s
            </span>
          )}
          {collapsed ? (
            <ChevronDown className="w-4 h-4 text-sidebarfg" />
          ) : (
            <ChevronUp className="w-4 h-4 text-sidebarfg" />
          )}
        </div>
      </button>

      {/* Expanded body */}
      {!collapsed && (
        <div className="px-4 pb-4 pt-0 grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-sidebarfg/10">
          {/* Column 1: RTT Sparkline */}
          <div>
            <p className="text-xs text-sidebarfg font-footer mb-1 uppercase tracking-wider">
              RTT — last 60s
            </p>
            <PingSparkline history={pingHistory} />
          </div>

          {/* Column 2: Packet Loss + Throughput */}
          <div className="space-y-3">
            <PacketLossGauge stats={latestStats?.data} />
            <ThroughputBar throughputData={latestTput} />
          </div>

          {/* Column 3: Radio stats */}
          <div>
            <RadioStatChips radioData={latestRadio} />
          </div>
        </div>
      )}
    </div>
  );
}
