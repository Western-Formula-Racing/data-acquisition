/**
 * Convert a contiguous hex string (e.g. from packMessage) to decimal bytes
 * for WebSocket `can_send` payloads (WEBSOCKET_PROTOCOL.md).
 */
export function hexToBytes(hex: string): number[] {
  const normalized = hex.replace(/\s+/g, '').toUpperCase();
  if (normalized.length === 0) return [];
  const pairs = normalized.match(/.{1,2}/g);
  if (!pairs) return [];
  return pairs.map((b) => parseInt(b, 16));
}
