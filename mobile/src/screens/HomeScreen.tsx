import React, { useEffect } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CloudUpload, RefreshCw } from 'lucide-react-native';
import { registerDevice } from '../api/sync';
import { registerBackgroundSync } from '../tasks/backgroundSync';
import { useSync } from '../context/SyncContext';
import { useAuth } from '../context/AuthContext';
import { colors, radius, shadow, spacing } from '../theme';

const DEVICE_ID_KEY = 'apollo_device_id';

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

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

  const usedBytes = profile?.storage_used_bytes ?? 0;
  const quotaBytes = profile?.storage_quota_bytes ?? 0;
  const usedPct = quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : 0;
  const barColor = usedPct > 90 ? colors.error : usedPct > 70 ? colors.warning : colors.primary;

  return (
    <View style={styles.container}>
      {/* Storage card */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Storage</Text>
        <View style={styles.storageRow}>
          <Text style={styles.storageValue}>
            {formatBytes(usedBytes)}
          </Text>
          <Text style={styles.storageQuota}>
            {' '}/ {formatBytes(quotaBytes)}
          </Text>
        </View>
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${Math.min(usedPct, 100)}%` as any, backgroundColor: barColor }]} />
        </View>
        <Text style={styles.barLabel}>{usedPct.toFixed(1)}% used</Text>
      </View>

      {/* Backup card */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Camera Roll Backup</Text>

        {pendingCount > 0 && (
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: colors.warning }]} />
            <Text style={styles.statusText}>{pendingCount} photo{pendingCount !== 1 ? 's' : ''} waiting to upload</Text>
          </View>
        )}

        {lastSyncedAt && (
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: colors.success }]} />
            <Text style={styles.statusText}>
              Last synced {lastSyncedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        )}

        {lastError && (
          <View style={[styles.errorBox]}>
            <Text style={styles.errorBoxText}>{lastError}</Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.syncButton, isSyncing && styles.syncButtonDisabled]}
          onPress={triggerSync}
          disabled={isSyncing}
        >
          {isSyncing ? (
            <ActivityIndicator color={colors.surface} size="small" />
          ) : (
            <>
              <CloudUpload size={18} color={colors.surface} strokeWidth={2} style={styles.syncIcon} />
              <Text style={styles.syncButtonText}>Sync Now</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.md },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadow.md,
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
  },

  storageRow: { flexDirection: 'row', alignItems: 'baseline', marginBottom: spacing.sm },
  storageValue: { fontSize: 28, fontWeight: '700', color: colors.textPrimary },
  storageQuota: { fontSize: 16, color: colors.textSecondary },

  barTrack: {
    height: 8,
    backgroundColor: colors.border,
    borderRadius: radius.xl,
    overflow: 'hidden',
    marginBottom: spacing.xs,
  },
  barFill: { height: '100%', borderRadius: radius.xl },
  barLabel: { fontSize: 12, color: colors.textSecondary },

  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs },
  statusDot: { width: 7, height: 7, borderRadius: 4, marginRight: spacing.sm },
  statusText: { fontSize: 14, color: colors.textSecondary },

  errorBox: {
    backgroundColor: colors.errorBg,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  errorBoxText: { fontSize: 13, color: colors.error },

  syncButton: {
    flexDirection: 'row',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    padding: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  syncButtonDisabled: { opacity: 0.6 },
  syncIcon: { marginRight: spacing.sm },
  syncButtonText: { color: colors.surface, fontWeight: '600', fontSize: 15 },
});
