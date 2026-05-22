import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerDevice } from '../api/sync';
import { registerBackgroundSync } from '../tasks/backgroundSync';
import { useSync } from '../context/SyncContext';
import { useAuth } from '../context/AuthContext';
import { Platform } from 'react-native';

const DEVICE_ID_KEY = 'apollo_device_id';

export default function HomeScreen() {
  const { profile } = useAuth();
  const { pendingCount, lastSyncedAt, isSyncing, lastError, triggerSync } = useSync();

  useEffect(() => {
    (async () => {
      const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
      if (!existing) {
        try {
          const device = await registerDevice(
            Platform.OS === 'ios' ? 'My iPhone' : 'My Android',
            Platform.OS === 'ios' ? 'ios' : 'android',
          );
          await AsyncStorage.setItem(DEVICE_ID_KEY, device.id);
        } catch {
          // device registration is best-effort
        }
      }
      await registerBackgroundSync();
    })();
  }, []);

  const usedPct =
    profile && profile.storage_quota_bytes > 0
      ? ((profile.storage_used_bytes / profile.storage_quota_bytes) * 100).toFixed(1)
      : '0';

  return (
    <View style={styles.container}>
      <Text style={styles.greeting}>Welcome, {profile?.username ?? '…'}</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Storage</Text>
        <Text style={styles.cardValue}>{usedPct}% used</Text>
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${Math.min(parseFloat(usedPct), 100)}%` as any }]} />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Camera Roll Backup</Text>
        {pendingCount > 0 && (
          <Text style={styles.pending}>{pendingCount} photos waiting to upload</Text>
        )}
        {lastSyncedAt && (
          <Text style={styles.lastSync}>Last synced: {lastSyncedAt.toLocaleTimeString()}</Text>
        )}
        {lastError && <Text style={styles.error}>{lastError}</Text>}

        <TouchableOpacity style={styles.syncButton} onPress={triggerSync} disabled={isSyncing}>
          {isSyncing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.syncButtonText}>Sync Now</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#f5f5f5' },
  greeting: { fontSize: 22, fontWeight: '700', marginBottom: 20 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  cardTitle: { fontSize: 14, color: '#666', marginBottom: 4 },
  cardValue: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  bar: { height: 8, backgroundColor: '#e5e7eb', borderRadius: 4, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: '#1a56db', borderRadius: 4 },
  pending: { color: '#f59e0b', fontWeight: '600', marginBottom: 4 },
  lastSync: { color: '#6b7280', fontSize: 13, marginBottom: 8 },
  error: { color: '#ef4444', fontSize: 13, marginBottom: 8 },
  syncButton: {
    backgroundColor: '#1a56db',
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  syncButtonText: { color: '#fff', fontWeight: '600' },
});
