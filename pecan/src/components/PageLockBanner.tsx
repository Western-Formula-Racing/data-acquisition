import { Lock, Unlock, ShieldAlert } from 'lucide-react';
import { type PageLockState } from '../lib/usePageLock';

interface PageLockBannerProps {
  lock: PageLockState;
}

/**
 * Shows lock status and controls for pages with mutual-exclusion requirements.
 * - Not locked: "Take control" button
 * - Locked by me: "Release control" button + green indicator
 * - Locked by someone else: red warning banner
 */
export function PageLockBanner({ lock }: PageLockBannerProps) {
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

  if (lock.isLockedByMe) {
    return (
      <div className="flex items-center justify-between gap-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3">
        <div className="flex items-center gap-3 text-emerald-300">
          <Lock className="w-4 h-4 flex-shrink-0" />
          <span className="text-sm">You have control. Other tabs/users will see this page as locked.</span>
        </div>
        <button
          onClick={lock.release}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 rounded-lg text-emerald-300 transition-colors whitespace-nowrap"
        >
          <Unlock className="w-3 h-3" />
          Release
        </button>
      </div>
    );
  }

  // Not locked by anyone
  return (
    <div className="flex items-center justify-between gap-3 bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3">
      <div className="flex items-center gap-3 text-slate-400">
        <Unlock className="w-4 h-4 flex-shrink-0" />
        <span className="text-sm">No one has control. Take control to prevent conflicting inputs from other tabs.</span>
      </div>
      <button
        onClick={lock.acquire}
        className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 rounded-lg text-blue-300 transition-colors whitespace-nowrap"
      >
        <Lock className="w-3 h-3" />
        Take Control
      </button>
    </div>
  );
}
