/**
 * ModuleCard Component
 * 
 * Combines CellGrid and ThermistorBar for a single accumulator module.
 * Expandable design with summary stats in collapsed state.
 */

import { useState, useMemo } from 'react';
import { useSignal } from '../../lib/useDataStore';
import CellGrid from './CellGrid';
import ThermistorBar from './ThermistorBar';
import {
    type ModuleId,
    CELLS_PER_MODULE,
    THERMISTORS_PER_MODULE,
    getCellSignalInfo,
    getThermistorSignalInfo,
    ALERT_THRESHOLDS,
    type AlertLevel,
    getAlertLevelColor,
} from './AccumulatorTypes';

interface ModuleCardProps {
    moduleId: ModuleId;
    initialOpen?: boolean;
}

// Hook to calculate module stats from all signals
function useModuleStats(moduleId: ModuleId) {
    // Collect all cell voltages
    const cellReadings: (number | null)[] = [];
    for (let i = 1; i <= CELLS_PER_MODULE; i++) {
        const { msgId, signalName } = getCellSignalInfo(moduleId, i);
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const signalData = useSignal(msgId, signalName);
        cellReadings.push(signalData?.sensorReading ?? null);
    }

    // Collect all thermistor readings
    const tempReadings: (number | null)[] = [];
    for (let i = 1; i <= THERMISTORS_PER_MODULE; i++) {
        const { msgId, signalName } = getThermistorSignalInfo(moduleId, i);
        // eslint-disable-next-line react-hooks/rules-of-hooks
        const signalData = useSignal(msgId, signalName);
        tempReadings.push(signalData?.sensorReading ?? null);
    }

    return useMemo(() => {
        const validVoltages = cellReadings.filter((r): r is number => r !== null);
        const validTemps = tempReadings.filter((r): r is number => r !== null);

        const voltageStats = validVoltages.length > 0 ? {
            min: Math.min(...validVoltages),
            max: Math.max(...validVoltages),
            avg: validVoltages.reduce((a, b) => a + b, 0) / validVoltages.length,
            diff: Math.max(...validVoltages) - Math.min(...validVoltages),
            count: validVoltages.length,
        } : null;

        const tempStats = validTemps.length > 0 ? {
            min: Math.min(...validTemps),
            max: Math.max(...validTemps),
            avg: validTemps.reduce((a, b) => a + b, 0) / validTemps.length,
            count: validTemps.length,
        } : null;

        // Determine alert level
        let alertLevel: AlertLevel = 'normal';

        if (voltageStats) {
            if (voltageStats.diff >= ALERT_THRESHOLDS.voltageDiff.critical ||
                voltageStats.min < ALERT_THRESHOLDS.lowVoltage.critical) {
                alertLevel = 'critical';
            } else if (voltageStats.diff >= ALERT_THRESHOLDS.voltageDiff.warning ||
                voltageStats.min < ALERT_THRESHOLDS.lowVoltage.warning) {
                alertLevel = 'warning';
            }
        }

        if (tempStats && alertLevel !== 'critical') {
            if (tempStats.max >= ALERT_THRESHOLDS.overTemp.critical) {
                alertLevel = 'critical';
            } else if (tempStats.max >= ALERT_THRESHOLDS.overTemp.warning && alertLevel !== 'warning') {
                alertLevel = 'warning';
            }
        }

        return { voltageStats, tempStats, alertLevel };
    }, [cellReadings, tempReadings]);
}

export default function ModuleCard({ moduleId, initialOpen = false }: ModuleCardProps) {
    const [isOpen, setIsOpen] = useState(initialOpen);
    const { voltageStats, tempStats, alertLevel } = useModuleStats(moduleId);

    const statusColor = getAlertLevelColor(alertLevel);
    const hasData = voltageStats !== null || tempStats !== null;

    return (
        <div
            className={`
        bg-data-module-bg rounded-lg overflow-hidden
        border-2 transition-all duration-300
        ${alertLevel === 'critical' ? 'border-red-500 animate-alert-pulse' :
                    alertLevel === 'warning' ? 'border-orange-500' : 'border-gray-700'}
      `}
        >
            {/* Header - always visible */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full p-3 flex items-center justify-between hover:bg-data-textbox-bg/30 transition-colors"
            >
                <div className="flex items-center gap-3">
                    {/* Status indicator */}
                    <div
                        className={`w-3 h-3 rounded-full ${alertLevel !== 'normal' ? 'animate-pulse' : ''}`}
                        style={{ backgroundColor: statusColor }}
                    />

                    <span className="text-white font-bold text-lg">Module {moduleId.slice(1)}</span>
                </div>

                {/* Summary stats */}
                <div className="flex items-center gap-4 text-xs font-mono">
                    {voltageStats ? (
                        <>
                            <span className="text-gray-400">
                                Avg: <span className="text-green-400">{voltageStats.avg.toFixed(3)}V</span>
                            </span>
                            <span className="text-gray-400">
                                Δ: <span className={voltageStats.diff >= ALERT_THRESHOLDS.voltageDiff.warning ? 'text-orange-400' : 'text-white'}>
                                    {voltageStats.diff.toFixed(3)}V
                                </span>
                            </span>
                        </>
                    ) : (
                        <span className="text-gray-500">No voltage data</span>
                    )}

                    {tempStats && (
                        <span className="text-gray-400">
                            T: <span className={tempStats.max >= ALERT_THRESHOLDS.overTemp.warning ? 'text-orange-400' : 'text-white'}>
                                {tempStats.max.toFixed(1)}°C
                            </span>
                        </span>
                    )}

                    {/* Expand indicator */}
                    <span className={`text-gray-400 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}>
                        ▼
                    </span>
                </div>
            </button>

            {/* Expandable content - using grid for smooth height animation */}
            <div className="grid transition-[grid-template-rows] duration-300 ease-in-out"
                style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}>
                <div className="overflow-hidden">
                    <div className="p-3 pt-0 space-y-3">
                        {hasData ? (
                            <>
                                {/* Cell voltage grid */}
                                <div>
                                    <h4 className="text-xs text-white mb-1 font-semibold">Cell Voltages</h4>
                                    <CellGrid moduleId={moduleId} />
                                </div>

                                {/* Thermistor bar */}
                                <div>
                                    <h4 className="text-xs text-white mb-1 font-semibold">Thermistors</h4>
                                    <ThermistorBar moduleId={moduleId} />
                                </div>
                            </>
                        ) : (
                            <div className="text-center text-gray-500 py-4">
                                Waiting for data...
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
