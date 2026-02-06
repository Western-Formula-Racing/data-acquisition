/**
 * ChargingCurve Component
 * 
 * Recharts line chart showing pack voltage and temperature trends over time.
 * More compact design than Plotly version with minimal UI chrome.
 */

import { useEffect, useState, useMemo } from 'react';
import {
    ResponsiveContainer,
    LineChart,
    Line,
    XAxis,
    YAxis,
    Tooltip,
    Legend,
} from 'recharts';
import { dataStore } from '../../lib/DataStore';
import {
    MODULE_IDS,
    CELLS_PER_MODULE,
    THERMISTORS_PER_MODULE,
    getCellSignalInfo,
    getThermistorSignalInfo,
} from './AccumulatorTypes';

interface ChargingCurveProps {
    timeWindowMs?: number; // Default 5 minutes
}

interface ChartDataPoint {
    time: number;      // seconds ago (negative)
    timeLabel: string; // formatted label
    voltage: number | null;
    temp: number | null;
}

export default function ChargingCurve({
    timeWindowMs = 300000
}: ChargingCurveProps) {
    const [data, setData] = useState<ChartDataPoint[]>([]);

    // Update chart data every second
    useEffect(() => {
        const updateData = () => {
            const now = Date.now();
            const bucketMs = 2000; // 2 second buckets for smoother data
            const voltageBuckets = new Map<number, number[]>();
            const tempBuckets = new Map<number, number[]>();

            // Collect data from all modules
            for (const moduleId of MODULE_IDS) {
                for (let i = 1; i <= CELLS_PER_MODULE; i++) {
                    const { msgId, signalName } = getCellSignalInfo(moduleId, i);
                    const history = dataStore.getHistory(msgId, timeWindowMs);

                    for (const sample of history) {
                        const bucket = Math.floor(sample.timestamp / bucketMs) * bucketMs;
                        const signalData = sample.data[signalName];
                        if (signalData) {
                            if (!voltageBuckets.has(bucket)) voltageBuckets.set(bucket, []);
                            voltageBuckets.get(bucket)!.push(signalData.sensorReading);
                        }
                    }
                }

                for (let i = 1; i <= THERMISTORS_PER_MODULE; i++) {
                    const { msgId, signalName } = getThermistorSignalInfo(moduleId, i);
                    const history = dataStore.getHistory(msgId, timeWindowMs);

                    for (const sample of history) {
                        const bucket = Math.floor(sample.timestamp / bucketMs) * bucketMs;
                        const signalData = sample.data[signalName];
                        if (signalData) {
                            if (!tempBuckets.has(bucket)) tempBuckets.set(bucket, []);
                            tempBuckets.get(bucket)!.push(signalData.sensorReading);
                        }
                    }
                }
            }

            // Build chart data
            const chartData: ChartDataPoint[] = [];
            const allBuckets = new Set([...voltageBuckets.keys(), ...tempBuckets.keys()]);
            const sortedBuckets = [...allBuckets].sort((a, b) => a - b);

            for (const bucket of sortedBuckets) {
                const secondsAgo = Math.round((bucket - now) / 1000);
                const voltageValues = voltageBuckets.get(bucket);
                const tempValues = tempBuckets.get(bucket);

                chartData.push({
                    time: secondsAgo,
                    timeLabel: `${secondsAgo}s`,
                    voltage: voltageValues
                        ? Math.round((voltageValues.reduce((a, b) => a + b, 0) / voltageValues.length) * 1000) / 1000
                        : null,
                    temp: tempValues
                        ? Math.round((tempValues.reduce((a, b) => a + b, 0) / tempValues.length) * 10) / 10
                        : null,
                });
            }

            setData(chartData);
        };

        const interval = setInterval(updateData, 1000);
        updateData();

        return () => clearInterval(interval);
    }, [timeWindowMs]);

    // Calculate axis ranges
    const { voltageRange, tempRange } = useMemo(() => {
        const voltages = data.map(d => d.voltage).filter((v): v is number => v !== null);
        const temps = data.map(d => d.temp).filter((t): t is number => t !== null);

        return {
            voltageRange: voltages.length > 0
                ? [Math.floor(Math.min(...voltages) * 10) / 10 - 0.1, Math.ceil(Math.max(...voltages) * 10) / 10 + 0.1]
                : [3.0, 4.2],
            tempRange: temps.length > 0
                ? [Math.floor(Math.min(...temps)) - 5, Math.ceil(Math.max(...temps)) + 5]
                : [20, 60],
        };
    }, [data]);

    return (
        <div className="w-full h-full min-h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
                <LineChart
                    data={data}
                    margin={{ top: 5, right: 45, left: 5, bottom: 5 }}
                >
                    <XAxis
                        dataKey="time"
                        type="number"
                        domain={[-(timeWindowMs / 1000), 0]}
                        tick={{ fill: '#9ca3af', fontSize: 10 }}
                        tickFormatter={(v) => `${v}s`}
                        axisLine={{ stroke: '#374151' }}
                        tickLine={{ stroke: '#374151' }}
                    />
                    <YAxis
                        yAxisId="voltage"
                        domain={voltageRange}
                        tick={{ fill: '#22c55e', fontSize: 10 }}
                        tickFormatter={(v) => `${v.toFixed(1)}V`}
                        axisLine={{ stroke: '#374151' }}
                        tickLine={{ stroke: '#374151' }}
                        width={45}
                    />
                    <YAxis
                        yAxisId="temp"
                        orientation="right"
                        domain={tempRange}
                        tick={{ fill: '#f97316', fontSize: 10 }}
                        tickFormatter={(v) => `${v}°`}
                        axisLine={{ stroke: '#374151' }}
                        tickLine={{ stroke: '#374151' }}
                        width={35}
                    />
                    <Tooltip
                        contentStyle={{
                            backgroundColor: '#1f2937',
                            border: '1px solid #374151',
                            borderRadius: '4px',
                            fontSize: '11px',
                        }}
                        labelStyle={{ color: '#9ca3af' }}
                        formatter={(value, name) => {
                            if (value === undefined) return ['--', name];
                            const v = value as number;
                            return [
                                name === 'voltage' ? `${v.toFixed(3)}V` : `${v.toFixed(1)}°C`,
                                name === 'voltage' ? 'Avg Voltage' : 'Avg Temp',
                            ];
                        }}
                        labelFormatter={(label) => `${label}s ago`}
                    />
                    <Legend
                        wrapperStyle={{ fontSize: '10px', paddingTop: '4px' }}
                        formatter={(value) => (
                            <span style={{ color: value === 'voltage' ? '#22c55e' : '#f97316' }}>
                                {value === 'voltage' ? 'Voltage' : 'Temp'}
                            </span>
                        )}
                    />
                    <Line
                        yAxisId="voltage"
                        type="monotone"
                        dataKey="voltage"
                        stroke="#22c55e"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                    />
                    <Line
                        yAxisId="temp"
                        type="monotone"
                        dataKey="temp"
                        stroke="#f97316"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
