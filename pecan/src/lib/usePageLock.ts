import { useEffect, useState, useCallback, useRef } from 'react';
import { webSocketService } from '../services/WebSocketService';

export type PageLockInfo = {
  holder: string;
  name: string;
};

export type PageLockState = {
  /** Whether the current client holds the lock */
  isLockedByMe: boolean;
  /** Whether another client holds the lock */
  isLockedByOther: boolean;
  /** Info about who holds the lock (if anyone) */
  lockHolder: PageLockInfo | null;
  /** Our client ID as assigned by the server */
  clientId: string | null;
  /** Acquire the lock for this page */
  acquire: () => void;
  /** Release the lock for this page */
  release: () => void;
};

/**
 * Hook to coordinate page locking via the WebSocket server.
 * Prevents multiple users from simultaneously controlling CAN transmission pages.
 *
 * @param page - Page identifier (e.g. "can-transmitter", "throttle-mapper")
 * @param displayName - Human-readable name shown to other users (e.g. user's name or "Tab 1")
 */
export function usePageLock(page: string, displayName?: string): PageLockState {
  const [locks, setLocks] = useState<Record<string, PageLockInfo>>({});
  const [clientId, setClientId] = useState<string | null>(null);
  const nameRef = useRef(displayName ?? '');

  useEffect(() => {
    nameRef.current = displayName ?? '';
  }, [displayName]);

  useEffect(() => {
    const query = () => {
      webSocketService.send({ type: 'page_lock', action: 'query' });
    };

    const handleLockState = (msg: any) => {
      if (msg.locks) {
        setLocks(msg.locks);
      }
      if (msg.clientId) {
        setClientId(id => id ?? msg.clientId);
      }
    };

    const handleLockResult = (msg: any) => {
      // Grab our clientId from the first successful result (acquire/query response)
      if (msg.clientId) {
        setClientId(id => id ?? msg.clientId);
      }
      if (!msg.success) {
        console.warn(`[PageLock] Lock denied for ${msg.page} — held by ${msg.name || msg.holder}`);
      }
    };

    webSocketService.on('page_lock_state', handleLockState);
    webSocketService.on('page_lock_result', handleLockResult);
    // Re-query whenever the WebSocket (re)connects — this is how we get our clientId
    webSocketService.on('__connect__', query);

    // Query now if already connected, otherwise the __connect__ handler above will fire
    if (webSocketService.isConnected()) {
      query();
    }

    return () => {
      webSocketService.off('page_lock_state', handleLockState);
      webSocketService.off('page_lock_result', handleLockResult);
      webSocketService.off('__connect__', query);
    };
  }, []);

  // Auto-release on unmount (leaving the page)
  useEffect(() => {
    return () => {
      webSocketService.send({ type: 'page_lock', action: 'release', page });
    };
  }, [page]);

  const acquire = useCallback(() => {
    webSocketService.send({
      type: 'page_lock',
      action: 'acquire',
      page,
      name: nameRef.current,
    });
  }, [page]);

  const release = useCallback(() => {
    webSocketService.send({
      type: 'page_lock',
      action: 'release',
      page,
    });
  }, [page]);

  const lockInfo = locks[page] ?? null;
  const isLockedByMe = lockInfo !== null && clientId !== null && lockInfo.holder === clientId;
  const isLockedByOther = lockInfo !== null && !isLockedByMe;

  return {
    isLockedByMe,
    isLockedByOther,
    lockHolder: lockInfo,
    clientId,
    acquire,
    release,
  };
}
