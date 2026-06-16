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
  etaSeconds: number | null;
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
  etaSeconds: null,
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
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const syncStartRef = useRef<{ time: number; syncedCountAtStart: number } | null>(null);
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

  // Recompute ETA whenever pending/synced counts change during an active sync.
  // Rate = files completed this run / elapsed seconds; ETA = remaining / rate.
  useEffect(() => {
    if (!isSyncing || !syncStartRef.current) { setEtaSeconds(null); return; }
    const completed = syncedCount - syncStartRef.current.syncedCountAtStart;
    if (completed < 1) return;
    const elapsed = (Date.now() - syncStartRef.current.time) / 1000;
    if (elapsed < 2) return;
    const rate = completed / elapsed;
    setEtaSeconds(rate > 0 ? Math.round(pendingCount / rate) : null);
  }, [isSyncing, syncedCount, pendingCount]);

  const triggerSync = useCallback(async () => {
    if (!syncServiceRef.current || isSyncing) return;
    syncStartRef.current = { time: Date.now(), syncedCountAtStart: syncedCount };
    setEtaSeconds(null);
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
      setEtaSeconds(null);
    }
  }, [isSyncing, syncedCount]);

  const scanForPreview = useCallback(async (): Promise<PreviewItem[]> => {
    if (!syncServiceRef.current) return [];
    return syncServiceRef.current.scanForPreview();
  }, []);

  const confirmSync = useCallback(async (items: PreviewItem[]) => {
    if (!syncServiceRef.current || isSyncing) return;
    syncStartRef.current = { time: Date.now(), syncedCountAtStart: syncedCount };
    setEtaSeconds(null);
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
      setEtaSeconds(null);
    }
  }, [isSyncing, syncedCount]);

  return (
    <SyncContext.Provider value={{ pendingCount, syncedCount, inProgressFiles, lastSyncedAt, isSyncing, lastError, etaSeconds, triggerSync, scanForPreview, confirmSync }}>
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  return useContext(SyncContext);
}
