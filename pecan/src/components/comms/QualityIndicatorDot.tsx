export type QualityLevel = 'good' | 'warning' | 'critical' | 'unknown';

const styles: Record<QualityLevel, string> = {
  good: 'bg-emerald-500 animate-pulse',
  warning: 'bg-amber-500 animate-pulse',
  critical: 'bg-rose-500 animate-pulse',
  unknown: 'bg-sidebarfg/50',
};

export default function QualityIndicatorDot({ level }: { level: QualityLevel }) {
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${styles[level]}`} />;
}
