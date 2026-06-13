// pecan/src/lib/wcars/sdSignals.ts
import { useSignal } from "../useDataStore";

export type SdStatus = "normal" | "caution" | "warning" | "missing";

export interface SdSignalDef {
  /** Hex CAN id string as keyed by DataStore, e.g. "0x7DD". */
  msgId: string;
  /** DBC signal name. */
  signal: string;
  /** Display unit. */
  unit: string;
  /** Gauge min/max. */
  range: [number, number];
  /** High-side caution/warning thresholds (value >= → status). */
  amber?: number;
  red?: number;
  /** Low-side caution/warning thresholds (value <= → status), e.g. SoC. */
  amberLow?: number;
  redLow?: number;
}

export const SD_SIGNALS = {
  // WHEEL
  leftRpm:   { msgId: "0x7DD", signal: "Left_RPM",  unit: "RPM", range: [0, 8000] },
  rightRpm:  { msgId: "0x7DD", signal: "Right_RPM", unit: "RPM", range: [0, 8000] },
  brakeF:    { msgId: "0x7D0", signal: "brakePressure1Signal", unit: "", range: [0, 5] },
  brakeR:    { msgId: "0x7D0", signal: "brakePressure2Signal", unit: "", range: [0, 5] },
  brakePct:  { msgId: "0x7D2", signal: "Brake_Percent", unit: "%", range: [0, 100] },
  throttle:  { msgId: "0x7D2", signal: "Throttle", unit: "%", range: [0, 100] },
  // ELEC / BATT
  packV:     { msgId: "0x6B0", signal: "Pack_Inst_Voltage", unit: "V", range: [0, 600] },
  packA:     { msgId: "0x6B0", signal: "Pack_Current", unit: "A", range: [0, 300], amber: 200, red: 250 },
  packSoc:   { msgId: "0x6B0", signal: "Pack_SOC", unit: "%", range: [0, 100], amberLow: 30, redLow: 15 },
  packDcl:   { msgId: "0x6B1", signal: "Pack_DCL", unit: "A", range: [0, 300] },
  packCcl:   { msgId: "0x6B1", signal: "Pack_CCL", unit: "A", range: [0, 300] },
  busV:      { msgId: "0xA7",  signal: "INV_DC_Bus_Voltage", unit: "V", range: [0, 600] },
  busA:      { msgId: "0xA6",  signal: "INV_DC_Bus_Current", unit: "A", range: [-300, 300] },
  // MOTOR
  motorRpm:  { msgId: "0xA5",  signal: "INV_Motor_Speed", unit: "RPM", range: [0, 6000], amber: 5000, red: 5500 },
  torqueFb:  { msgId: "0xAC",  signal: "INV_Torque_Feedback", unit: "Nm", range: [-240, 240] },
  torqueCmd: { msgId: "0xC0",  signal: "VCU_INV_Torque_Command", unit: "Nm", range: [-240, 240] },
  motorTemp: { msgId: "0xA2",  signal: "INV_Motor_Temp", unit: "°C", range: [0, 160], amber: 120, red: 140 },
  hotSpot:   { msgId: "0xA2",  signal: "INV_Hot_Spot_Temp", unit: "°C", range: [0, 160], amber: 120, red: 140 },
  gateTemp:  { msgId: "0xA0",  signal: "INV_Gate_Driver_Board_Temp", unit: "°C", range: [0, 120], amber: 80, red: 100 },
  modA:      { msgId: "0xA0",  signal: "INV_Module_A_Temp", unit: "°C", range: [0, 120], amber: 80, red: 100 },
  modB:      { msgId: "0xA0",  signal: "INV_Module_B_Temp", unit: "°C", range: [0, 120], amber: 80, red: 100 },
  modC:      { msgId: "0xA0",  signal: "INV_Module_C_Temp", unit: "°C", range: [0, 120], amber: 80, red: 100 },
  // COOL
  coolant:   { msgId: "0xA2",  signal: "INV_Coolant_Temp", unit: "°C", range: [0, 100], amber: 55, red: 65 },
  // STS (enum: label is in `unit`, raw int in sensorReading)
  vcuState:  { msgId: "0x7D2", signal: "State", unit: "", range: [0, 15] },
  rtdButton: { msgId: "0x7D2", signal: "RTD_Button", unit: "", range: [0, 1] },
} satisfies Record<string, SdSignalDef>;

export type SdSignalKey = keyof typeof SD_SIGNALS;

export function classifyStatus(
  value: number | null | undefined,
  def: SdSignalDef,
): SdStatus {
  if (value === null || value === undefined || Number.isNaN(value)) return "missing";
  if (def.red !== undefined && value >= def.red) return "warning";
  if (def.redLow !== undefined && value <= def.redLow) return "warning";
  if (def.amber !== undefined && value >= def.amber) return "caution";
  if (def.amberLow !== undefined && value <= def.amberLow) return "caution";
  return "normal";
}

export interface SdValue {
  value: number | null;
  /** Enum label when the signal is an enum (from DataStore `unit`), else "". */
  label: string;
  unit: string;
  status: SdStatus;
}

/** Subscribe to one configured SD signal and classify it. */
export function useSdValue(key: SdSignalKey): SdValue {
  const def = SD_SIGNALS[key];
  const sig = useSignal(def.msgId, def.signal);
  const value = sig ? sig.sensorReading : null;
  return {
    value,
    label: sig?.unit ?? "",
    unit: def.unit,
    status: classifyStatus(value, def),
  };
}
