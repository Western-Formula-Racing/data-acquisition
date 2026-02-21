import { Zap, Battery, BatteryCharging } from 'lucide-react';
import { useSignal } from '../../lib/useDataStore';

// Assuming BMS_Status ID is 512 based on example.dbc
const BMS_STATUS_ID = "512";
const CURRENT_SIGNAL = "PackCurrent";

// Thresholds in Amps
const CHARGING_THRESHOLD = -0.5; // Negative current means charging (usually)
const DISCHARGING_THRESHOLD = 0.5; // Positive current means discharging

export function BatteryStatus() {
    const signal = useSignal(BMS_STATUS_ID, CURRENT_SIGNAL);
    const current = signal?.sensorReading ?? null;

    // Determine state
    let icon = <Battery className="w-6 h-6 text-gray-400" />;
    let label = "Static";
    let colorClass = "text-gray-400";

    if (current !== null) {
        if (current < CHARGING_THRESHOLD) {
            icon = <BatteryCharging className="w-6 h-6 animate-pulse" />;
            label = "Charging";
            colorClass = "text-green-500";
        } else if (current > DISCHARGING_THRESHOLD) {
            icon = <Zap className="w-6 h-6" />;
            label = "Discharging";
            colorClass = "text-orange-500";
        } else {
            // Static
            icon = <Battery className="w-6 h-6" />;
            label = "Standby";
            colorClass = "text-blue-400";
        }
    }

    return (
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800/50 border border-gray-700/50 ${colorClass}`} title={`Current: ${current?.toFixed(1) ?? '--'} A`}>
            {icon}
            <span className="text-sm font-semibold uppercase tracking-wider">
                {label}
            </span>
            {current !== null && (
                <span className="text-xs text-gray-500 ml-1 font-mono">
                    ({current.toFixed(1)} A)
                </span>
            )}
        </div>
    );
}
