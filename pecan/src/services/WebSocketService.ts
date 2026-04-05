import { createCanProcessor } from '../utils/canProcessor';
import { listDBCFiles, fetchAndApplyDBC } from './DbcService';

export type MessageHandler = (data: any) => void;

/** Server response after a successful `can_send` / `can_send_batch`. */
export type UplinkAckMessage = {
  type: 'uplink_ack';
  ref: string;
  status: 'queued' | 'sent' | string;
  reason: string | null;
};

/** Server error payload for failed uplink or protocol errors. */
export type WsErrorMessage = {
  type: 'error';
  code: string;
  message: string;
};

export interface ConnectionStatus {
  connected: boolean;
  url: string;
  error?: string;
}

export class WebSocketService {
  private ws: WebSocket | null = null;
  private processor: any = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000;
  private messageCount = 0; 
  private messageListeners = new Map<string, Set<MessageHandler>>();
  private suppressIngestion = false;

  async initialize() {
    this.disconnect();

    if (import.meta.env.VITE_INTERNAL) {
      try {
        const saved = localStorage.getItem('dbc-selected-file');
        const listResult = await listDBCFiles();
        if (listResult.ok && listResult.files && listResult.files.length > 0) {
          const target = listResult.files.find(f => f.name === saved) ?? listResult.files[0];
          const applyResult = await fetchAndApplyDBC(target.name);
          console.log('[WebSocket] DBC loaded:', applyResult.message, applyResult.commitSha ?? '');
        } else {
          console.warn('[WebSocket] Could not list DBC files:', listResult.message);
        }
      } catch (err) {
        console.warn('[WebSocket] DBC fetch failed, using cached/default:', err);
      }
    }

    try {
      if (!this.processor) {
        this.processor = await createCanProcessor();
        console.log('[WebSocket] CAN processor initialized');
      }
    } catch (error) {
      console.error('[WebSocket] Failed to initialize CAN processor:', error);
      return;
    }
    this.connect();
  }

  private connect() {
    const isSecure = window.location.protocol === 'https:';
    const protocol = isSecure ? 'wss' : 'ws';
    const port = isSecure ? '9443' : '9080';

    let wsUrl: string;
    const customUrl = localStorage.getItem('custom-ws-url');
    
    if (customUrl) {
      wsUrl = customUrl;
    } else if (import.meta.env.VITE_WS_URL) {
      wsUrl = import.meta.env.VITE_WS_URL;
    } else {
      const hostname = window.location.hostname;
      const isRpiNetwork = hostname.startsWith('192.');
      if (isRpiNetwork) {
        wsUrl = `${protocol}://${hostname}:${port}`;
      } else {
        wsUrl = `wss://ws-demo.westernformularacing.org`;
      }
    }

    // Ensure protocol is present (especially for custom URLs)
    if (wsUrl && !wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
      wsUrl = `${protocol}://${wsUrl}`;
    }

    console.log(`[WebSocket] Connecting to: ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[WebSocket] Connected');
        this.reconnectAttempts = 0;
        this.messageCount = 0;
        this.notify('__connect__', {});
        this.notify('status', { connected: true, url: wsUrl });
      };

      this.ws.onmessage = (event) => {
        try {
          // Milestone and initial message logging (replicated from original pecan)
          if (this.messageCount < 3) {
            console.log(`[WebSocket] Message #${this.messageCount + 1}:`, event.data);
          }
          if (this.messageCount === 10 || this.messageCount === 100 || (this.messageCount > 0 && this.messageCount % 1000 === 0)) {
            console.log(`[WebSocket] Received ${this.messageCount} messages`);
          }

          const messageData = JSON.parse(event.data);
          
          if (messageData?.type) {
            this.notify(messageData.type, messageData);
          }
          this.notify('raw', messageData);

          const decoded = this.processor.processWebSocketMessage(messageData);
          if (decoded) {
            if (this.messageCount < 3) {
              console.log(`[WebSocket] Decoded message(s) #${this.messageCount + 1}:`, decoded);
            }
            this.notify('decoded', decoded);
          }
          
          this.messageCount++;
        } catch (error) {
          console.error('[WebSocket] Error processing message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('[WebSocket] Error:', error);
        this.notify('status', { connected: false, url: wsUrl, error: 'Connection error' });
      };

      this.ws.onclose = (event) => {
        console.log('[WebSocket] Disconnected');
        this.notify('status', { connected: false, url: wsUrl, error: `Socket closed (code: ${event.code})` });
        
        if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          setTimeout(() => this.connect(), this.reconnectDelay * this.reconnectAttempts);
        }
      };
    } catch (error) {
      console.error('[WebSocket] Connection failed:', error);
      this.notify('status', { connected: false, url: wsUrl, error: String(error) });
    }
  }

  send(data: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * Uplink: send one CAN frame (see WEBSOCKET_PROTOCOL.md).
   * @returns true if the message was queued on the socket
   */
  sendCanMessage(canId: number, data: number[], ref: string): boolean {
    if (!this.isConnected()) return false;
    console.log(`[WS →] can_send  canId=${canId}  ref=${ref}  data=[${data.join(', ')}]`);
    this.send({ type: 'can_send', ref, canId, data });
    return true;
  }

  /**
   * Uplink: send up to 20 CAN frames in one round-trip.
   */
  sendCanBatch(messages: Array<{ canId: number; data: number[] }>, ref: string): boolean {
    if (!this.isConnected()) return false;
    const summary = messages.map(m => `${m.canId}:[${m.data.join(',')}]`).join(' | ');
    console.log(`[WS →] can_send_batch  ref=${ref}  msgs=${messages.length}  ${summary}`);
    this.send({ type: 'can_send_batch', ref, messages });
    return true;
  }

  on(type: string, handler: MessageHandler) {
    if (!this.messageListeners.has(type)) {
      this.messageListeners.set(type, new Set());
    }
    this.messageListeners.get(type)!.add(handler);
  }

  off(type: string, handler: MessageHandler) {
    this.messageListeners.get(type)?.delete(handler);
  }

  private notify(type: string, data: any) {
    const listeners = this.messageListeners.get(type);
    if (listeners) {
      listeners.forEach(handler => handler(data));
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close(1000, 'Manual disconnect');
      this.ws = null;
    }
  }

  public reconnect() {
    console.log('[WebSocket] Forcing reconnection...');
    this.disconnect();
    this.reconnectAttempts = 0;
    this.connect();
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public setSuppressIngestion(suppress: boolean) {
    console.log(`[WebSocket] Ingestion suppression: ${suppress}`);
    this.suppressIngestion = suppress;
  }

  public isIngestionSuppressed(): boolean {
    return this.suppressIngestion;
  }
  
  public getMessageCount(): number {
    return this.messageCount;
  }
}

export const webSocketService = new WebSocketService();