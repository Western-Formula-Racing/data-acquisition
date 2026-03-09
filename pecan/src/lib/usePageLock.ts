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
    const handleLockState = (msg: any) => {
      if (msg.locks) {
        setLocks(msg.locks);
      }
      if (msg.clientId) {
        setClientId(msg.clientId);
      }
    };

    const handleLockResult = (msg: any) => {
      // If acquire failed we'll get the updated state via broadcast anyway
      if (!msg.success) {
        console.warn(`[PageLock] Lock denied for ${msg.page} — held by ${msg.name || msg.holder}`);
      }
    };

    webSocketService.on('page_lock_state', handleLockState);
    webSocketService.on('page_lock_result', handleLockResult);

    // Query current state on mount
    webSocketService.send({ type: 'page_lock', action: 'query' });

    return () => {
      webSocketService.off('page_lock_state', handleLockState);
      webSocketService.off('page_lock_result', handleLockResult);
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
