import { webSocketService } from './WebSocketService';
import type { ConnectionStatus } from './WebSocketService';

export interface RelayStatus {
  enabled: boolean;
  connected: boolean;
  url: string;
  viewerUrl: string;
  room: string;
  forwarded: number;
  error?: string;
}

type RelayStatusHandler = (status: RelayStatus) => void;

export interface RelaySession {
  room: string;
  ingestUrl: string;
  viewerUrl: string;
}

const HEARTBEAT_CAN_ID = 0x7FD;
const HEARTBEAT_BYTES = [0xFA, 0xAA, 0xFA, 0xAA, 0, 0, 0, 0];
const DEMO_WS_HOST = 'ws-demo.westernformularacing.org';

class LiveRelayService {
  private ws: WebSocket | null = null;
  private enabled = false;
  private url = '';
  private viewerUrl = '';
  private room = '';
  private forwarded = 0;
  private listeners = new Set<RelayStatusHandler>();
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private sourceUrl = '';
  private readonly handleWireMessage = (raw: string) => this.forward(raw);
  private readonly handleSourceStatus = (status: ConnectionStatus) => {
    this.sourceUrl = status.url;
    this.emit();
  };

  initialize() {
    this.url = localStorage.getItem('live-relay-url') || '';
    this.viewerUrl = localStorage.getItem('live-relay-viewer-url') || '';
    this.room = localStorage.getItem('live-relay-room') || '';
    this.enabled = localStorage.getItem('live-relay-enabled') === 'true';
    webSocketService.on('wire', this.handleWireMessage);
    webSocketService.on('status', this.handleSourceStatus);
    if (this.enabled && this.url) {
      this.connect();
    } else {
      this.emit();
    }
  }

  shutdown() {
    webSocketService.off('wire', this.handleWireMessage);
    webSocketService.off('status', this.handleSourceStatus);
    this.disconnect();
    this.listeners.clear();
  }

  setConfig(url: string, enabled: boolean) {
    this.url = url.trim();
    this.enabled = enabled;
    localStorage.setItem('live-relay-url', this.url);
    localStorage.setItem('live-relay-enabled', String(enabled));

    if (this.enabled && this.url) {
      this.connect();
    } else {
      this.disconnect();
      this.emit();
    }
  }

  async createSession(workerUrl: string): Promise<RelaySession> {
    const sessionUrl = this.sessionUrlFromInput(workerUrl);
    const response = await fetch(sessionUrl.toString(), { method: 'POST' });
    if (!response.ok) {
      throw new Error(`Relay session failed: ${response.status} ${response.statusText}`);
    }

    const session = await response.json() as RelaySession;
    this.url = session.ingestUrl;
    this.viewerUrl = session.viewerUrl;
    this.room = session.room;
    localStorage.setItem('live-relay-url', this.url);
    localStorage.setItem('live-relay-viewer-url', this.viewerUrl);
    localStorage.setItem('live-relay-room', this.room);
    return session;
  }

  getStatus(): RelayStatus {
    return {
      enabled: this.enabled,
      connected: this.ws?.readyState === WebSocket.OPEN,
      url: this.url,
      viewerUrl: this.viewerUrl,
      room: this.room,
      forwarded: this.forwarded,
    };
  }

  onStatus(handler: RelayStatusHandler) {
    this.listeners.add(handler);
  }

  offStatus(handler: RelayStatusHandler) {
    this.listeners.delete(handler);
  }

  private connect() {
    this.disconnect();
    if (!this.url) {
      this.emit('Relay URL is empty');
      return;
    }

    let relayUrl = this.url;
    if (!relayUrl.startsWith('ws://') && !relayUrl.startsWith('wss://')) {
      relayUrl = `wss://${relayUrl}`;
    }

    try {
      this.ws = new WebSocket(relayUrl);

      this.ws.onopen = () => {
        this.url = relayUrl;
        this.forwarded = 0;
        this.startHeartbeat();
        this.emit();
      };

      this.ws.onerror = () => {
        this.emit('Live relay connection error');
      };

      this.ws.onclose = (event) => {
        const shouldReconnect = this.enabled && event.code !== 1000;
        this.emit(shouldReconnect ? `Live relay closed (${event.code}); retrying` : undefined);
        if (shouldReconnect) {
          this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
        }
      };
    } catch (error) {
      this.emit(error instanceof Error ? error.message : String(error));
    }
  }

  private disconnect(clearTimer = true) {
    if (clearTimer && this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'Relay disabled');
      this.ws = null;
    }
  }

  private forward(raw: string) {
    if (!this.enabled || this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.isDemoSource()) return;
    this.ws.send(raw);
    this.forwarded += 1;
    if (this.forwarded <= 5 || this.forwarded % 100 === 0) {
      this.emit();
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.sendHeartbeat();
    this.heartbeatTimer = window.setInterval(() => this.sendHeartbeat(), 1000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat() {
    const heartbeat = JSON.stringify([{
      time: Date.now(),
      canId: HEARTBEAT_CAN_ID,
      data: HEARTBEAT_BYTES,
    }]);
    if (!this.enabled || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(heartbeat);
    this.forwarded += 1;
    if (this.forwarded <= 5 || this.forwarded % 100 === 0) {
      this.emit();
    }
  }

  private isDemoSource(): boolean {
    return this.sourceUrl.includes(DEMO_WS_HOST);
  }

  private sessionUrlFromInput(input: string): URL {
    const trimmed = input.trim();
    if (!trimmed) throw new Error('Relay Worker URL is empty');

    const withScheme = trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('ws://') ||
      trimmed.startsWith('wss://')
      ? trimmed
      : `https://${trimmed}`;
    const url = new URL(withScheme);
    url.protocol = url.protocol === 'ws:' || url.protocol === 'http:' ? 'https:' : 'https:';
    url.pathname = '/session';
    url.search = '';
    url.hash = '';
    return url;
  }

  private emit(error?: string) {
    const status = { ...this.getStatus(), error };
    this.listeners.forEach((handler) => handler(status));
  }
}

export const liveRelayService = new LiveRelayService();
