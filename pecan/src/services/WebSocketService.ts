import { dataStore } from '../lib/DataStore';
import { createCanProcessor } from '../utils/canProcessor';

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
      const isGitHubPages = hostname.includes('github.io');
      const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
      // User request: 192.168.x.x is the Car Hotspot (Local), but other IPs (172.x, etc) are for testing against Cloud
      const isCarNetwork = hostname.startsWith('192.168.');

      if (isGitHubPages || (!isLocalhost && !isCarNetwork)) {
        // GitHub Pages OR non-local/non-car network (e.g. 172.x): use the production backend
        wsUrl = `wss://ws-wfr.0001200.xyz:9443`;
      } else {
        // Localhost or Car Network: use same hostname (local docker/car)
        wsUrl = `${protocol}://${hostname}:${port}`;
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
              const canId = msg.canId.toString();

              dataStore.ingestMessage({
                msgID: canId,
                messageName: msg.messageName || `CAN_${canId}`,
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

  disconnect() {
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect'); // 1000 = normal closure
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}

export const webSocketService = new WebSocketService();