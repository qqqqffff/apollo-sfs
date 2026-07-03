import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Check, ChevronRight, Clock, HardDrive, Moon, RefreshCw, Wifi, Zap } from 'lucide-react-native';
import {
  NIGHTSYNC_DEFAULT_HOUR,
  NIGHTSYNC_HOUR_KEY,
  NIGHTSYNC_KEY,
} from '../tasks/backgroundSync';
import {
  getStorageBreakdown,
  listMyServers,
  pingServer,
  runSpeedTest,
  setPrimaryServer,
  type MyServer,
  type SpeedMetrics,
  type StorageBreakdown,
} from '../api/storage';
import { colors, radius, shadow, spacing } from '../theme';

const WIFI_ONLY_KEY = 'apollo_wifi_only';
const SPEED_RATE_LIMIT = 5; // must match backend limit

function formatHour(h: number): string {
  if (h === 0) return '12:00 AM';
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return '12:00 PM';
  return `${h - 12}:00 PM`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

function formatMbps(mbps: number | null): string {
  if (mbps === null) return '—';
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(1)} Gbps`;
  return `${mbps.toFixed(1)} Mbps`;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export default function SettingsScreen() {
  const [wifiOnly, setWifiOnly] = useState(false);
  const [nightSync, setNightSync] = useState(false);
  const [nightSyncHour, setNightSyncHour] = useState(NIGHTSYNC_DEFAULT_HOUR);
  const [hourPickerVisible, setHourPickerVisible] = useState(false);

  // Storage breakdown
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(true);

  // Owned servers (multi-drive) + primary selection
  const [myServers, setMyServers] = useState<MyServer[]>([]);
  const [settingPrimary, setSettingPrimary] = useState<string | null>(null); // server_id in flight
  const [primaryPingMs, setPrimaryPingMs] = useState<number | null>(null);
  const [primaryTesting, setPrimaryTesting] = useState(false);

  // Speed metrics
  const [speed, setSpeed] = useState<SpeedMetrics | null>(null);
  const [speedLoading, setSpeedLoading] = useState(false);
  const [speedError, setSpeedError] = useState<string | null>(null);

  // Local rate-limit tracking (mirrors backend's 5/min cap)
  const speedCallsRef = useRef<number[]>([]); // timestamps of recent calls

  const remainingSpeedTests = (): number => {
    const now = Date.now();
    speedCallsRef.current = speedCallsRef.current.filter((t) => now - t < 60_000);
    return SPEED_RATE_LIMIT - speedCallsRef.current.length;
  };

  const [speedRemaining, setSpeedRemaining] = useState(SPEED_RATE_LIMIT);

  const refreshSpeedRemaining = useCallback(() => {
    setSpeedRemaining(remainingSpeedTests());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pings the user's primary server and records the latency, surfacing a
  // "testing connection" state while in flight.
  const testPrimaryConnection = useCallback(async (servers: MyServer[]) => {
    const primary = servers.find((s) => s.is_primary);
    if (!primary) { setPrimaryPingMs(null); return; }
    setPrimaryTesting(true);
    try {
      setPrimaryPingMs(await pingServer(primary.ping_url));
    } catch {
      setPrimaryPingMs(null);
    } finally {
      setPrimaryTesting(false);
    }
  }, []);

  const loadBreakdown = useCallback(async () => {
    setBreakdownLoading(true);
    try {
      const [bd, servers] = await Promise.all([getStorageBreakdown(), listMyServers().catch(() => [])]);
      setBreakdown(bd);
      setMyServers(servers);
      testPrimaryConnection(servers);
    } catch {
      // leave stale data if any
    } finally {
      setBreakdownLoading(false);
    }
  }, [testPrimaryConnection]);

  const handleSelectPrimary = useCallback(async (server: MyServer) => {
    if (server.is_primary || settingPrimary) return;
    setSettingPrimary(server.server_id);
    setPrimaryTesting(true);
    try {
      await setPrimaryServer(server.server_id);
      const servers = await listMyServers();
      setMyServers(servers);
      await testPrimaryConnection(servers);
    } catch {
      // keep previous selection on failure
    } finally {
      setSettingPrimary(null);
    }
  }, [settingPrimary, testPrimaryConnection]);

  const runSpeed = useCallback(async () => {
    if (speedLoading) return;
    refreshSpeedRemaining();
    if (speedRemaining <= 0) {
      setSpeedError('Limit reached. Try again in a minute.');
      return;
    }
    setSpeedLoading(true);
    setSpeedError(null);
    speedCallsRef.current.push(Date.now());
    refreshSpeedRemaining();

    const pingUrl = breakdown?.server?.ping_url ?? null;
    try {
      const result = await runSpeedTest(pingUrl ?? '/api/v1/storage/servers');
      setSpeed(result);
    } catch (e: any) {
      if (e?.code === 'RATE_LIMITED') {
        setSpeedError('Limit reached. Try again in a minute.');
      } else {
        setSpeedError('Speed test failed. Check your connection.');
      }
    } finally {
      setSpeedLoading(false);
      refreshSpeedRemaining();
    }
  }, [speedLoading, speedRemaining, breakdown, refreshSpeedRemaining]);

  // Load preferences on mount
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(WIFI_ONLY_KEY),
      AsyncStorage.getItem(NIGHTSYNC_KEY),
      AsyncStorage.getItem(NIGHTSYNC_HOUR_KEY),
    ]).then(([wifi, night, hour]) => {
      setWifiOnly(wifi === 'true');
      setNightSync(night === 'true');
      if (hour !== null) setNightSyncHour(parseInt(hour, 10));
    });

    loadBreakdown();
  }, [loadBreakdown]);

  // Run speed test automatically once breakdown (and thus server ping_url) is ready
  useEffect(() => {
    if (breakdown !== null && speed === null && !speedLoading) {
      runSpeed();
    }
  }, [breakdown]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleWifi = async (value: boolean) => {
    setWifiOnly(value);
    await AsyncStorage.setItem(WIFI_ONLY_KEY, value ? 'true' : 'false');
  };

  const toggleNightSync = async (value: boolean) => {
    setNightSync(value);
    await AsyncStorage.setItem(NIGHTSYNC_KEY, value ? 'true' : 'false');
  };

  const selectHour = async (h: number) => {
    setNightSyncHour(h);
    setHourPickerVisible(false);
    await AsyncStorage.setItem(NIGHTSYNC_HOUR_KEY, String(h));
  };

  const nvmePct = breakdown
    ? breakdown.quota_bytes > 0
      ? Math.min((breakdown.nvme_bytes / breakdown.quota_bytes) * 100, 100)
      : 0
    : 0;
  const hddPct = breakdown
    ? breakdown.quota_bytes > 0
      ? Math.min((breakdown.hdd_bytes / breakdown.quota_bytes) * 100, 100)
      : 0
    : 0;

  // Only show the storage types the user actually owns. When the server list
  // hasn't loaded yet (or is empty) fall back to showing both, as before.
  const ownedTypes = new Set(myServers.map((s) => s.drive_type));
  const showNvme = ownedTypes.size === 0 || ownedTypes.has('nvme');
  const showHdd = ownedTypes.size === 0 || ownedTypes.has('hdd');

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={breakdownLoading} onRefresh={loadBreakdown} />}
    >
      {/* ── Backup ── */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Backup</Text>

        <View style={styles.row}>
          <View style={[styles.iconWrap, wifiOnly && styles.iconWrapActive]}>
            <Wifi size={18} color={wifiOnly ? colors.primary : colors.textMuted} strokeWidth={1.5} />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Wi-Fi only</Text>
            <Text style={styles.rowMeta}>Only sync when connected to Wi-Fi</Text>
          </View>
          <Switch
            value={wifiOnly}
            onValueChange={toggleWifi}
            trackColor={{ false: colors.border, true: colors.primaryLight }}
            thumbColor={wifiOnly ? colors.primary : colors.textMuted}
          />
        </View>

        <View style={styles.separator} />

        <View style={styles.row}>
          <View style={[styles.iconWrap, nightSync && styles.iconWrapNight]}>
            <Moon size={18} color={nightSync ? colors.mediaAccent : colors.textMuted} strokeWidth={1.5} />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Night backup</Text>
            <Text style={styles.rowMeta}>Auto-sync once daily when storage is below 75% full</Text>
          </View>
          <Switch
            value={nightSync}
            onValueChange={toggleNightSync}
            trackColor={{ false: colors.border, true: colors.mediaAccentLighter }}
            thumbColor={nightSync ? colors.mediaAccent : colors.textMuted}
          />
        </View>

        {nightSync && (
          <>
            <View style={styles.separator} />
            <TouchableOpacity style={styles.row} onPress={() => setHourPickerVisible(true)}>
              <View style={[styles.iconWrap, styles.iconWrapNight]}>
                <Clock size={18} color={colors.mediaAccent} strokeWidth={1.5} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>Sync time</Text>
                <Text style={styles.rowMeta}>Runs within a 2-hour window of this time</Text>
              </View>
              <View style={styles.hourChip}>
                <Text style={styles.hourChipText}>{formatHour(nightSyncHour)}</Text>
                <ChevronRight size={14} color={colors.mediaAccent} style={{ marginLeft: 2 }} />
              </View>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* ── Storage breakdown ── */}
      <View style={[styles.section, { marginTop: spacing.md }]}>
        <Text style={styles.sectionTitle}>Storage</Text>

        {breakdownLoading && !breakdown ? (
          <ActivityIndicator color={colors.primary} style={{ marginVertical: spacing.md }} />
        ) : breakdown ? (
          <>
            {/* Usage row */}
            <View style={styles.storageUsageRow}>
              <Text style={styles.storageUsedLabel}>
                {formatBytes(breakdown.used_bytes)}
                <Text style={styles.storageQuotaLabel}> / {formatBytes(breakdown.quota_bytes)}</Text>
              </Text>
            </View>

            {/* NVMe — only when the user owns fast storage */}
            {showNvme && (
              <>
                <View style={styles.separator} />
                <View style={styles.storageTypeRow}>
                  <View style={[styles.iconWrap, styles.iconWrapNvme]}>
                    <Zap size={16} color={colors.primary} strokeWidth={1.5} />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>Fast storage (NVMe)</Text>
                    <View style={styles.miniBarTrack}>
                      <View style={[styles.miniBarFill, styles.miniBarFillNvme, { width: `${nvmePct}%` as any }]} />
                    </View>
                  </View>
                  <Text style={styles.storageTypeBytes}>{formatBytes(breakdown.nvme_bytes)}</Text>
                </View>
              </>
            )}

            {/* HDD — only when the user owns standard storage */}
            {showHdd && (
              <>
                <View style={styles.separator} />
                <View style={styles.storageTypeRow}>
                  <View style={[styles.iconWrap, styles.iconWrapHdd]}>
                    <HardDrive size={16} color={colors.mediaAccent} strokeWidth={1.5} />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowLabel}>Standard storage (HDD)</Text>
                    <View style={styles.miniBarTrack}>
                      <View style={[styles.miniBarFill, styles.miniBarFillHdd, { width: `${hddPct}%` as any }]} />
                    </View>
                  </View>
                  <Text style={styles.storageTypeBytes}>{formatBytes(breakdown.hdd_bytes)}</Text>
                </View>
              </>
            )}
          </>
        ) : (
          <Text style={styles.errorText}>Could not load storage info.</Text>
        )}
      </View>

      {/* ── Servers (storage you own across servers) ── */}
      {myServers.length > 0 && (
        <View style={[styles.section, { marginTop: spacing.md }]}>
          <Text style={styles.sectionTitle}>Servers</Text>
          {myServers.length > 1 && (
            <Text style={styles.serversHint}>
              Uploads go to your primary server, falling back to the least-full one when it's full.
            </Text>
          )}
          {myServers.map((srv, i) => (
            <TouchableOpacity
              key={srv.server_id}
              style={[styles.serverRow, i > 0 && styles.serverRowBorder]}
              onPress={() => handleSelectPrimary(srv)}
              disabled={srv.is_primary || settingPrimary !== null}
              activeOpacity={0.7}
            >
              <View style={[styles.iconWrap, srv.drive_type === 'nvme' ? styles.iconWrapNvme : styles.iconWrapHdd]}>
                {srv.drive_type === 'nvme'
                  ? <Zap size={16} color={colors.primary} strokeWidth={1.5} />
                  : <HardDrive size={16} color={colors.mediaAccent} strokeWidth={1.5} />}
              </View>
              <View style={styles.rowText}>
                <View style={styles.serverNameRow}>
                  <Text style={styles.rowLabel}>{srv.name}</Text>
                  {srv.is_primary && (
                    <View style={styles.primaryBadge}><Text style={styles.primaryBadgeText}>PRIMARY</Text></View>
                  )}
                </View>
                <View style={styles.miniBarTrack}>
                  <View style={[
                    styles.miniBarFill,
                    srv.drive_type === 'nvme' ? styles.miniBarFillNvme : styles.miniBarFillHdd,
                    { width: `${Math.min(srv.drive_used_pct, 100)}%` as any },
                  ]} />
                </View>
                <Text style={styles.serverMeta}>
                  {formatBytes(srv.used_bytes)} stored · {srv.drive_used_pct}% full
                  {srv.is_primary && (primaryTesting ? '  ·  Testing connection…' : primaryPingMs != null ? `  ·  ${primaryPingMs} ms` : '')}
                </Text>
              </View>
              {settingPrimary === srv.server_id ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : srv.is_primary ? (
                <Check size={18} color={colors.primary} strokeWidth={2.5} />
              ) : (
                <View style={styles.radioOuter} />
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* ── Connection speed ── */}
      {breakdown?.server && (
        <View style={[styles.section, { marginTop: spacing.md }]}>
          <View style={styles.speedHeader}>
            <Text style={styles.sectionTitle}>Connection</Text>
            <TouchableOpacity
              onPress={runSpeed}
              disabled={speedLoading || speedRemaining <= 0}
              hitSlop={8}
              style={[
                styles.refreshBtn,
                (speedLoading || speedRemaining <= 0) && styles.refreshBtnDisabled,
              ]}
            >
              {speedLoading ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <RefreshCw
                  size={16}
                  color={speedRemaining > 0 ? colors.primary : colors.textMuted}
                  strokeWidth={2}
                />
              )}
            </TouchableOpacity>
          </View>

          {speedRemaining < SPEED_RATE_LIMIT && !speedLoading && (
            <Text style={styles.rateLimitNote}>
              {speedRemaining > 0
                ? `${speedRemaining} refresh${speedRemaining !== 1 ? 'es' : ''} remaining this minute`
                : 'Limit reached — try again in a minute'}
            </Text>
          )}

          {speedError && <Text style={styles.errorText}>{speedError}</Text>}

          <View style={styles.speedGrid}>
            <View style={styles.speedCell}>
              <Text style={styles.speedValue}>
                {speedLoading ? '—' : speed?.ping_ms != null ? `${speed.ping_ms}` : '—'}
              </Text>
              <Text style={styles.speedUnit}>{speed?.ping_ms != null ? 'ms' : ''}</Text>
              <Text style={styles.speedLabel}>Ping</Text>
            </View>
            <View style={styles.speedDivider} />
            <View style={styles.speedCell}>
              <Text style={styles.speedValue}>
                {speedLoading ? '—' : speed?.download_mbps != null
                  ? speed.download_mbps >= 1000
                    ? (speed.download_mbps / 1000).toFixed(1)
                    : speed.download_mbps.toFixed(1)
                  : '—'}
              </Text>
              <Text style={styles.speedUnit}>
                {speed?.download_mbps != null
                  ? speed.download_mbps >= 1000 ? 'Gbps' : 'Mbps'
                  : ''}
              </Text>
              <Text style={styles.speedLabel}>Download</Text>
            </View>
            <View style={styles.speedDivider} />
            <View style={styles.speedCell}>
              <Text style={styles.speedValue}>
                {speedLoading ? '—' : speed?.upload_mbps != null
                  ? speed.upload_mbps >= 1000
                    ? (speed.upload_mbps / 1000).toFixed(1)
                    : speed.upload_mbps.toFixed(1)
                  : '—'}
              </Text>
              <Text style={styles.speedUnit}>
                {speed?.upload_mbps != null
                  ? speed.upload_mbps >= 1000 ? 'Gbps' : 'Mbps'
                  : ''}
              </Text>
              <Text style={styles.speedLabel}>Upload</Text>
            </View>
          </View>
        </View>
      )}

      {/* Hour picker modal */}
      <Modal
        visible={hourPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setHourPickerVisible(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setHourPickerVisible(false)}>
          <Pressable style={styles.pickerSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.pickerTitle}>Sync Time</Text>
            <ScrollView style={styles.pickerList} showsVerticalScrollIndicator={false}>
              {HOURS.map((h) => (
                <TouchableOpacity
                  key={h}
                  style={[styles.pickerRow, nightSyncHour === h && styles.pickerRowActive]}
                  onPress={() => selectHour(h)}
                >
                  <Text style={[styles.pickerRowText, nightSyncHour === h && styles.pickerRowTextActive]}>
                    {formatHour(h)}
                  </Text>
                  {nightSyncHour === h && <View style={styles.pickerCheck} />}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

// Suppress unused-import warning — formatMbps kept for potential future use
void formatMbps;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },

  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    ...shadow.sm,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.md,
  },
  separator: {
    height: 1,
    backgroundColor: colors.divider,
    marginVertical: spacing.sm,
    marginLeft: 46,
  },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2 },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.divider,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  iconWrapActive: { backgroundColor: colors.primaryLighter },
  iconWrapNight: { backgroundColor: colors.mediaAccentLighter },
  iconWrapNvme: { backgroundColor: colors.primaryLighter },
  iconWrapHdd: { backgroundColor: colors.mediaAccentLighter },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  rowMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },

  hourChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.md,
    backgroundColor: colors.mediaAccentLighter,
  },
  hourChipText: { fontSize: 13, fontWeight: '600', color: colors.mediaAccent },

  // Storage breakdown
  storageUsageRow: { marginBottom: spacing.xs },
  storageUsedLabel: { fontSize: 22, fontWeight: '700', color: colors.textPrimary },
  storageQuotaLabel: { fontSize: 15, fontWeight: '400', color: colors.textSecondary },

  storageTypeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2 },
  storageTypeBytes: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginLeft: spacing.sm },

  miniBarTrack: {
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 5,
  },
  miniBarFill: { height: '100%', borderRadius: 2 },
  miniBarFillNvme: { backgroundColor: colors.primary },
  miniBarFillHdd: { backgroundColor: colors.mediaAccent },

  // Servers (multi-drive)
  serversHint: { fontSize: 12, color: colors.textMuted, marginTop: -spacing.xs, marginBottom: spacing.sm, lineHeight: 16 },
  serverRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm },
  serverRowBorder: { borderTopWidth: 1, borderTopColor: colors.divider },
  serverNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 5 },
  serverMeta: { fontSize: 11, color: colors.textMuted, marginTop: 5 },
  primaryBadge: { backgroundColor: colors.primaryLighter, paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.sm },
  primaryBadgeText: { fontSize: 9, fontWeight: '700', color: colors.primary, letterSpacing: 0.5 },
  radioOuter: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.border },

  errorText: { fontSize: 13, color: colors.error, paddingVertical: spacing.xs },

  // Speed card
  speedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  refreshBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.primaryLighter,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -(spacing.md), // align with section title area
  },
  refreshBtnDisabled: { backgroundColor: colors.divider },
  rateLimitNote: { fontSize: 11, color: colors.textMuted, marginBottom: spacing.sm },

  speedGrid: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  speedCell: { flex: 1, alignItems: 'center' },
  speedDivider: { width: 1, height: 48, backgroundColor: colors.divider },
  speedValue: { fontSize: 22, fontWeight: '700', color: colors.textPrimary },
  speedUnit: { fontSize: 11, color: colors.textSecondary, marginTop: 1 },
  speedLabel: { fontSize: 12, color: colors.textMuted, marginTop: 4 },

  // Hour picker modal
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    maxHeight: '60%',
  },
  pickerTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  pickerList: { paddingHorizontal: spacing.md },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  pickerRowActive: {},
  pickerRowText: { fontSize: 16, color: colors.textPrimary },
  pickerRowTextActive: { color: colors.mediaAccent, fontWeight: '600' },
  pickerCheck: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.mediaAccent,
  },
});
