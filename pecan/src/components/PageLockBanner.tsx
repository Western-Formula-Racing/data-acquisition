import { Lock, Unlock, ShieldAlert, Cpu, Wifi, WifiOff } from 'lucide-react';
import { type PageLockState } from '../lib/usePageLock';
import { useSerialStatus } from '../lib/useSerialStatus';

interface PageLockBannerProps {
  lock: PageLockState;
  /** Dynamic wire color from TX state — colors the unlocked and self-locked variants */
  wireColor?: string;
  /** Whether the TX WebSocket bridge on port 9078 is connected */
  txConnected?: boolean;
}

/**
 * Shows lock status and controls for pages with mutual-exclusion requirements.
 * - Local connection: "Lock N/A" indicator
 * - Not locked: "Take control" button
 * - Locked by me: "Release control" button + green indicator
 * - Locked by someone else: red warning banner
 */
export function PageLockBanner({ lock, wireColor, txConnected = false }: PageLockBannerProps) {
  const wire = wireColor ?? 'rgba(100,116,139,0.4)'; // slate fallback

  const TxBadge = () => (
    <div className="flex items-center gap-1.5 text-[10px] font-mono whitespace-nowrap"
      style={{ color: txConnected ? wire.replace(/[\d.]+\)$/, '1)') : 'rgba(148,163,184,0.5)' }}>
      {txConnected
        ? <Wifi className="w-3 h-3 flex-shrink-0" />
        : <WifiOff className="w-3 h-3 flex-shrink-0" />}
      {txConnected ? 'TX :9078' : 'TX offline'}
    </div>
  );
  const isLocal = useSerialStatus();

  if (isLocal) {
    return (
      <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 text-amber-300">
        <Cpu className="w-5 h-5 flex-shrink-0" />
        <span className="text-sm">
          <strong>Local Connection Active</strong> — Backend Lock N/A.
          You are talking directly to hardware via USB.
        </span>
      </div>
    );
  }

  if (lock.isLockedByOther) {
    return (
      <div className="flex items-center gap-3 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-300">
        <ShieldAlert className="w-5 h-5 flex-shrink-0" />
        <span className="text-sm">
          <strong>{lock.lockHolder?.name || 'Another user'}</strong> has control of this page.
          Inputs are disabled to prevent conflicting commands.
        </span>
      </div>
    );
  }

  const transition = 'border-color 0.5s ease, background-color 0.5s ease, color 0.5s ease';

  if (lock.isLockedByMe) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-xl px-4 py-3"
        style={{ border: `1px solid ${wire}`, backgroundColor: wire.replace(/[\d.]+\)$/, '0.07)'), transition }}
      >
        <div className="flex items-center gap-3 text-white/70">
          <Lock className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm">You have control. Other tabs/users will see this page as locked.</span>
        </div>
        <div className="flex items-center gap-3">
          <TxBadge />
          <button
            onClick={lock.release}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap text-white/60 hover:text-white/80"
            style={{ border: `1px solid ${wire}`, backgroundColor: wire.replace(/[\d.]+\)$/, '0.12)') }}
          >
            <Unlock className="w-3 h-3" />
            Release
          </button>
        </div>
      </div>
    );
  }

  // Not locked by anyone
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-xl px-4 py-3"
      style={{ border: `1px solid ${wire}`, backgroundColor: wire.replace(/[\d.]+\)$/, '0.06)'), transition }}
    >
      <div className="flex items-center gap-3 text-white/50">
        <Unlock className="w-4 h-4 flex-shrink-0" />
        <span className="text-sm">No one has control. Take control to prevent conflicting inputs from other tabs.</span>
      </div>
      <div className="flex items-center gap-3">
        <TxBadge />
        <button
          onClick={lock.acquire}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap text-white/70 hover:text-white/90"
          style={{ border: `1px solid ${wire}`, backgroundColor: wire.replace(/[\d.]+\)$/, '0.12)') }}
        >
          <Lock className="w-3 h-3" />
          Take Control
        </button>
      </div>
    </div>
  );
}
