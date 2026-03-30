/**
 * MasterAlertPanel Component
 * 
 * Airplane-style master caution panel showing critical system alerts.
 * Displays 4 main alert indicators: Voltage Diff, Over Temp, Imbalance, Low Voltage.
 */

import { useState, useEffect } from 'react';
import { dataStore } from '../../lib/DataStore';
import { useAccumulatorContext } from './AccumulatorContext';
import {
    MODULE_IDS,
    type ModuleId,
    CELLS_PER_MODULE,
    THERMISTORS_PER_MODULE,
    getCellSignalInfo,
    getThermistorSignalInfo,
    ALERT_THRESHOLDS,
    type AlertLevel,
    type AlertState,
    getAlertLevelColor,
} from './AccumulatorTypes';

interface AlertIndicatorProps {
    label: string;
    state: AlertState;
    onClick?: () => void;
}

function AlertIndicator({ label, state, onClick }: AlertIndicatorProps) {
    const bgColor = getAlertLevelColor(state.level);
    const isActive = state.level !== 'normal';

    return (
        <button
            onClick={onClick}
            className={`
        relative flex flex-col items-center justify-center
        px-4 py-3 rounded-lg min-w-[100px]
        border-2 transition-all duration-300
        ${isActive ? 'animate-alert-pulse cursor-pointer hover:scale-105' : 'cursor-default'}
      `}
            style={{
                backgroundColor: `${bgColor}20`,
                borderColor: bgColor,
            }}
            title={state.message || label}
        >
            {/* Alert light */}
            <div
                className={`w-4 h-4 rounded-full mb-1 ${isActive ? 'animate-pulse' : ''}`}
                style={{ backgroundColor: bgColor, boxShadow: isActive ? `0 0 10px ${bgColor}` : 'none' }}
            />

            {/* Label */}
            <span
                className="text-xs font-bold tracking-wide"
                style={{ color: isActive ? bgColor : 'var(--color-text-muted)' }}
            >
                {label}
            </span>

            {/* Affected count badge */}
            {state.affectedSensors && state.affectedSensors.length > 0 && (
                <span
                    className="absolute -top-1 -right-1 w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center text-white"
                    style={{ backgroundColor: bgColor }}
                >
                    {state.affectedSensors.length}
                </span>
            )}
        </button>
    );
}

