import { dataStore } from '../lib/DataStore';
import { createCanProcessor, formatCanId } from '../utils/canProcessor';

// Synthetic message IDs for non-CAN diagnostic data
export const DIAG_MSG_IDS = {
  SYSTEM_STATS: '__system_stats__',
  LINK_PING: '__link_ping__',
  LINK_THROUGHPUT: '__link_throughput__',
  LINK_RADIO: '__link_radio__',
} as const;

export class WebSocketService {
  private ws: WebSocket | null = null;
  private processor: any = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000; // Start with 2 seconds
  private messageCount = 0; // Track message count for logging

  async initialize() {
    // Initialize CAN processor
    try {
      this.processor = await createCanProcessor();
      console.log('CAN processor initialized');
    } catch (error) {
      console.error('Failed to initialize CAN processor:', error);
      return;
    }

    // Connect WebSocket
    this.connect();
  }

  private connect() {
    // Automatically detect secure vs non-secure WebSocket based on page protocol
    const isSecure = window.location.protocol === 'https:';
    const protocol = isSecure ? 'wss' : 'ws';
    const port = isSecure ? '9443' : '9080';

    // Determine WebSocket URL based on deployment scenario
    let wsUrl: string;

    // Check availability of environment override or user setting first
    const customUrl = localStorage.getItem('custom-ws-url');
    if (customUrl) {
      wsUrl = customUrl;
    } else if (import.meta.env.VITE_WS_URL) {
      wsUrl = import.meta.env.VITE_WS_URL;
    } else {
      const hostname = window.location.hostname;
      // Only 192.x IPs connect directly to the RPi; everything else uses the production backend
      const isRpiNetwork = hostname.startsWith('192.');

      if (isRpiNetwork) {
        // 192.x.x.x: connect directly to the RPi
        wsUrl = `${protocol}://${hostname}:${port}`;
      } else {
        // Localhost, GitHub Pages, other IPs: always use production backend
        wsUrl = `wss://ws-wfr.0001200.xyz:9443`;
      }
    }

    console.log(`Connecting to WebSocket: ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0; // Reset reconnect counter on successful connection
        this.messageCount = 0; // Reset message count on new connection
      };

      this.ws.onmessage = (event) => {
        try {
          // Only log first 3 messages to avoid console spam
          if (this.messageCount < 3) {
            console.log(`Received WebSocket message #${this.messageCount + 1}:`, event.data);
          }

          const messageData = JSON.parse(event.data);

          // Intercept diagnostic messages BEFORE the CAN processor
          if (this.handleDiagnosticMessage(messageData)) {
            this.messageCount++;
            return;
          }

          const decoded = this.processor.processWebSocketMessage(messageData);

          // Only log first 3 decoded messages
          if (this.messageCount < 3) {
            console.log(`Decoded message(s) #${this.messageCount + 1}:`, decoded);
          }

          this.messageCount++;

          // Log milestone message counts
          if (this.messageCount === 10 || this.messageCount === 100 || this.messageCount % 1000 === 0) {
            console.log(`WebSocket: Received ${this.messageCount} messages`);
          }

          const messages = Array.isArray(decoded) ? decoded : [decoded];

          messages.forEach(msg => {
            if (msg?.signals) {
              const hexId = formatCanId(msg.canId);

              dataStore.ingestMessage({
                msgID: hexId,
                messageName: msg.messageName || `CAN_${hexId}`,
                data: msg.signals,
                rawData: msg.rawData,
                timestamp: msg.time || Date.now()
              });
            }
          });
        } catch (error) {
          console.error('Error processing WebSocket message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      this.ws.onclose = (event) => {
        console.log('WebSocket disconnected');

        // Attempt to reconnect if not closed intentionally
        if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = this.reconnectDelay * this.reconnectAttempts;

          setTimeout(() => {
            this.connect();
          }, delay);
        }
      };
    } catch (error) {
      console.error('WebSocket error:', error);
    }
  }

  /**
   * Intercept non-CAN diagnostic messages and inject into DataStore.
   * Returns true if the message was handled, false to fall through to CAN processor.
   */
  private handleDiagnosticMessage(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const msg = raw as Record<string, unknown>;

    // system_stats: {"received": N, "missing": N, "recovered": N}
    if ('received' in msg && 'missing' in msg && 'recovered' in msg && !('canId' in msg)) {
      dataStore.ingestMessage({
        msgID: DIAG_MSG_IDS.SYSTEM_STATS,
        messageName: 'System Stats',
        data: {
          received:  { sensorReading: Number(msg.received),  unit: 'pkt/s' },
          missing:   { sensorReading: Number(msg.missing),   unit: 'pkt/s' },
          recovered: { sensorReading: Number(msg.recovered), unit: 'pkt/s' },
        },
        rawData: '',
        timestamp: Date.now(),
      });
      return true;
    }

    // link_diagnostics: {"type": "ping"|"throughput"|"radio", ...}
    if ('type' in msg) {
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
            mbps:     { sensorReading: msg.mbps != null ? Number(msg.mbps) : -1, unit: 'Mbps' },
            loss_pct: { sensorReading: Number(msg.loss_pct ?? 0),                unit: '%'    },
            sent:     { sensorReading: Number(msg.sent     ?? 0),                unit: 'pkt'  },
            received: { sensorReading: Number(msg.received ?? 0),                unit: 'pkt'  },
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
            rssi_dbm: { sensorReading: Number(msg.rssi_dbm ?? 0), unit: 'dBm'  },
            tx_mbps:  { sensorReading: Number(msg.tx_mbps  ?? 0), unit: 'Mbps' },
            rx_mbps:  { sensorReading: Number(msg.rx_mbps  ?? 0), unit: 'Mbps' },
            ccq_pct:  { sensorReading: Number(msg.ccq_pct  ?? 0), unit: '%'    },
            error:    { sensorReading: msg.error ? 1 : 0,         unit: ''     },
          },
          rawData: typeof msg.error === 'string' ? msg.error : '',
          timestamp: ts,
        });
        return true;
      }
    }

    return false;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect'); // 1000 = normal closure
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public reconnect() {
    console.log('Forcing WebSocket reconnection...');
    this.disconnect();
    this.reconnectAttempts = 0;
    this.connect();
  }
}

export const webSocketService = new WebSocketService();