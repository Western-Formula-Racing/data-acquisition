// pecan/src/lib/wcars/packAggregates.ts
import { useMemo } from "react";
import { useAllLatestMessages } from "../useDataStore";

/** WFR25 pack: 5 modules × 5 frames/module × 4 cells/frame = 100 cells.
 *  Each TORCH_M{n}_V{m} frame carries 4 cell voltages at 0.0001 V/bit.
 *  The pack has no dedicated pack-voltage signal; we sum the cells on the
 *  frontend, then keep that result in sync with DataStore updates. */
const MODULE_IDS = [1, 2, 3, 4, 5] as const;
const FRAME_IDS = [1, 2, 3, 4, 5] as const;
const CELLS_PER_FRAME = 4 as const;

function moduleFrameId(module: number, frame: number): string {
  // 0x3EE = TORCH_M1_V1, +1 per frame, +5 per module.
  return `0x${(0x3EE + (module - 1) * 5 + (frame - 1)).toString(16).toUpperCase().padStart(3, "0")}`;
}

export interface CellReading {
  module: number;
  cell: number;        // 1..20 within module
  voltage: number;     // volts
}

export interface PackSummary {
  cellCount: number;     // number of cells we have a reading for
  packVoltage: number;   // sum of all present cell voltages, volts
  minVoltage: number | null;   // weakest cell
  maxVoltage: number | null;   // strongest cell
  cells: CellReading[];  // every cell with a non-null reading
}

/** Mean of the 90 TORCH thermistors (5 modules × 18 sensors), in °C. */
export function usePackTemp(): {
  tempC: number | null;
  sensorsRead: number;
  totalSensors: number;
} {
  const allLatest = useAllLatestMessages();
  return useMemo(() => {
    const temps: number[] = [];
    for (let m = 1; m <= 5; m++) {
      // 4 therms in T1..T4, 2 in T5 → 18 per module
      const cellsPerFrame = [4, 4, 4, 4, 2];
      for (let f = 1; f <= 5; f++) {
        const id = 0x407 + (m - 1) * 5 + (f - 1);
        const msgID = `0x${id.toString(16).toUpperCase().padStart(3, "0")}`;
        const sample = allLatest.get(msgID);
        if (!sample) continue;
        for (let c = 1; c <= cellsPerFrame[f - 1]; c++) {
          const idx = (f - 1) * 4 + c;
          const sig = sample.data[`M${m}_Thermistor${idx}`];
          if (!sig || sig.sensorReading == null) continue;
          temps.push(sig.sensorReading);
        }
      }
    }
    if (temps.length === 0) {
      return { tempC: null, sensorsRead: 0, totalSensors: 90 };
    }
    const sum = temps.reduce((a, b) => a + b, 0);
    return {
      tempC: sum / temps.length,
      sensorsRead: temps.length,
      totalSensors: 90,
    };
  }, [allLatest]);
}

/** Read all 100 TORCH cell voltages and aggregate them into pack-level stats. */
export function usePackAggregates(): PackSummary {
  const allLatest = useAllLatestMessages();
  return useMemo(() => {
    const cells: CellReading[] = [];
    let sum = 0;
    let min: number | null = null;
    let max: number | null = null;
    for (const m of MODULE_IDS) {
      for (const f of FRAME_IDS) {
        const sample = allLatest.get(moduleFrameId(m, f));
        if (!sample) continue;
        for (let c = 1; c <= CELLS_PER_FRAME; c++) {
          const sig = sample.data[`M${m}_Cell${(f - 1) * 4 + c}_Voltage`];
          if (!sig || sig.sensorReading == null) continue;
          const v = sig.sensorReading;
          cells.push({ module: m, cell: (f - 1) * 4 + c, voltage: v });
          sum += v;
          if (min === null || v < min) min = v;
          if (max === null || v > max) max = v;
        }
      }
    }
    return {
      cellCount: cells.length,
      packVoltage: sum,
      minVoltage: min,
      maxVoltage: max,
      cells,
    };
  }, [allLatest]);
}
