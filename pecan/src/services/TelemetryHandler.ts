import { webSocketService } from './WebSocketService';
import { dataStore } from '../lib/DataStore';
import { formatCanId } from '../utils/canProcessor';

// Synthetic message IDs for non-CAN diagnostic data
export const DIAG_MSG_IDS = {
  SYSTEM_STATS: '__system_stats__',
  LINK_PING: '__link_ping__',
  LINK_THROUGHPUT: '__link_throughput__',
  LINK_RADIO: '__link_radio__',
  CAR_LINK: '__car_link__',
  HEARTBEAT: '__heartbeat__',
} as const;

// CAN ID of the UTS heartbeat frame (timestamp sync injected by car Pi)
const HEARTBEAT_CAN_ID = 1999; // 0x7CF

class TelemetryHandler {
  private isInitialized = false;

  initialize() {
    if (this.isInitialized) return;

    // Listen for CAN messages
    webSocketService.on('decoded', (decoded: any) => {
      // Respect ingestion suppression from SerialService
      if (webSocketService.isIngestionSuppressed()) {
        const count = webSocketService.getMessageCount();
        if (count % 100 === 0) {
          console.log(`[TelemetryHandler] Suppressing ingestion (Local Connection Active)`);
        }
        return;
      }

      const messages = Array.isArray(decoded) ? decoded : [decoded];
      messages.forEach(msg => {
        if (!msg?.signals) return;

        // Intercept UTS heartbeat — it's a timestamp sync frame, not real CAN data
        if (msg.canId === HEARTBEAT_CAN_ID) {
          dataStore.ingestMessage({
            msgID: DIAG_MSG_IDS.HEARTBEAT,
            messageName: 'Heartbeat',
            data: {},
            rawData: msg.rawData,
            timestamp: msg.time || Date.now(),
          });
          return;
        }

        const hexId = formatCanId(msg.canId);
        dataStore.ingestMessage({
          msgID: hexId,
          messageName: msg.messageName || `CAN_${hexId}`,
          data: msg.signals,
          rawData: msg.rawData,
          timestamp: msg.time || Date.now()
        });
      });
    });

    // Listen for named diagnostic events (type field set by UTS/bridge)
    // This is more reliable than 'raw' because WebSocketService routes by type first.
    for (const eventType of ['system_stats', 'ping', 'throughput', 'radio'] as const) {
      webSocketService.on(eventType, (messageData: any) => {
        if (webSocketService.isIngestionSuppressed()) return;
        this.handleDiagnosticMessage(messageData);
      });
    }

    this.isInitialized = true;
    console.log('[TelemetryHandler] Initialized');
  }

  private handleDiagnosticMessage(msg: any): boolean {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;

    // system_stats: {"received": N, "missing": N, "recovered": N}
    if ('received' in msg && 'missing' in msg && 'recovered' in msg && !('canId' in msg)) {
      const ts = Date.now();
      dataStore.ingestMessage({
        msgID: DIAG_MSG_IDS.SYSTEM_STATS,
        messageName: 'System Stats',
        data: {
          received: { sensorReading: Number(msg.received), unit: 'pkt/s' },
          missing: { sensorReading: Number(msg.missing), unit: 'pkt/s' },
          recovered: { sensorReading: Number(msg.recovered), unit: 'pkt/s' },
        },
        rawData: '',
        timestamp: ts,
      });
      // Car link status: car Pi sends heartbeat packets even without CAN bus connected,
      // so received > 0 reliably means the radio link between car and base is up.
      const carPktRate = Number(msg.received);
      dataStore.ingestMessage({
        msgID: DIAG_MSG_IDS.CAR_LINK,
        messageName: 'Car Link',
        data: {
          linked: { sensorReading: carPktRate > 0 ? 1 : 0, unit: carPktRate > 0 ? '✓ LINKED' : '✗ NO SIGNAL' },
          pkt_rate: { sensorReading: carPktRate, unit: 'pkt/s' },
        },
        rawData: '',
        timestamp: ts,
      });
      return true;
    }

    // link_diagnostics: {"type": "ping"|"throughput"|"radio", ...}
    if (msg.type === 'ping' || msg.type === 'throughput' || msg.type === 'radio') {
      const ts = typeof msg.ts === 'number' ? msg.ts : Date.now();

      if (msg.type === 'ping') {
        dataStore.ingestMessage({
          msgID: DIAG_MSG_IDS.LINK_PING,
          messageName: 'Link Ping',
          data: {
            rtt_ms: { sensorReading: msg.rtt_ms != null ? Number(msg.rtt_ms) : -1, unit: 'ms' },
          },
          rawData: '',
          timestamp: ts,
        });
        return true;
      }

      if (msg.type === 'throughput') {
        dataStore.ingestMessage({
          msgID: DIAG_MSG_IDS.LINK_THROUGHPUT,
          messageName: 'Link Throughput',
          data: {
            mbps: { sensorReading: msg.mbps != null ? Number(msg.mbps) : -1, unit: 'Mbps' },
            loss_pct: { sensorReading: Number(msg.loss_pct ?? 0), unit: '%' },
            sent: { sensorReading: Number(msg.sent ?? 0), unit: 'pkt' },
            received: { sensorReading: Number(msg.received ?? 0), unit: 'pkt' },
          },
          rawData: '',
          timestamp: ts,
        });
        return true;
      }

      if (msg.type === 'radio') {
        dataStore.ingestMessage({
          msgID: DIAG_MSG_IDS.LINK_RADIO,
          messageName: 'Radio Stats',
          data: {
            rssi_dbm: { sensorReading: Number(msg.rssi_dbm ?? 0), unit: 'dBm' },
            tx_mbps: { sensorReading: Number(msg.tx_mbps ?? 0), unit: 'Mbps' },
            rx_mbps: { sensorReading: Number(msg.rx_mbps ?? 0), unit: 'Mbps' },
            ccq_pct: { sensorReading: Number(msg.ccq_pct ?? 0), unit: '%' },
            error: { sensorReading: msg.error ? 1 : 0, unit: '' },
          },
          rawData: typeof msg.error === 'string' ? msg.error : '',
          timestamp: ts,
        });
        return true;
      }
    }

    return false;
  }
}

export const telemetryHandler = new TelemetryHandler();
