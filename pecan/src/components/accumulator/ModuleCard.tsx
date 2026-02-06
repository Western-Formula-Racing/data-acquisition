/**
 * ModuleCard Component
 * 
 * Combines CellGrid and ThermistorBar for a single accumulator module.
 * Expandable design with summary stats in collapsed state.
 * Updates at 1Hz for consistent page refresh rate.
 */

import { useState, useEffect } from 'react';
import { dataStore } from '../../lib/DataStore';
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

interface ModuleStats {
    voltageStats: {
        min: number;
        max: number;
        avg: number;
        diff: number;
        count: number;
    } | null;
    tempStats: {
        min: number;
        max: number;
        avg: number;
        count: number;
    } | null;
    alertLevel: AlertLevel;
}

// Hook to calculate module stats at 1Hz
function useModuleStats(moduleId: ModuleId): ModuleStats {
    const [stats, setStats] = useState<ModuleStats>({
        voltageStats: null,
        tempStats: null,
        alertLevel: 'normal',
    });

    useEffect(() => {
        const computeStats = () => {
            // Collect all cell voltages
            const cellReadings: number[] = [];
            for (let i = 1; i <= CELLS_PER_MODULE; i++) {
                const { msgId, signalName } = getCellSignalInfo(moduleId, i);
                const latest = dataStore.getLatest(msgId);
                const value = latest?.data[signalName]?.sensorReading;
                if (value !== undefined) cellReadings.push(value);
            }

            // Collect all thermistor readings
            const tempReadings: number[] = [];
            for (let i = 1; i <= THERMISTORS_PER_MODULE; i++) {
                const { msgId, signalName } = getThermistorSignalInfo(moduleId, i);
                const latest = dataStore.getLatest(msgId);
                const value = latest?.data[signalName]?.sensorReading;
                if (value !== undefined) tempReadings.push(value);
            }

            const voltageStats = cellReadings.length > 0 ? {
                min: Math.min(...cellReadings),
                max: Math.max(...cellReadings),
                avg: cellReadings.reduce((a, b) => a + b, 0) / cellReadings.length,
                diff: Math.max(...cellReadings) - Math.min(...cellReadings),
                count: cellReadings.length,
            } : null;

            const tempStats = tempReadings.length > 0 ? {
                min: Math.min(...tempReadings),
                max: Math.max(...tempReadings),
                avg: tempReadings.reduce((a, b) => a + b, 0) / tempReadings.length,
                count: tempReadings.length,
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

            setStats({ voltageStats, tempStats, alertLevel });
        };

        // Initial compute
        computeStats();

        // Update every 1 second
        const interval = setInterval(computeStats, 1000);

        return () => clearInterval(interval);
    }, [moduleId]);

    return stats;
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

                    <span className="text-white font-bold text-lg whitespace-nowrap">Module {moduleId.slice(1)}</span>
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