// Hook to collect all readings and compute alert states at 1Hz
function useAlertStates() {
    const [alertData, setAlertData] = useState<{
        voltageDiff: AlertState;
        overTemp: AlertState;
        imbalance: AlertState;
        lowVoltage: AlertState;
        packStats: {
            maxVoltage: { value: number; moduleId: ModuleId; index: number; label: string } | null;
            minVoltage: { value: number; moduleId: ModuleId; index: number; label: string } | null;
            maxTemp: { value: number; moduleId: ModuleId; index: number; label: string } | null;
            minTemp: { value: number; moduleId: ModuleId; index: number; label: string } | null;
            cellDelta: number | null;
            avgVoltage: number | null;
        };
    }>({
        voltageDiff: { level: 'normal' },
        overTemp: { level: 'normal' },
        imbalance: { level: 'normal' },
        lowVoltage: { level: 'normal' },
        packStats: {
            maxVoltage: null,
            minVoltage: null,
            maxTemp: null,
            minTemp: null,
            cellDelta: null,
            avgVoltage: null,
        },
    });

    useEffect(() => {
        const computeAlerts = () => {
            // Collect all cell voltages across all modules
            const allVoltages: { sensor: string; value: number | null; moduleId: ModuleId }[] = [];
            const moduleAvgVoltages: { moduleId: ModuleId; avg: number }[] = [];

            for (const moduleId of MODULE_IDS) {
                const moduleVoltages: number[] = [];
                for (let i = 1; i <= CELLS_PER_MODULE; i++) {
                    const { msgId, signalName } = getCellSignalInfo(moduleId, i);
                    const latest = dataStore.getLatest(msgId);
                    const value = latest?.data[signalName]?.sensorReading ?? null;
                    allVoltages.push({ sensor: signalName, value, moduleId });
                    if (value !== null) moduleVoltages.push(value);
                }

                if (moduleVoltages.length > 0) {
                    const avg = moduleVoltages.reduce((a, b) => a + b, 0) / moduleVoltages.length;
                    moduleAvgVoltages.push({ moduleId, avg });
                }
            }

            // Collect all thermistor readings
            const allTemps: { sensor: string; value: number | null; moduleId: ModuleId }[] = [];

            for (const moduleId of MODULE_IDS) {
                for (let i = 1; i <= THERMISTORS_PER_MODULE; i++) {
                    const { msgId, signalName } = getThermistorSignalInfo(moduleId, i);
                    const latest = dataStore.getLatest(msgId);
                    allTemps.push({ sensor: signalName, value: latest?.data[signalName]?.sensorReading ?? null, moduleId });
                }
            }

            const validVoltages = allVoltages.filter((v) => v.value !== null) as { sensor: string; value: number; moduleId: ModuleId }[];
            const validTemps = allTemps.filter((t) => t.value !== null) as { sensor: string; value: number; moduleId: ModuleId }[];

            // 1. Voltage Difference Alert
            let voltageDiffState: AlertState = { level: 'normal' };
            if (validVoltages.length > 1) {
                const minV = Math.min(...validVoltages.map(v => v.value));
                const maxV = Math.max(...validVoltages.map(v => v.value));
                const diff = maxV - minV;

                if (diff >= ALERT_THRESHOLDS.voltageDiff.critical) {
                    voltageDiffState = {
                        level: 'critical',
                        message: `Max voltage difference: ${diff.toFixed(3)}V`,
                        affectedSensors: validVoltages
                            .filter(v => v.value === minV || v.value === maxV)
                            .map(v => v.sensor),
                    };
                } else if (diff >= ALERT_THRESHOLDS.voltageDiff.warning) {
                    voltageDiffState = {
                        level: 'warning',
                        message: `Voltage difference: ${diff.toFixed(3)}V`,
                    };
                }
            }

            // 2. Over Temperature Alert
            let overTempState: AlertState = { level: 'normal' };
            if (validTemps.length > 0) {
                const criticalTemps = validTemps.filter(t => t.value >= ALERT_THRESHOLDS.overTemp.critical);
                const warningTemps = validTemps.filter(t => t.value >= ALERT_THRESHOLDS.overTemp.warning && t.value < ALERT_THRESHOLDS.overTemp.critical);

                if (criticalTemps.length > 0) {
                    overTempState = {
                        level: 'critical',
                        message: `${criticalTemps.length} sensor(s) over ${ALERT_THRESHOLDS.overTemp.critical}°C`,
                        affectedSensors: criticalTemps.map(t => t.sensor),
                    };
                } else if (warningTemps.length > 0) {
                    overTempState = {
                        level: 'warning',
                        message: `${warningTemps.length} sensor(s) over ${ALERT_THRESHOLDS.overTemp.warning}°C`,
                        affectedSensors: warningTemps.map(t => t.sensor),
                    };
                }
            }

            // 3. Module Imbalance Alert
            let imbalanceState: AlertState = { level: 'normal' };
            if (moduleAvgVoltages.length > 1) {
                const avgVals = moduleAvgVoltages.map(m => m.avg);
                const minAvg = Math.min(...avgVals);
                const maxAvg = Math.max(...avgVals);
                const imbalance = maxAvg - minAvg;

                if (imbalance >= ALERT_THRESHOLDS.moduleImbalance.critical) {
                    imbalanceState = {
                        level: 'critical',
                        message: `Module imbalance: ${imbalance.toFixed(3)}V`,
                        affectedSensors: moduleAvgVoltages
                            .filter(m => m.avg === minAvg || m.avg === maxAvg)
                            .map(m => m.moduleId),
                    };
                } else if (imbalance >= ALERT_THRESHOLDS.moduleImbalance.warning) {
                    imbalanceState = {
                        level: 'warning',
                        message: `Module imbalance: ${imbalance.toFixed(3)}V`,
                    };
                }
            }

            // 4. Low Voltage Alert
            let lowVoltageState: AlertState = { level: 'normal' };
            if (validVoltages.length > 0) {
                const criticalLow = validVoltages.filter(v => v.value < ALERT_THRESHOLDS.lowVoltage.critical);
                const warningLow = validVoltages.filter(v => v.value < ALERT_THRESHOLDS.lowVoltage.warning && v.value >= ALERT_THRESHOLDS.lowVoltage.critical);

                if (criticalLow.length > 0) {
                    lowVoltageState = {
                        level: 'critical',
                        message: `${criticalLow.length} cell(s) below ${ALERT_THRESHOLDS.lowVoltage.critical}V`,
                        affectedSensors: criticalLow.map(v => v.sensor),
                    };
                } else if (warningLow.length > 0) {
                    lowVoltageState = {
                        level: 'warning',
                        message: `${warningLow.length} cell(s) below ${ALERT_THRESHOLDS.lowVoltage.warning}V`,
                        affectedSensors: warningLow.map(v => v.sensor),
                    };
                }
            }

            // Calculate pack-wide summary stats with cell locations
            const validVoltageValues = validVoltages.map(v => v.value);

            // Find max/min voltage cells
            const maxVoltageCell = validVoltages.reduce<{ sensor: string; value: number; moduleId: ModuleId } | null>(
                (max, v) => (!max || v.value > max.value) ? v : max, null
            );
            const minVoltageCell = validVoltages.reduce<{ sensor: string; value: number; moduleId: ModuleId } | null>(
                (min, v) => (!min || v.value < min.value) ? v : min, null
            );

            // Find max/min temp thermistors
            const maxTempSensor = validTemps.reduce<{ sensor: string; value: number; moduleId: ModuleId } | null>(
                (max, t) => (!max || t.value > max.value) ? t : max, null
            );
            const minTempSensor = validTemps.reduce<{ sensor: string; value: number; moduleId: ModuleId } | null>(
                (min, t) => (!min || t.value < min.value) ? t : min, null
            );

            // Helper to extract cell/thermistor index from signal name
            const extractIndex = (sensor: string, type: 'cell' | 'thermistor'): number => {
                const match = type === 'cell'
                    ? sensor.match(/Cell(\d+)/)
                    : sensor.match(/Thermistor(\d+)/);
                return match ? parseInt(match[1], 10) : 0;
            };

            // Create short cell names for display
            const formatCellName = (moduleId: ModuleId, index: number): string => `${moduleId}C${index}`;
            const formatThermName = (moduleId: ModuleId, index: number): string => `${moduleId}T${index}`;

            const packStats = {
                maxVoltage: maxVoltageCell ? {
                    value: maxVoltageCell.value,
                    moduleId: maxVoltageCell.moduleId,
                    index: extractIndex(maxVoltageCell.sensor, 'cell'),
                    label: formatCellName(maxVoltageCell.moduleId, extractIndex(maxVoltageCell.sensor, 'cell')),
                } : null,
                minVoltage: minVoltageCell ? {
                    value: minVoltageCell.value,
                    moduleId: minVoltageCell.moduleId,
                    index: extractIndex(minVoltageCell.sensor, 'cell'),
                    label: formatCellName(minVoltageCell.moduleId, extractIndex(minVoltageCell.sensor, 'cell')),
                } : null,
                maxTemp: maxTempSensor ? {
                    value: maxTempSensor.value,
                    moduleId: maxTempSensor.moduleId,
                    index: extractIndex(maxTempSensor.sensor, 'thermistor'),
                    label: formatThermName(maxTempSensor.moduleId, extractIndex(maxTempSensor.sensor, 'thermistor')),
                } : null,
                minTemp: minTempSensor ? {
                    value: minTempSensor.value,
                    moduleId: minTempSensor.moduleId,
                    index: extractIndex(minTempSensor.sensor, 'thermistor'),
                    label: formatThermName(minTempSensor.moduleId, extractIndex(minTempSensor.sensor, 'thermistor')),
                } : null,
                cellDelta: validVoltageValues.length > 1
                    ? Math.max(...validVoltageValues) - Math.min(...validVoltageValues)
                    : null,
                avgVoltage: validVoltageValues.length > 0
                    ? validVoltageValues.reduce((a, b) => a + b, 0) / validVoltageValues.length
                    : null,
            };

            setAlertData({
                voltageDiff: voltageDiffState,
                overTemp: overTempState,
                imbalance: imbalanceState,
                lowVoltage: lowVoltageState,
                packStats,
            });
        };

        // Initial compute
        computeAlerts();

        // Update every 1 second
        const interval = setInterval(computeAlerts, 1000);

        return () => clearInterval(interval);
    }, []);

    return alertData;
}

