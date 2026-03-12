import { createCanProcessor, formatCanId } from '../utils/canProcessor';
import { loggingService } from './LoggingService';

export type MessageHandler = (data: any) => void;

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
    try {
      this.processor = await createCanProcessor();
      console.log('CAN processor initialized');
    } catch (error) {
      console.error('Failed to initialize CAN processor:', error);
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
        wsUrl = `wss://ws-wfr.0001200.xyz:9443`;
      }
    }

    console.log(`Connecting to WebSocket: ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        this.messageCount = 0;
      };

      this.ws.onmessage = (event) => {
        try {
          const messageData = JSON.parse(event.data);
          
          if (messageData && typeof messageData === 'object' && messageData.type) {
            const listeners = this.messageListeners.get(messageData.type);
            if (listeners) {
              listeners.forEach(handler => handler(messageData));
            }
          }

          const decoded = this.processor.processWebSocketMessage(messageData);
          if (!decoded) return;

          this.messageCount++;
          const messages = Array.isArray(decoded) ? decoded : [decoded];

          messages.forEach(msg => {
            if (msg?.signals) {
              if (this.suppressIngestion) return;
              loggingService.logFrame(msg.time || Date.now(), msg.canId, msg.data);
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
        if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          setTimeout(() => this.connect(), this.reconnectDelay * this.reconnectAttempts);
        }
      };
    } catch (error) {
      console.error('WebSocket error:', error);
    }
  }

  send(data: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
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

  disconnect() {
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

export const webSocketService = new WebSocketService();