import { webSocketService } from './WebSocketService';
import { loggingService } from './LoggingService';

class LoggingHandler {
  private isInitialized = false;

  initialize() {
    if (this.isInitialized) return;
    
    webSocketService.on('decoded', (decoded: any) => {
      const messages = Array.isArray(decoded) ? decoded : [decoded];
      
      messages.forEach(msg => {
        if (msg?.signals) {
          loggingService.logFrame(
            msg.time || Date.now(), 
            msg.canId, 
            msg.data // Using raw buffer data from processor
          );
        }
      });
    });

    this.isInitialized = true;
    console.log('[LoggingHandler] Initialized');
  }
}

export const loggingHandler = new LoggingHandler();
