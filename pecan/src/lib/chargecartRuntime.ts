export const CHARGECART_PATH = "/chargecart";
export const CHARGECART_HOT_RETENTION_WINDOW_MS = 60 * 1000;

const CHARGECART_BALANCE_SEQUENCE_MIN_ID = 992;
const CHARGECART_BALANCE_SEQUENCE_MAX_ID = 999;
const CHARGECART_BMS_MIN_ID = 1000;
const CHARGECART_BMS_MAX_ID = 1057;
const UTS_HEARTBEAT_CAN_ID = 1999;
const RELAY_HEARTBEAT_CAN_ID = 0x7FD;

export function isChargecartRuntime(): boolean {
  return typeof window !== "undefined" && window.location?.pathname === CHARGECART_PATH;
}

export function isChargecartTelemetryCanId(canId: number): boolean {
  const normalized = canId > 0x7FF ? canId & 0x7FFFFFFF : canId;
  return (
    normalized === UTS_HEARTBEAT_CAN_ID ||
    normalized === RELAY_HEARTBEAT_CAN_ID ||
    (normalized >= CHARGECART_BALANCE_SEQUENCE_MIN_ID && normalized <= CHARGECART_BALANCE_SEQUENCE_MAX_ID) ||
    (normalized >= CHARGECART_BMS_MIN_ID && normalized <= CHARGECART_BMS_MAX_ID)
  );
}
