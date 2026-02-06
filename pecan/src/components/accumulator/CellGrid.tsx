/**
 * CellGrid Component
 * 
 * Displays 20 cell voltages in a 5×4 grid with color-coded heatmap visualization.
 * Each cell shows voltage value with color ranging from green (nominal) to red (out of range).
 * Updates at 1Hz to reduce power consumption, showing 1s min/max in tooltip.
 */

import { useMemo, useState, useEffect, useRef } from 'react';
import { dataStore } from '../../lib/DataStore';
import {
    type ModuleId,
    CELLS_PER_MODULE,
    getCellSignalInfo,
    getVoltageColor,
    ALERT_THRESHOLDS,
} from './AccumulatorTypes';

interface CellGridProps {
    moduleId: ModuleId;
}

interface CellStats {
    current: number | null;
    min: number | null;
    max: number | null;
}

// Individual cell component with 1s throttled updates
function Cell({ moduleId, cellIndex, stats }: {
    moduleId: ModuleId;
    cellIndex: number;
    stats: CellStats;
}) {
    const { signalName } = getCellSignalInfo(moduleId, cellIndex);

    const { current, min, max } = stats;
    const bgColor = getVoltageColor(current);

    const isWarning = current !== null && (
        current < ALERT_THRESHOLDS.lowVoltage.warning ||
        current > ALERT_THRESHOLDS.nominalVoltage.max
    );

    const isCritical = current !== null && (
        current < ALERT_THRESHOLDS.lowVoltage.critical ||
        current < ALERT_THRESHOLDS.nominalVoltage.min
    );

    // Tooltip with 1s min/max range
    const range = min !== null && max !== null
        ? `${min.toFixed(3)}V - ${max.toFixed(3)}V`
        : 'No data';

    return (
        <div
            className={`
        relative flex items-center justify-center
        rounded-sm text-xs font-mono font-semibold
        cursor-default
        ${isCritical ? 'animate-alert-pulse' : isWarning ? 'animate-warning-pulse' : ''}
      `}
            style={{ backgroundColor: bgColor }}
            title={`${signalName}\nCurrent: ${current !== null ? `${current.toFixed(3)}V` : '--'}\n1s range: ${range}`}
        >
            <span className="text-white drop-shadow-md text-[10px]">
                {current !== null ? current.toFixed(2) : '---'}
            </span>
        </div>
    );
}

// Hook to get all cell stats with 1s throttled updates
function useCellStats(moduleId: ModuleId): Map<number, CellStats> {
    const [cellStats, setCellStats] = useState<Map<number, CellStats>>(new Map());
    const statsAccumulator = useRef<Map<number, number[]>>(new Map());

    useEffect(() => {
        // Update stats every 1 second
        const interval = setInterval(() => {
            const newStats = new Map<number, CellStats>();

            for (let i = 1; i <= CELLS_PER_MODULE; i++) {
                const { msgId, signalName } = getCellSignalInfo(moduleId, i);
                const latest = dataStore.getLatest(msgId);
                const current = latest?.data[signalName]?.sensorReading ?? null;

                // Get accumulated readings for min/max
                const accumulated = statsAccumulator.current.get(i) || [];
                if (current !== null) {
                    accumulated.push(current);
                }

                const min = accumulated.length > 0 ? Math.min(...accumulated) : null;
                const max = accumulated.length > 0 ? Math.max(...accumulated) : null;

                newStats.set(i, { current, min, max });

                // Reset accumulator for next second
                statsAccumulator.current.set(i, current !== null ? [current] : []);
            }

            setCellStats(newStats);
        }, 1000);

        // Also accumulate samples between updates
        const unsubscribe = dataStore.subscribe((updatedMsgId) => {
            if (!updatedMsgId) return;

            for (let i = 1; i <= CELLS_PER_MODULE; i++) {
                const { msgId, signalName } = getCellSignalInfo(moduleId, i);
                if (msgId === updatedMsgId) {
                    const latest = dataStore.getLatest(msgId);
                    const value = latest?.data[signalName]?.sensorReading;
                    if (value !== undefined) {
                        const accumulated = statsAccumulator.current.get(i) || [];
                        accumulated.push(value);
                        statsAccumulator.current.set(i, accumulated);
                    }
                }
            }
        });

        return () => {
            clearInterval(interval);
            unsubscribe();
        };
    }, [moduleId]);

    return cellStats;
}

export default function CellGrid({ moduleId }: CellGridProps) {
    const cellIndices = useMemo(() =>
        Array.from({ length: CELLS_PER_MODULE }, (_, i) => i + 1),
        []
    );

    const cellStats = useCellStats(moduleId);

    return (
        <div className="grid grid-cols-5 grid-rows-4 gap-1 w-full aspect-[5/4]">
            {cellIndices.map((cellIndex) => (
                <Cell
                    key={cellIndex}
                    moduleId={moduleId}
                    cellIndex={cellIndex}
                    stats={cellStats.get(cellIndex) || { current: null, min: null, max: null }}
                />
            ))}
        </div>
    );
}
