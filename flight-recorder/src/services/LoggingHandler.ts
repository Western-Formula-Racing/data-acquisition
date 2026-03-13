import { webSocketService } from './WebSocketService';
import { loggingService } from './LoggingService';

class LoggingHandler {
  private isInitialized = false;

  initialize() {
    if (this.isInitialized) return;
    
    webSocketService.on('decoded', (decoded: any) => {
      const messages = Array.isArray(decoded) ? decoded : [decoded];
      
      // Stamp with wall-clock time at FDR receipt.
      // The car's msg.time is relative (ms since ECU boot) and has no
      // meaning as a Unix timestamp — InfluxDB needs absolute epoch ms.
      const receivedAt = Date.now();
      messages.forEach(msg => {
        if (msg?.signals) {
          loggingService.logFrame(
            receivedAt,
            msg.canId,
            msg.rawBytes ?? []
          );
        }
      });
    });

    this.isInitialized = true;
    console.log('[LoggingHandler] Initialized');
  }
}

export const loggingHandler = new LoggingHandler();
