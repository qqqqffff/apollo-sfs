import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';
import { SyncService } from '../services/SyncService';

const CURSOR_KEY = 'apollo_sync_cursor';

interface SyncContextValue {
  pendingCount: number;
  lastSyncedAt: Date | null;
  isSyncing: boolean;
  lastError: string | null;
  triggerSync: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue>({
  pendingCount: 0,
  lastSyncedAt: null,
  isSyncing: false,
  lastError: null,
  triggerSync: async () => {},
});

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const syncServiceRef = useRef<SyncService | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    syncServiceRef.current = new SyncService({
      onPendingCountChange: setPendingCount,
    });
  }, [isAuthenticated]);

  const triggerSync = useCallback(async () => {
    if (!syncServiceRef.current || isSyncing) return;
    setIsSyncing(true);
    setLastError(null);
    try {
      await syncServiceRef.current.run();
      setLastSyncedAt(new Date());
    } catch (err) {
      setLastError(err instanceof Error ? err.message : 'sync failed');
    } finally {
      setIsSyncing(false);
    }
  }, [isSyncing]);

  return (
    <SyncContext.Provider value={{ pendingCount, lastSyncedAt, isSyncing, lastError, triggerSync }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  return useContext(SyncContext);
}
