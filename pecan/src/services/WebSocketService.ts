import { createCanProcessor } from '../utils/canProcessor';
import { listDBCFiles, fetchAndApplyDBC } from './DbcService';

export type MessageHandler = (data: any) => void;

/** localStorage: one WebSocket URL per line; 2+ lines enables failover with timeout. */
export const PECAN_WS_CANDIDATES_KEY = 'pecan-ws-candidates';

/**
 * Used when `pecan-ws-candidates` is unset/empty and there is no custom / Vite URL:
 * try track base station first, then the public demo relay.
 */
export const DEFAULT_WS_FAILOVER_URLS: readonly string[] = [
  'ws://10.71.1.10:9080',
  'wss://ws-demo.westernformularacing.org',
];

const WS_LAST_OK_KEY = 'pecan-ws-last-ok';
const CANDIDATE_TIMEOUT_MS = 2500;

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

    // 1. Initialize CAN processor FIRST
    try {
      if (!this.processor) {
        this.processor = await createCanProcessor();
        console.log('[WebSocket] CAN processor initialized');
      }
    } catch (error) {
      console.error('[WebSocket] Failed to initialize CAN processor:', error);
      return;
    }

    // 2. Load DBC (internal mode only)
    if (import.meta.env.VITE_INTERNAL) {
      try {
        const saved = localStorage.getItem('dbc-selected-file');
        const listResult = await listDBCFiles();
        if (listResult.ok && listResult.files && listResult.files.length > 0) {
          const target =
            listResult.files.find((f) => f.name === saved) ?? listResult.files[0];
          const applyResult = await fetchAndApplyDBC(target.name);
          console.log(
            '[WebSocket] DBC loaded:',
            applyResult.message,
            applyResult.commitSha ?? ''
          );
        } else {
          console.warn('[WebSocket] Could not list DBC files:', listResult.message);
        }
      } catch (err) {
        console.warn('[WebSocket] DBC fetch failed, using cached/default:', err);
      }
    }

    // 3. Connect WebSocket
    await this.connect();
  }

  private getPrimaryWsUrl(): string {
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

    return this.normalizeWsUrl(wsUrl, protocol);
  }

  private normalizeWsUrl(wsUrl: string, defaultProtocol?: string): string {
    const isSecure = window.location.protocol === 'https:';
    const protocol = defaultProtocol ?? (isSecure ? 'wss' : 'ws');
    let out = wsUrl;
    if (out && !out.startsWith('ws://') && !out.startsWith('wss://')) {
      out = `${protocol}://${out}`;
    }
    return out;
  }

  private resolveCandidateUrls(): string[] {
    const isSecure = window.location.protocol === 'https:';
    const protocol = isSecure ? 'wss' : 'ws';

    const raw = localStorage.getItem(PECAN_WS_CANDIDATES_KEY);
    if (raw?.trim()) {
      const lines = raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (lines.length >= 1) {
        return lines.map((u) => this.normalizeWsUrl(u, protocol));
      }
    }

    if (localStorage.getItem('custom-ws-url')?.trim()) {
      return [this.getPrimaryWsUrl()];
    }

    if (import.meta.env.VITE_WS_URL) {
      return [this.getPrimaryWsUrl()];
    }

    return DEFAULT_WS_FAILOVER_URLS.map((u) =>
      this.normalizeWsUrl(u, protocol)
    );
  }

  private orderFailoverCandidates(urls: string[]): string[] {
    if (urls.length < 2) return urls;
    try {
      const last = sessionStorage.getItem(WS_LAST_OK_KEY);
      if (last && urls.includes(last)) {
        return [last, ...urls.filter((u) => u !== last)];
      }
    } catch {
      /* ignore */
    }
    return urls;
  }

  private tryConnectUrl(url: string, timeoutMs: number): Promise<WebSocket | null> {
    return new Promise((resolve) => {
      let settled = false;

      const done = (sock: WebSocket | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(tid);
        resolve(sock);
      };

      let sock: WebSocket;
      try {
        sock = new WebSocket(url);
      } catch {
        done(null);
        return;
      }

      const tid = window.setTimeout(() => {
        try {
          sock.close();
        } catch {}
        done(null);
      }, timeoutMs);

      sock.onopen = () => done(sock);
      sock.onerror = () => {
        if (sock.readyState !== WebSocket.OPEN) done(null);
      };
    });
  }

  private async connect() {
    const urls = this.resolveCandidateUrls();
    if (urls.length >= 2) {
      await this.connectWithFailover(urls);
    } else {
      this.startSingleConnection(urls[0]);
    }
  }

  private async connectWithFailover(urls: string[]) {
    let toTry = this.orderFailoverCandidates(urls);

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const lanFirst = toTry.filter((u) => u.startsWith('ws://'));
      const rest = toTry.filter((u) => !u.startsWith('ws://'));
      toTry = [...lanFirst, ...rest];
    }

    console.log('[WebSocket] Failover mode, candidates:', toTry);

    for (let i = 0; i < toTry.length; i++) {
      const url = toTry[i];
      console.log(`[WebSocket] Trying (${i + 1}/${toTry.length}): ${url}`);
      const sock = await this.tryConnectUrl(url, CANDIDATE_TIMEOUT_MS);

      if (sock) {
        this.ws = sock;
        this.bindSocketHandlers(sock, url);
        return;
      }
    }

    console.error('[WebSocket] All candidate URLs failed');
    this.notify('status', {
      connected: false,
      url: '',
      error: 'All WebSocket candidates failed',
    });
  }

  private startSingleConnection(wsUrl: string) {
    console.log(`[WebSocket] Connecting to: ${wsUrl}`);
    try {
      this.ws = new WebSocket(wsUrl);
      this.bindSocketHandlers(this.ws, wsUrl);
    } catch (error) {
      console.error('[WebSocket] Connection failed:', error);
      this.notify('status', { connected: false, url: wsUrl, error: String(error) });
    }
  }

  private bindSocketHandlers(socket: WebSocket, wsUrl: string) {
    socket.onopen = () => {
      console.log('[WebSocket] Connected');
      try {
        sessionStorage.setItem(WS_LAST_OK_KEY, wsUrl);
      } catch {}
      this.reconnectAttempts = 0;
      this.messageCount = 0;
      this.notify('__connect__', {});
      this.notify('status', { connected: true, url: wsUrl });
    };

    socket.onmessage = (event) => {
      try {
        if (this.messageCount < 3) {
          console.log(`[WebSocket] Message #${this.messageCount + 1}:`, event.data);
        }

        if (
          this.messageCount === 10 ||
          this.messageCount === 100 ||
          (this.messageCount > 0 && this.messageCount % 1000 === 0)
        ) {
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
            console.log(`[WebSocket] Decoded message(s):`, decoded);
          }
          this.notify('decoded', decoded);
        }

        this.messageCount++;
      } catch (error) {
        console.error('[WebSocket] Error processing message:', error);
      }
    };

    socket.onerror = () => {
      this.notify('status', { connected: false, url: wsUrl, error: 'Connection error' });
    };

    socket.onclose = (event) => {
      this.notify('status', {
        connected: false,
        url: wsUrl,
        error: `Socket closed (code: ${event.code})`,
      });

      if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        setTimeout(() => void this.connect(), this.reconnectDelay * this.reconnectAttempts);
      }
    };
  }

  send(data: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  sendCanMessage(canId: number, data: number[], ref: string): boolean {
    if (!this.isConnected()) return false;
    this.send({ type: 'can_send', ref, canId, data });
    return true;
  }

  sendCanBatch(messages: Array<{ canId: number; data: number[] }>, ref: string): boolean {
    if (!this.isConnected()) return false;
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
      listeners.forEach((handler) => handler(data));
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close(1000, 'Manual disconnect');
      this.ws = null;
    }
  }

  public reconnect() {
    this.disconnect();
    this.reconnectAttempts = 0;
    void this.connect();
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public setSuppressIngestion(suppress: boolean) {
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