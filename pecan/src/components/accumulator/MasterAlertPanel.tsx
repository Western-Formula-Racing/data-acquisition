/**
 * MasterAlertPanel Component
 * 
 * Airplane-style master caution panel showing critical system alerts.
 * Displays 4 main alert indicators: Voltage Diff, Over Temp, Imbalance, Low Voltage.
 */

import { useMemo } from 'react';
import { useSignal } from '../../lib/useDataStore';
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
                style={{ color: isActive ? bgColor : '#9ca3af' }}
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

// Hook to collect all readings and compute alert states
function useAlertStates() {
    // Collect all cell voltages across all modules
    const allVoltages: { sensor: string; value: number | null; moduleId: ModuleId }[] = [];
    const moduleAvgVoltages: { moduleId: ModuleId; avg: number }[] = [];

    for (const moduleId of MODULE_IDS) {
        const moduleVoltages: number[] = [];
        for (let i = 1; i <= CELLS_PER_MODULE; i++) {
            const { msgId, signalName } = getCellSignalInfo(moduleId, i);
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const signalData = useSignal(msgId, signalName);
            const value = signalData?.sensorReading ?? null;
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
            // eslint-disable-next-line react-hooks/rules-of-hooks
            const signalData = useSignal(msgId, signalName);
            allTemps.push({ sensor: signalName, value: signalData?.sensorReading ?? null, moduleId });
        }
    }

    return useMemo(() => {
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

        return {
            voltageDiff: voltageDiffState,
            overTemp: overTempState,
            imbalance: imbalanceState,
            lowVoltage: lowVoltageState,
        };
    }, [allVoltages, allTemps, moduleAvgVoltages]);
}

export default function MasterAlertPanel() {
    const alertStates = useAlertStates();

    // Overall status
    const overallLevel: AlertLevel =
        [alertStates.voltageDiff, alertStates.overTemp, alertStates.imbalance, alertStates.lowVoltage]
            .some(a => a.level === 'critical') ? 'critical' :
            [alertStates.voltageDiff, alertStates.overTemp, alertStates.imbalance, alertStates.lowVoltage]
                .some(a => a.level === 'warning') ? 'warning' : 'normal';

    return (
        <div className={`
      bg-data-module-bg rounded-lg p-4
      border-2 transition-all duration-300
      ${overallLevel === 'critical' ? 'border-red-500' :
                overallLevel === 'warning' ? 'border-orange-500' : 'border-gray-700'}
    `}>
            {/* Status indicator */}
            <div className="flex items-center justify-end mb-3">
                <span
                    className={`text-xs font-bold px-2 py-1 rounded ${overallLevel !== 'normal' ? 'animate-pulse' : ''}`}
                    style={{
                        backgroundColor: `${getAlertLevelColor(overallLevel)}20`,
                        color: getAlertLevelColor(overallLevel),
                    }}
                >
                    {overallLevel === 'critical' ? 'CRITICAL' : overallLevel === 'warning' ? 'WARNING' : 'ALL NORMAL'}
                </span>
            </div>

            {/* Alert indicators */}
            <div className="flex flex-wrap gap-3 justify-center">
                <AlertIndicator label="VOLT DIFF" state={alertStates.voltageDiff} />
                <AlertIndicator label="OVER TEMP" state={alertStates.overTemp} />
                <AlertIndicator label="IMBALANCE" state={alertStates.imbalance} />
                <AlertIndicator label="LOW VOLT" state={alertStates.lowVoltage} />
            </div>
        </div>
    );
}
