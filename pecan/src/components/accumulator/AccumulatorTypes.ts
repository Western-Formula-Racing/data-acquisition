/**
 * Accumulator Types and Constants
 * 
 * Defines sensor naming patterns, module configuration, and alert thresholds
 * for the 5-module accumulator pack monitoring system.
 */

// Module identifiers
export const MODULE_IDS = ['M1', 'M2', 'M3', 'M4', 'M5'] as const;
export type ModuleId = typeof MODULE_IDS[number];

// Sensor counts per module
export const CELLS_PER_MODULE = 20;
export const THERMISTORS_PER_MODULE = 18;

// DBC Message structure
// Each voltage message contains 4 cells, 5 messages per module
// Each temp message contains 4 thermistors (last one has only 2)
export const CELLS_PER_VOLTAGE_MSG = 4;
export const THERMISTORS_PER_TEMP_MSG = 4;

// CAN ID base values from DBC file (numeric IDs, not message names)
// DataStore indexes by numeric CAN ID string, e.g., "1006"
// Voltage message base IDs: M1=1006, M2=1011, M3=1016, M4=1021, M5=1026
// Temp message base IDs: M1=1031, M2=1036, M3=1041, M4=1046, M5=1051
const VOLTAGE_BASE_ID: Record<ModuleId, number> = {
    M1: 1006,
    M2: 1011,
    M3: 1016,
    M4: 1021,
    M5: 1026,
};

const TEMP_BASE_ID: Record<ModuleId, number> = {
    M1: 1031,
    M2: 1036,
    M3: 1041,
    M4: 1046,
    M5: 1051,
};

/**
 * Get the numeric CAN ID and signal name for a specific cell voltage.
 * 
 * DBC Format:
 * - CAN ID 1006 (TORCH_M1_V1) contains M1_Cell1_Voltage through M1_Cell4_Voltage
 * - CAN ID 1007 (TORCH_M1_V2) contains M1_Cell5_Voltage through M1_Cell8_Voltage
 * - etc.
 */
export function getCellSignalInfo(module: ModuleId, cellIndex: number): { msgId: string; signalName: string } {
    const msgNum = Math.ceil(cellIndex / CELLS_PER_VOLTAGE_MSG) - 1; // 0-indexed offset
    const canId = VOLTAGE_BASE_ID[module] + msgNum;
    const signalName = `${module}_Cell${cellIndex}_Voltage`;
    return { msgId: String(canId), signalName };
}

/**
 * Get the numeric CAN ID and signal name for a specific thermistor.
 * 
 * DBC Format:
 * - CAN ID 1031 (TORCH_M1_T1) contains M1_Thermistor1 through M1_Thermistor4
 * - CAN ID 1032 (TORCH_M1_T2) contains M1_Thermistor5 through M1_Thermistor8
 * - etc.
 */
export function getThermistorSignalInfo(module: ModuleId, thermistorIndex: number): { msgId: string; signalName: string } {
    const msgNum = Math.ceil(thermistorIndex / THERMISTORS_PER_TEMP_MSG) - 1; // 0-indexed offset
    const canId = TEMP_BASE_ID[module] + msgNum;
    const signalName = `${module}_Thermistor${thermistorIndex}`;
    return { msgId: String(canId), signalName };
}

// Legacy functions for backwards compatibility
export function getCellSignalName(module: ModuleId, cellIndex: number): string {
    return `${module}_Cell${cellIndex}_Voltage`;
}

export function getThermistorSignalName(module: ModuleId, thermistorIndex: number): string {
    return `${module}_Thermistor${thermistorIndex}`;
}

// Alert thresholds (configurable defaults)
export const ALERT_THRESHOLDS = {
    // Cell voltage difference between any two cells
    voltageDiff: {
        warning: 0.1,  // V
        critical: 0.2, // V
    },
    // Maximum temperature
    overTemp: {
        warning: 45,   // °C
        critical: 55,  // °C
    },
    // Module-to-module average voltage difference
    moduleImbalance: {
        warning: 0.3,  // V
        critical: 0.5, // V
    },
    // Minimum cell voltage
    lowVoltage: {
        warning: 3.2,  // V
        critical: 3.0, // V
    },
    // Nominal voltage range for heatmap coloring
    nominalVoltage: {
        min: 3.0,      // V (red)
        nominal: 3.6,  // V (green)
        max: 4.2,      // V (red)
    },
} as const;

// Alert status levels
export type AlertLevel = 'normal' | 'warning' | 'critical';

export interface AlertState {
    level: AlertLevel;
    message?: string;
    affectedSensors?: string[];
}

export interface ModuleStats {
    moduleId: ModuleId;
    avgVoltage: number | null;
    minVoltage: number | null;
    maxVoltage: number | null;
    voltageDiff: number | null;
    avgTemp: number | null;
    maxTemp: number | null;
    cellCount: number;
    thermistorCount: number;
    hasData: boolean;
}

// Color utilities for heatmaps
export function getVoltageColor(voltage: number | null): string {
    if (voltage === null) return '#4a4a5e'; // Gray for no data

    const { min, nominal, max } = ALERT_THRESHOLDS.nominalVoltage;

    if (voltage < min || voltage > max) {
        return '#ef4444'; // Red - out of range
    }

    if (voltage < ALERT_THRESHOLDS.lowVoltage.warning) {
        return '#f97316'; // Orange - low warning
    }

    // Green gradient based on how close to nominal
    const deviation = Math.abs(voltage - nominal);
    const maxDeviation = Math.max(nominal - min, max - nominal);
    const normalized = 1 - (deviation / maxDeviation);

    // Interpolate from yellow to green
    const r = Math.round(34 + (1 - normalized) * 200);
    const g = Math.round(197 + (1 - normalized) * (-100));
    const b = 94;

    return `rgb(${r}, ${g}, ${b})`;
}

export function getTemperatureColor(temp: number | null): string {
    if (temp === null) return '#4a4a5e'; // Gray for no data

    const { warning, critical } = ALERT_THRESHOLDS.overTemp;

    if (temp >= critical) {
        return '#ef4444'; // Red - critical
    }

    if (temp >= warning) {
        return '#f97316'; // Orange - warning
    }

    if (temp >= warning - 10) {
        return '#eab308'; // Yellow - approaching warning
    }

    return '#22c55e'; // Green - normal
}

export function getAlertLevelColor(level: AlertLevel): string {
    switch (level) {
        case 'critical': return '#ef4444';
        case 'warning': return '#f59e0b';
        case 'normal': return '#22c55e';
    }
}
