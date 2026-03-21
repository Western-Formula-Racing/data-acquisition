/**
 * TxWebSocketService — dedicated WebSocket for the CAN Transmitter page.
 *
 * Connects to the TX bridge on port 9078 (separate from the main RX WS on 9080).
 * Handles two message types:
 *   - can_preview_signals : ask the backend to encode signals -> bytes (no CAN write)
 *   - can_send_signals     : encode signals AND write to CAN bus
 *
 * This service is the SAFETY GATE — transmission functions are disabled when
 * this service is not connected.
 */


export type PreviewMessage = {
  type: 'preview';
  canId: number;
  bytes: number[];
  ok: boolean;
};

export type UplinkAckMessage = {
  type: 'uplink_ack';
  ref: string;
  status: 'sent' | string;
  bytes?: number[];
};

export type TxWsErrorMessage = {
  type: 'error';
  code: string;
  message: string;
};

export type TxHandler = (data: PreviewMessage | UplinkAckMessage | TxWsErrorMessage) => void;

const TX_WS_PORT = 9078;

function buildTxWsUrl(): string {
  const isSecure = window.location.protocol === 'https:';
  const protocol = isSecure ? 'wss' : 'ws';
  const hostname = window.location.hostname;
  // TX WS always runs alongside UTS on the same host; same port convention
  return `${protocol}://${hostname}:${TX_WS_PORT}`;
}

export class TxWebSocketService {
  private ws: WebSocket | null = null;
  private url = '';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000;
  private listeners = new Set<TxHandler>();
  private _connected = false;

  get connected() {
    return this._connected;
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.url = buildTxWsUrl();
    console.log(`[TxWS] Connecting to: ${this.url}`);

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log('[TxWS] Connected');
        this._connected = true;
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as
            | PreviewMessage
            | UplinkAckMessage
            | TxWsErrorMessage
            | { type: 'pong'; timestamp?: number; serverTime?: number };
          console.log(`[TxWS ←] ${data.type}`, data.type === 'pong' || data.type === 'preview' ? '' : data);
          this.listeners.forEach(h => h(data as TxHandler extends (arg: infer A) => void ? A : never));
        } catch {
          console.error('[TxWS] Failed to parse message', event.data);
        }
      };

      this.ws.onerror = () => {
        console.error('[TxWS] Error');
      };

      this.ws.onclose = (event) => {
        console.log(`[TxWS] Disconnected (code: ${event.code})`);
        this._connected = false;
        if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          setTimeout(() => this.connect(), this.reconnectDelay * this.reconnectAttempts);
        }
      };
    } catch (err) {
      console.error('[TxWS] Connection failed:', err);
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close(1000, 'Manual disconnect');
      this.ws = null;
      this._connected = false;
    }
  }

  onMessage(handler: TxHandler) {
    this.listeners.add(handler);
  }

  offMessage(handler: TxHandler) {
    this.listeners.delete(handler);
  }

  private send(data: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * Ask the TX bridge to encode signal values -> CAN bytes (no CAN bus write).
   * The bridge responds with a `preview` message containing the encoded bytes.
   */
  private _uuid(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  previewSignals(canId: number, signals: Record<string, number>, ref?: string): boolean {
    if (!this._connected) {
      console.warn('[TxWS] Not connected — cannot send preview');
      return false;
    }
    const r = ref ?? `prev-${this._uuid()}`;
    console.log(`[TxWS →] can_preview_signals  canId=${canId}  ref=${r}  signals=${JSON.stringify(signals)}`);
    this.send({ type: 'can_preview_signals', ref: r, canId, signals });
    return true;
  }

  /**
   * Ask the TX bridge to encode AND write signals to the CAN bus.
   * The bridge responds with an `uplink_ack` on success.
   */
  sendSignals(canId: number, signals: Record<string, number>, ref?: string): boolean {
    if (!this._connected) {
      console.warn('[TxWS] Not connected — cannot send');
      return false;
    }
    const r = ref ?? `send-${this._uuid()}`;
    console.log(`[TxWS →] can_send_signals  canId=${canId}  ref=${r}  signals=${JSON.stringify(signals)}`);
    this.send({ type: 'can_send_signals', ref: r, canId, signals });
    return true;
  }

  isConnected(): boolean {
    return this._connected;
  }
}

export const txWebSocketService = new TxWebSocketService();
