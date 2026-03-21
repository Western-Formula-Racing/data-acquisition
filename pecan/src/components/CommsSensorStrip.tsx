import { useSignal } from '../lib/useDataStore';
import { Activity, AlertTriangle } from 'lucide-react';

export interface CommsSensorConfig {
    msgID: string;
    signalName: string;
}

const STORAGE_KEY = 'comms_pinned_sensors';

export function loadPinnedSensors(): CommsSensorConfig[] {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch {
        return [];
    }
}

export function savePinnedSensors(sensors: CommsSensorConfig[]) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sensors));
}

function SensorChip({ msgID, signalName }: CommsSensorConfig) {
    const data = useSignal(msgID, signalName);

    return (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-data-textbox-bg border border-sidebarfg/15 min-w-0">
            <Activity className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
            <span className="text-xs text-sidebarfg font-footer truncate">{signalName}</span>
            {data ? (
                <span className="text-sm font-bold uppercase tracking-wider text-white/90 whitespace-nowrap">
                    {data.sensorReading} <span className="text-xs text-sidebarfg">{data.unit}</span>
                </span>
            ) : (
                <span className="flex items-center gap-1 text-xs text-amber-400">
                    <AlertTriangle className="w-3 h-3" />
                    N/A
                </span>
            )}
        </div>
    );
}

export default function CommsSensorStrip({ sensors }: { sensors: CommsSensorConfig[] }) {
    if (sensors.length === 0) return null;

    return (
        <div className="flex gap-2 flex-wrap">
            {sensors.map((s, i) => (
                <SensorChip key={`${s.msgID}-${s.signalName}-${i}`} {...s} />
            ))}
        </div>
    );
}
