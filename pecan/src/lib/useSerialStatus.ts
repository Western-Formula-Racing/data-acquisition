import { useState, useEffect } from 'react';
import { serialService } from '../services/SerialService';

/**
 * Hook to reactively track the local serial connection status.
 */
export function useSerialStatus() {
    const [isConnected, setIsConnected] = useState(serialService.getConnectionStatus());

    useEffect(() => {
        const handler = (e: any) => {
            setIsConnected(e.detail.connected);
        };

        window.addEventListener('serial-connection-changed', handler);
        return () => {
            window.removeEventListener('serial-connection-changed', handler);
        };
    }, []);

    return isConnected;
}
