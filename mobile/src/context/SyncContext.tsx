import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { SyncService, type PreviewItem } from '../services/SyncService';
import { countByStatus } from '../services/UploadQueue';

interface SyncContextValue {
  pendingCount: number;
  syncedCount: number;
  inProgressFiles: string[];
  lastSyncedAt: Date | null;
  isSyncing: boolean;
  lastError: string | null;
  triggerSync: () => Promise<void>;
  scanForPreview: () => Promise<PreviewItem[]>;
  confirmSync: (items: PreviewItem[]) => Promise<void>;
}

const SyncContext = createContext<SyncContextValue>({
  pendingCount: 0,
  syncedCount: 0,
  inProgressFiles: [],
  lastSyncedAt: null,
  isSyncing: false,
  lastError: null,
  triggerSync: async () => {},
  scanForPreview: async () => [],
  confirmSync: async () => {},
});

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);
  const [syncedCount, setSyncedCount] = useState(0);
  const [inProgressFiles, setInProgressFiles] = useState<string[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const syncServiceRef = useRef<SyncService | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;
    syncServiceRef.current = new SyncService({
      onPendingCountChange: setPendingCount,
      onSyncedCountChange: setSyncedCount,
      onFileStart: (filename) =>
        setInProgressFiles((prev) => (prev.includes(filename) ? prev : [...prev, filename])),
      onFileComplete: (filename) =>
        setInProgressFiles((prev) => prev.filter((f) => f !== filename)),
    });
    countByStatus('pending').then(setPendingCount).catch(() => {});
    countByStatus('done').then(setSyncedCount).catch(() => {});
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
      setInProgressFiles([]);
    }
  }, [isSyncing]);

  const scanForPreview = useCallback(async (): Promise<PreviewItem[]> => {
    if (!syncServiceRef.current) return [];
    return syncServiceRef.current.scanForPreview();
  }, []);

  const confirmSync = useCallback(async (items: PreviewItem[]) => {
    if (!syncServiceRef.current || isSyncing) return;
    setIsSyncing(true);
    setLastError(null);
    try {
      await syncServiceRef.current.runSelected(items);
      setLastSyncedAt(new Date());
    } catch (err) {
      setLastError(err instanceof Error ? err.message : 'sync failed');
    } finally {
      setIsSyncing(false);
      setInProgressFiles([]);
    }
  }, [isSyncing]);

  return (
    <SyncContext.Provider value={{ pendingCount, syncedCount, inProgressFiles, lastSyncedAt, isSyncing, lastError, triggerSync, scanForPreview, confirmSync }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  return useContext(SyncContext);
}
