/**
 * ThermistorBar Component
 * 
 * Displays 18 thermistor readings as a horizontal bar with temperature-based coloring.
 * Shows min/avg/max temperatures and highlights hot spots.
 * Updates at 1Hz to reduce power consumption.
 */

import { useMemo, useState, useEffect, useRef } from 'react';
import { dataStore } from '../../lib/DataStore';
import {
    type ModuleId,
    THERMISTORS_PER_MODULE,
    getThermistorSignalInfo,
    getTemperatureColor,
    ALERT_THRESHOLDS,
} from './AccumulatorTypes';

interface ThermistorBarProps {
    moduleId: ModuleId;
}

interface AggregateStats {
    min: number | null;
    max: number | null;
    avg: number | null;
    count: number;
}

// Individual thermistor segment (display-only, receives stats from parent)
function ThermistorSegment({ moduleId, thermistorIndex, temp }: {
    moduleId: ModuleId;
    thermistorIndex: number;
    temp: number | null;
}) {
    const { signalName } = getThermistorSignalInfo(moduleId, thermistorIndex);

    const bgColor = getTemperatureColor(temp);
    const isCritical = temp !== null && temp >= ALERT_THRESHOLDS.overTemp.critical;
    const isWarning = temp !== null && temp >= ALERT_THRESHOLDS.overTemp.warning;

    return (
        <div
            className={`
        flex-1 h-6 first:rounded-l last:rounded-r
        cursor-default
        ${isCritical ? 'animate-alert-pulse' : isWarning ? 'animate-warning-pulse' : ''}
      `}
            style={{ backgroundColor: bgColor }}
            title={`${signalName}: ${temp !== null ? `${temp.toFixed(1)}°C` : 'No data'}`}
        />
    );
}

// Hook to get all thermistor readings with 1s throttled updates
function useThermistorStats(moduleId: ModuleId): {
    readings: Map<number, number | null>;
    aggregate: AggregateStats;
} {
    const [readings, setReadings] = useState<Map<number, number | null>>(new Map());
    const statsAccumulator = useRef<Map<number, number[]>>(new Map());

    useEffect(() => {
        // Update stats every 1 second
        const interval = setInterval(() => {
            const newReadings = new Map<number, number | null>();
            const validTemps: number[] = [];

            for (let i = 1; i <= THERMISTORS_PER_MODULE; i++) {
                const { msgId, signalName } = getThermistorSignalInfo(moduleId, i);
                const latest = dataStore.getLatest(msgId);
                const current = latest?.data[signalName]?.sensorReading ?? null;

                newReadings.set(i, current);
                if (current !== null) {
                    validTemps.push(current);
                }

                // Reset accumulator for next second
                statsAccumulator.current.set(i, current !== null ? [current] : []);
            }

            setReadings(newReadings);
        }, 1000);

        // Accumulate samples between updates
        const unsubscribe = dataStore.subscribe((updatedMsgId) => {
            if (!updatedMsgId) return;

            for (let i = 1; i <= THERMISTORS_PER_MODULE; i++) {
                const { msgId, signalName } = getThermistorSignalInfo(moduleId, i);
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

    const aggregate = useMemo(() => {
        const validReadings = Array.from(readings.values()).filter((r): r is number => r !== null);
        if (validReadings.length === 0) {
            return { min: null, max: null, avg: null, count: 0 };
        }

        return {
            min: Math.min(...validReadings),
            max: Math.max(...validReadings),
            avg: validReadings.reduce((a, b) => a + b, 0) / validReadings.length,
            count: validReadings.length,
        };
    }, [readings]);

    return { readings, aggregate };
}

export default function ThermistorBar({ moduleId }: ThermistorBarProps) {
    const thermistorIndices = useMemo(() =>
        Array.from({ length: THERMISTORS_PER_MODULE }, (_, i) => i + 1),
        []
    );

    const { readings, aggregate } = useThermistorStats(moduleId);

    const maxTempLevel = aggregate.max !== null
        ? aggregate.max >= ALERT_THRESHOLDS.overTemp.critical
            ? 'critical'
            : aggregate.max >= ALERT_THRESHOLDS.overTemp.warning
                ? 'warning'
                : 'normal'
        : 'normal';

    return (
        <div className="w-full">
            {/* Thermistor bar */}
            <div className="flex w-full rounded overflow-hidden">
                {thermistorIndices.map((idx) => (
                    <ThermistorSegment
                        key={idx}
                        moduleId={moduleId}
                        thermistorIndex={idx}
                        temp={readings.get(idx) ?? null}
                    />
                ))}
            </div>

            {/* Stats row */}
            <div className="flex justify-between mt-1 text-[10px] text-gray-400 font-mono">
                <span>
                    Min: <span className="text-white">{aggregate.min !== null ? `${aggregate.min.toFixed(1)}°` : '--'}</span>
                </span>
                <span>
                    Avg: <span className="text-white">{aggregate.avg !== null ? `${aggregate.avg.toFixed(1)}°` : '--'}</span>
                </span>
                <span className={maxTempLevel === 'critical' ? 'text-red-400' : maxTempLevel === 'warning' ? 'text-orange-400' : ''}>
                    Max: <span className={maxTempLevel === 'critical' ? 'text-red-400 font-bold' : maxTempLevel === 'warning' ? 'text-orange-400 font-bold' : 'text-white'}>
                        {aggregate.max !== null ? `${aggregate.max.toFixed(1)}°` : '--'}
                    </span>
                </span>
            </div>
        </div>
    );
}
