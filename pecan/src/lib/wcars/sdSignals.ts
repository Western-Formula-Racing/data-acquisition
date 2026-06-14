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
  // ELEC / BATT — pack-level now sourced from MOBO 0x420 (Orion retired)
  // packV is *computed* by usePackVoltage() (sum of 100 cell voltages)
  packA:     { msgId: "0x420", signal: "PackCurrent", unit: "A", range: [-300, 300], amber: 200, red: 250 },
  packSoc:   { msgId: "0x420", signal: "SOC", unit: "%", range: [0, 100], amberLow: 30, redLow: 15 },
  packDcl:   { msgId: "0x202", signal: "BMS_Max_Discharge_Current", unit: "A", range: [0, 300] },
  packCcl:   { msgId: "0x202", signal: "BMS_Max_Charge_Current", unit: "A", range: [0, 300] },
  busV:      { msgId: "0x0A7", signal: "INV_DC_Bus_Voltage", unit: "V", range: [0, 600] },
  busA:      { msgId: "0x0A6", signal: "INV_DC_Bus_Current", unit: "A", range: [-300, 300] },
  // MOTOR
  motorRpm:  { msgId: "0x0A5", signal: "INV_Motor_Speed", unit: "RPM", range: [0, 6000], amber: 5000, red: 5500 },
  torqueFb:  { msgId: "0x0AC", signal: "INV_Torque_Feedback", unit: "Nm", range: [-240, 240] },
  torqueCmd: { msgId: "0x0C0", signal: "VCU_INV_Torque_Command", unit: "Nm", range: [-240, 240] },
  motorTemp: { msgId: "0x0A2", signal: "INV_Motor_Temp", unit: "°C", range: [0, 160], amber: 120, red: 140 },
  hotSpot:   { msgId: "0x0A2", signal: "INV_Hot_Spot_Temp", unit: "°C", range: [0, 160], amber: 120, red: 140 },
  gateTemp:  { msgId: "0x0A0", signal: "INV_Gate_Driver_Board_Temp", unit: "°C", range: [0, 120], amber: 80, red: 100 },
  modA:      { msgId: "0x0A0", signal: "INV_Module_A_Temp", unit: "°C", range: [0, 120], amber: 80, red: 100 },
  modB:      { msgId: "0x0A0", signal: "INV_Module_B_Temp", unit: "°C", range: [0, 120], amber: 80, red: 100 },
  modC:      { msgId: "0x0A0", signal: "INV_Module_C_Temp", unit: "°C", range: [0, 120], amber: 80, red: 100 },
  // COOL
  coolant:   { msgId: "0x0A2", signal: "INV_Coolant_Temp", unit: "°C", range: [0, 100], amber: 55, red: 65 },
  // STS (enum: label is in `unit`, raw int in sensorReading)
  vcuState:  { msgId: "0x7D2", signal: "State", unit: "", range: [0, 15] },
  rtdButton: { msgId: "0x7D2", signal: "RTD_Button", unit: "", range: [0, 1] },
  // SAFETY LOOP / SHUTDOWN CIRCUIT (MOBO PackStatus 0x420)
  // New DBC: HV_Active + Safetyloop_return retired, replaced with AIR+/AIR- relays.
  imdRelay:        { msgId: "0x420", signal: "IMDRelay",          unit: "", range: [0, 1] },
  amsRelay:        { msgId: "0x420", signal: "AMSRelay",          unit: "", range: [0, 1] },
  bspdRelay:       { msgId: "0x420", signal: "BSPDRelay",         unit: "", range: [0, 1] },
  latchRelay:      { msgId: "0x420", signal: "LatchRelay",        unit: "", range: [0, 1] },
  airPos:          { msgId: "0x420", signal: "AIR_Positive_Relay", unit: "", range: [0, 7] },
  airNeg:          { msgId: "0x420", signal: "AIR_Negative_Relay", unit: "", range: [0, 1] },
  packState:       { msgId: "0x420", signal: "PackStatus",        unit: "", range: [0, 6] },
  prechargeEnable: { msgId: "0x7D3", signal: "Precharge_Enable",  unit: "", range: [0, 1] },
  prechargeOk:     { msgId: "0x7D3", signal: "Precharge_OK",      unit: "", range: [0, 1] },
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