export default function MasterAlertPanel() {
    const alertStates = useAlertStates();
    const { setHighlightTarget } = useAccumulatorContext();

    // Overall status
    const overallLevel: AlertLevel =
        [alertStates.voltageDiff, alertStates.overTemp, alertStates.imbalance, alertStates.lowVoltage]
            .some(a => a.level === 'critical') ? 'critical' :
            [alertStates.voltageDiff, alertStates.overTemp, alertStates.imbalance, alertStates.lowVoltage]
                .some(a => a.level === 'warning') ? 'warning' : 'normal';
    const { packStats } = alertStates;

    // Determine stat colors based on thresholds
    const tempColor = packStats.maxTemp !== null && packStats.maxTemp.value >= ALERT_THRESHOLDS.overTemp.critical
        ? '#ef4444' : packStats.maxTemp !== null && packStats.maxTemp.value >= ALERT_THRESHOLDS.overTemp.warning
            ? '#f97316' : '#22c55e';

    const deltaColor = packStats.cellDelta !== null && packStats.cellDelta >= ALERT_THRESHOLDS.voltageDiff.critical
        ? '#ef4444' : packStats.cellDelta !== null && packStats.cellDelta >= ALERT_THRESHOLDS.voltageDiff.warning
            ? '#f97316' : '#22c55e';

    // Stat card component for mobile-friendly touch targets
    const StatCard = ({ label, value, sublabel, color, onClick, id }: {
        label: string;
        value: string;
        sublabel?: string;
        color: string;
        onClick?: () => void;
        id?: string;
    }) => (
        <button
            id={id}
            onClick={onClick}
            disabled={!onClick}
            className={`
                flex-1 min-w-[80px] p-3 rounded-lg
                bg-black/30 border border-gray-600
                transition-all duration-200
                ${onClick ? 'active:scale-95 hover:border-gray-400 cursor-pointer' : 'cursor-default'}
            `}
        >
            <div className="text-gray-400 text-[10px] font-semibold tracking-wide">{label}</div>
            <div className="font-mono font-bold text-lg" style={{ color }}>{value}</div>
            {sublabel && (
                <div className="text-gray-500 text-[9px] font-mono truncate">{sublabel}</div>
            )}
        </button>
    );

    const handleCellClick = (stats: { moduleId: ModuleId; index: number }[] | { moduleId: ModuleId; index: number } | null) => {
        if (stats) {
            const targets = Array.isArray(stats) ? stats : [stats];
            setHighlightTarget(targets.map(s => ({ moduleId: s.moduleId, index: s.index, type: 'cell' })));
        }
    };

    const handleThermClick = (stat: { moduleId: ModuleId; index: number } | null) => {
        if (stat) {
            setHighlightTarget({ moduleId: stat.moduleId, index: stat.index, type: 'thermistor' });
        }
    };

    return (
        <div className={`
      bg-data-module-bg rounded-lg p-3
      border-2 transition-all duration-300
      ${overallLevel === 'critical' ? 'border-red-500' :
                overallLevel === 'warning' ? 'border-orange-500' : 'border-gray-700'}
    `}>
            {/* Pack Summary Stats - Mobile-friendly grid */}
            <div className="grid grid-cols-3 gap-2 mb-3">
                {/* Max Temperature */}
                <StatCard
                    label="MAX TEMP"
                    value={packStats.maxTemp !== null ? `${packStats.maxTemp.value.toFixed(1)}°` : '--'}
                    sublabel={packStats.maxTemp?.label}
                    color={tempColor}
                    onClick={() => handleThermClick(packStats.maxTemp)}
                />

                {/* Cell Delta */}
                <StatCard
                    id="accu-delta-stat"
                    label="CELL Δ"
                    value={packStats.cellDelta !== null ? `${(packStats.cellDelta * 1000).toFixed(0)}mV` : '--'}
                    sublabel={packStats.minVoltage && packStats.maxVoltage
                        ? `${packStats.minVoltage.label}↔${packStats.maxVoltage.label}`
                        : undefined}
                    color={deltaColor}
                    onClick={() => handleCellClick([packStats.minVoltage, packStats.maxVoltage].filter((x): x is NonNullable<typeof x> => x !== null))}
                />

                {/* Average Voltage */}
                <StatCard
                    label="AVG"
                    value={packStats.avgVoltage !== null ? `${packStats.avgVoltage.toFixed(2)}V` : '--'}
                    color="#22c55e"
                />
            </div>

            {/* Min/Max Values Row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
                <StatCard
                    label="MIN V"
                    value={packStats.minVoltage !== null ? `${packStats.minVoltage.value.toFixed(3)}` : '--'}
                    sublabel={packStats.minVoltage?.label}
                    color={packStats.minVoltage && packStats.minVoltage.value < ALERT_THRESHOLDS.lowVoltage.warning
                        ? '#f97316' : '#22c55e'}
                    onClick={() => handleCellClick(packStats.minVoltage)}
                />
                <StatCard
                    label="MAX V"
                    value={packStats.maxVoltage !== null ? `${packStats.maxVoltage.value.toFixed(3)}` : '--'}
                    sublabel={packStats.maxVoltage?.label}
                    color="#22c55e"
                    onClick={() => handleCellClick(packStats.maxVoltage)}
                />
                <StatCard
                    label="MIN T"
                    value={packStats.minTemp !== null ? `${packStats.minTemp.value.toFixed(1)}°` : '--'}
                    sublabel={packStats.minTemp?.label}
                    color="#22c55e"
                    onClick={() => handleThermClick(packStats.minTemp)}
                />
                <StatCard
                    label="MAX T"
                    value={packStats.maxTemp !== null ? `${packStats.maxTemp.value.toFixed(1)}°` : '--'}
                    sublabel={packStats.maxTemp?.label}
                    color={tempColor}
                    onClick={() => handleThermClick(packStats.maxTemp)}
                />
            </div>

            {/* Alert indicators row */}
            <div className="flex flex-wrap gap-2">
                <AlertIndicator label="VOLT Δ" state={alertStates.voltageDiff} />
                <AlertIndicator label="TEMP" state={alertStates.overTemp} />
                <AlertIndicator label="BAL" state={alertStates.imbalance} />
                <AlertIndicator label="LOW" state={alertStates.lowVoltage} />
            </div>
        </div>
    );
}
