import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share as NativeShare,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import appleAuth from '@invertase/react-native-apple-authentication';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import {
  Bell,
  Check,
  ChevronRight,
  FlaskConical,
  FolderInput,
  GalleryHorizontalEnd,
  HardDrive,
  Link as LinkIcon,
  LogOut,
  Pencil,
  PlusCircle,
  RefreshCw,
  Rocket,
  Shield,
  X,
  Zap,
} from 'lucide-react-native';
import { linkSocial, linkSocialGoogle, unlinkSocial } from '../api/auth';
import { getPreferences, listRoot, updatePreferences, type ApiFolder, type UserPreferences } from '../api/files';
import {
  listNotifications,
  updateExpansionOverride,
  updateSandboxPayments,
  updateStorageUIPreferences,
  updateUsername,
} from '../api/me';
import { formatCents, listMyExpansionRequests, type ExpansionRequest, type ExpansionStatus } from '../api/billing';
import { cancelPremiumSubscription } from '../api/payments';
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
import {
  createFileServerLink,
  deleteFileServerLink,
  listFileServerLinks,
  type FileServerLink,
} from '../api/fileServerLinks';
import StorageUpgradeModal from '../components/StorageUpgradeModal';
import PremiumUpgradeModal from '../components/PremiumUpgradeModal';
import { useAuth } from '../context/AuthContext';
import { card, colors, radius, spacing } from '../theme';

// Remembers the reroute folder while the policy is toggled off, so re-enabling restores it.
const REROUTE_LAST_KEY = 'apollo_media_reroute_last';

const GB = 1024 ** 3;

function formatSize(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function apiError(e: any): string {
  return e?.response?.data?.error ?? e?.message ?? 'Unknown error';
}

const EXPANSION_STATUS_META: Record<ExpansionStatus, { label: string; color: string; bg: string }> = {
  opened:       { label: 'Awaiting review',  color: colors.amberDeep, bg: colors.warningBg },
  invoice_sent: { label: 'Invoice sent',     color: colors.primary,   bg: colors.infoBg },
  accepted:     { label: 'Invoice accepted', color: colors.primary,   bg: colors.infoBg },
  approved:     { label: 'Approved',         color: colors.primary,   bg: colors.infoBg },
  expanded:     { label: 'Balance due',      color: colors.sandbox,   bg: colors.sandboxBg },
  completed:    { label: 'Completed',        color: colors.success,   bg: colors.successBg },
  expired:      { label: 'Expired',          color: colors.textMuted, bg: colors.divider },
  refunded:     { label: 'Refunded',         color: colors.textMuted, bg: colors.divider },
  rejected:     { label: 'Rejected',         color: colors.error,     bg: colors.errorBg },
};

function expansionCapacityLabel(r: ExpansionRequest): string {
  const tib = 1024 ** 4;
  if (r.bytes_requested >= 1024 * tib) return `${(r.bytes_requested / (1024 * tib)).toFixed(1).replace(/\.0$/, '')} PB`;
  if (r.bytes_requested >= tib) return `${(r.bytes_requested / tib).toFixed(1).replace(/\.0$/, '')} TB`;
  return `${Math.round(r.bytes_requested / GB)} GB`;
}

export default function ProfileScreen() {
  const navigation = useNavigation<any>();
  const { profile, signOut, refreshProfile } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [storageModalVisible, setStorageModalVisible] = useState(false);
  const [premiumModalVisible, setPremiumModalVisible] = useState(false);
  const [notificationCount, setNotificationCount] = useState(0);

  const load = useCallback(() => {
    listNotifications().then((n) => setNotificationCount(n.length)).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refreshProfile(), load()]);
    setRefreshing(false);
  };

  if (!profile) return null;

  const pct = profile.storage_quota_bytes > 0
    ? (profile.storage_used_bytes / profile.storage_quota_bytes) * 100
    : 0;
  const barColor = pct >= 90 ? colors.error : pct >= 50 ? colors.warning : '#22c55e';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.pageTitle}>Profile</Text>

      {/* ── Account card ── */}
      <View style={[card, { marginBottom: spacing.md }]}>
        <UsernameRow currentUsername={profile.username} onRenamed={signOut} />
        <View style={styles.divider} />
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Email</Text>
          <Text style={styles.infoValue}>{profile.email}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Account type</Text>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {profile.is_admin && <AccountBadge label="Admin" color="#4338ca" bg="#eef2ff" />}
            {(profile.premium_subscribed || (profile.is_premium && !profile.is_admin)) && (
              <AccountBadge label="Premium" color={colors.amberDeep} bg={colors.warningBg} />
            )}
            {!profile.is_admin && !profile.is_premium && (
              <AccountBadge label="User" color={colors.textSecondary} bg={colors.divider} />
            )}
          </View>
        </View>
        <View style={styles.divider} />
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Member since</Text>
          <Text style={styles.infoValue}>
            {profile.created_at
              ? new Date(profile.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
              : '—'}
          </Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.storageBlock}>
          <View style={styles.rowBetween}>
            <Text style={styles.infoLabel}>Storage</Text>
            <Text style={styles.infoValue}>
              {formatSize(profile.storage_used_bytes)}
              <Text style={{ color: colors.textMuted, fontWeight: '400' }}> / {formatSize(profile.storage_quota_bytes)}</Text>
            </Text>
          </View>
          <View style={styles.storageTrack}>
            <View style={[styles.storageFill, { width: `${Math.min(pct, 100)}%` as any, backgroundColor: barColor }]} />
          </View>
          <View style={styles.rowBetween}>
            <Text style={styles.mutedSmall}>{pct.toFixed(1)}% used</Text>
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <TouchableOpacity onPress={() => navigation.navigate('Orders')}>
                <Text style={styles.subtleLink}>My orders</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}
                onPress={() => setStorageModalVisible(true)}
              >
                <PlusCircle size={13} color={colors.primary} />
                <Text style={styles.primaryLink}>Add storage</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>

      <StorageUpgradeModal
        visible={storageModalVisible}
        quotaBytes={profile.storage_quota_bytes}
        usedBytes={profile.storage_used_bytes}
        expansionOverride={profile.expansion_override_enabled}
        onPurchased={() => {
          setStorageModalVisible(false);
          refreshProfile();
        }}
        onExpansionRequested={() => refreshProfile()}
        onClose={() => setStorageModalVisible(false)}
      />

      <ExpansionRequestsCard onViewAll={() => navigation.navigate('Orders', { tab: 'requests' })} />

      <StorageInfraCard />

      <LinkedAccountsCard />

      <PremiumCard onUpgrade={() => setPremiumModalVisible(true)} />
      <PremiumUpgradeModal
        visible={premiumModalVisible}
        onClose={() => setPremiumModalVisible(false)}
        onSubscribed={refreshProfile}
      />

      {(profile.is_premium || profile.is_admin) && <FileServerLinksCard />}

      <StorageUIPreferencesCard />

      <MediaAutoUploadCard />

      {profile.is_admin && <AdminOverridesCard />}

      {/* ── Navigation rows: notifications / shared / password ── */}
      <View style={[card, { marginBottom: spacing.md }]}>
        <TouchableOpacity style={styles.navRow} onPress={() => navigation.navigate('Notifications')}>
          <View style={[styles.navIcon, { backgroundColor: colors.infoBg }]}>
            <Bell size={16} color={colors.primary} />
          </View>
          <Text style={styles.navLabel}>Notifications</Text>
          {notificationCount > 0 && (
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText}>{notificationCount > 9 ? '9+' : notificationCount}</Text>
            </View>
          )}
          <ChevronRight size={16} color={colors.textMuted} />
        </TouchableOpacity>
        <View style={styles.divider} />
        <TouchableOpacity style={styles.navRow} onPress={() => navigation.navigate('Shared')}>
          <View style={[styles.navIcon, { backgroundColor: colors.infoBg }]}>
            <FolderInput size={16} color={colors.primary} />
          </View>
          <Text style={styles.navLabel}>Shared files</Text>
          <ChevronRight size={16} color={colors.textMuted} />
        </TouchableOpacity>
        <View style={styles.divider} />
        <TouchableOpacity style={styles.navRow} onPress={() => navigation.navigate('ChangePassword')}>
          <View style={[styles.navIcon, { backgroundColor: colors.infoBg }]}>
            <Shield size={16} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.navLabel}>Change password</Text>
            <Text style={styles.mutedSmall}>Requires a one-time code sent to your email.</Text>
          </View>
          <ChevronRight size={16} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Sign out */}
      <TouchableOpacity style={[card, styles.signOutButton]} onPress={signOut}>
        <LogOut size={18} color={colors.error} strokeWidth={2} />
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function AccountBadge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <View style={{ backgroundColor: bg, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
      <Text style={{ fontSize: 10, fontWeight: '700', color, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </Text>
    </View>
  );
}

// UsernameRow shows the current username with inline editing. Because a rename
// only takes effect on the next token refresh, a successful change signs the
// user out so they log back in with the new name — same as the web.
function UsernameRow({ currentUsername, onRenamed }: { currentUsername: string; onRenamed: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentUsername);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const trimmed = value.trim();
  const valid = trimmed.length >= 3 && trimmed.length <= 150 && trimmed !== currentUsername;

  const save = async () => {
    if (!valid || pending) return;
    setPending(true);
    try {
      await updateUsername(trimmed);
      Alert.alert('Username updated', 'Please sign in again with your new username.');
      onRenamed();
    } catch (e: any) {
      setError(apiError(e));
    } finally {
      setPending(false);
    }
  };

  if (!editing) {
    return (
      <View style={styles.infoRow}>
        <Text style={styles.infoLabel}>Username</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={styles.infoValue}>{currentUsername}</Text>
          <TouchableOpacity onPress={() => { setValue(currentUsername); setError(null); setEditing(true); }} hitSlop={8}>
            <Pencil size={14} color={colors.textMuted} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={{ paddingHorizontal: spacing.md, paddingVertical: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={[styles.infoLabel, { flexShrink: 0 }]}>Username</Text>
        <TextInput
          style={styles.usernameInput}
          value={value}
          onChangeText={(t) => { setValue(t); setError(null); }}
          autoCapitalize="none"
          autoFocus
          editable={!pending}
        />
        <TouchableOpacity onPress={save} disabled={!valid || pending} hitSlop={8}>
          <Check size={18} color={valid && !pending ? colors.success : colors.border} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setEditing(false); setValue(currentUsername); setError(null); }} hitSlop={8}>
          <X size={18} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
      <Text style={[styles.mutedSmall, { textAlign: 'right', marginTop: 4 }]}>
        Changing your username signs you out; log back in with the new name.
      </Text>
      {error && <Text style={[styles.errorSmall, { textAlign: 'right' }]}>{error}</Text>}
    </View>
  );
}

// ── Capacity expansion requests (compact card; full history in Orders) ───────

function ExpansionRequestsCard({ onViewAll }: { onViewAll: () => void }) {
  const [requests, setRequests] = useState<ExpansionRequest[]>([]);

  useEffect(() => {
    listMyExpansionRequests().then(setRequests).catch(() => {});
  }, []);

  if (requests.length === 0) return null;

  return (
    <View style={[card, styles.cardPad, { marginBottom: spacing.md }]}>
      <View style={styles.rowBetween}>
        <Text style={styles.cardTitle}>Capacity expansion requests</Text>
        <TouchableOpacity onPress={onViewAll}>
          <Text style={styles.primaryLink}>View all orders</Text>
        </TouchableOpacity>
      </View>
      <Text style={[styles.mutedSmall, { marginBottom: spacing.sm }]}>
        Requests are reviewed within 7 business days (3 for custom capacity) and expanded within
        14 business days of approval. Your deposit is refunded automatically if either deadline is missed.
      </Text>
      {requests.map((r, i) => {
        const meta = EXPANSION_STATUS_META[r.status] ?? { label: r.status, color: colors.textMuted, bg: colors.divider };
        const deadline =
          r.status === 'opened' ? { label: 'Review due', at: r.approval_due_at ?? r.expires_at }
          : r.status === 'invoice_sent' ? { label: 'Accept invoice by', at: r.invoice_accept_due_at ?? null }
          : r.status === 'accepted' ? { label: 'Approval due', at: r.approval_due_at }
          : r.status === 'approved' ? { label: 'Expansion due', at: r.expansion_due_at }
          : r.status === 'expanded' ? { label: 'Balance due since', at: r.payment_due_at }
          : null;
        return (
          <View key={r.id} style={[i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }, { paddingVertical: 8 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Text style={styles.rowTitle}>
                {expansionCapacityLabel(r)} {r.storage_type === 'nvme' ? 'Fast' : 'Standard'}
                {r.is_custom ? ' (custom)' : ''}
              </Text>
              <View style={{ backgroundColor: meta.bg, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                <Text style={{ fontSize: 9, fontWeight: '700', color: meta.color, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {meta.label}
                </Text>
              </View>
            </View>
            <Text style={styles.mutedSmall}>
              {r.server_name} · deposit {formatCents(r.deposit_amount_cents)} of {formatCents(r.full_price_cents)} ·
              requested {new Date(r.created_at).toLocaleDateString()}
              {deadline?.at ? ` · ${deadline.label} ${new Date(deadline.at).toLocaleDateString()}` : ''}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ── Storage infrastructure (breakdown + servers + connection test) ───────────

const SPEED_RATE_LIMIT = 5;

function StorageInfraCard() {
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(null);
  const [myServers, setMyServers] = useState<MyServer[]>([]);
  const [primaryPingMs, setPrimaryPingMs] = useState<number | null>(null);
  const [settingPrimary, setSettingPrimary] = useState<string | null>(null);

  const [speed, setSpeed] = useState<SpeedMetrics | null>(null);
  const [speedLoading, setSpeedLoading] = useState(false);
  const [speedError, setSpeedError] = useState<string | null>(null);
  const speedCallsRef = useRef<number[]>([]);
  const [speedRemaining, setSpeedRemaining] = useState(SPEED_RATE_LIMIT);

  const loadServers = useCallback(async () => {
    try {
      const servers = await listMyServers();
      setMyServers(servers);
      const primary = servers.find((s) => s.is_primary);
      if (primary) {
        pingServer(primary.ping_url).then(setPrimaryPingMs).catch(() => setPrimaryPingMs(null));
      }
    } catch {
      // non-fatal
    }
  }, []);

  const runSpeed = useCallback(async (bd: StorageBreakdown | null) => {
    if (speedLoading) return;
    const now = Date.now();
    speedCallsRef.current = speedCallsRef.current.filter((t) => now - t < 60_000);
    const remaining = SPEED_RATE_LIMIT - speedCallsRef.current.length;
    setSpeedRemaining(remaining);
    if (remaining <= 0) {
      setSpeedError('Limit reached. Try again in a minute.');
      return;
    }
    setSpeedLoading(true);
    setSpeedError(null);
    speedCallsRef.current.push(Date.now());
    setSpeedRemaining(SPEED_RATE_LIMIT - speedCallsRef.current.length);
    try {
      setSpeed(await runSpeedTest(bd?.server?.ping_url ?? '/api/v1/storage/servers'));
    } catch (e: any) {
      setSpeedError(e?.code === 'RATE_LIMITED'
        ? 'Limit reached. Try again in a minute.'
        : 'Speed test failed. Check your connection.');
    } finally {
      setSpeedLoading(false);
    }
  }, [speedLoading]);

  useEffect(() => {
    (async () => {
      let bd: StorageBreakdown | null = null;
      try {
        bd = await getStorageBreakdown();
        setBreakdown(bd);
      } catch {
        // best-effort
      }
      loadServers();
      if (bd) runSpeed(bd);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectPrimary = async (srv: MyServer) => {
    if (srv.is_primary || settingPrimary) return;
    setSettingPrimary(srv.server_id);
    try {
      await setPrimaryServer(srv.server_id);
      await loadServers();
    } catch {
      // keep previous selection on failure
    } finally {
      setSettingPrimary(null);
    }
  };

  const allocatedBytes = breakdown?.quota_bytes ?? 0;
  const ownedTypes = new Set(myServers.map((s) => s.drive_type));
  const showNvme = ownedTypes.size === 0 || ownedTypes.has('nvme');
  const showHdd = ownedTypes.size === 0 || ownedTypes.has('hdd');
  const nvmePct = breakdown && breakdown.quota_bytes > 0
    ? Math.min((breakdown.nvme_bytes / breakdown.quota_bytes) * 100, 100) : 0;
  const hddPct = breakdown && breakdown.quota_bytes > 0
    ? Math.min((breakdown.hdd_bytes / breakdown.quota_bytes) * 100, 100) : 0;

  return (
    <>
      <View style={[card, { marginBottom: spacing.md }]}>
        <View style={styles.cardPad}>
          <Text style={styles.cardTitle}>Your Storage Infrastructure</Text>
          {breakdown ? (
            <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
              {showNvme && (
                <TierRow
                  Icon={Zap}
                  iconColor={colors.primary}
                  iconBg={colors.infoBg}
                  label="Fast storage (NVMe)"
                  value={formatSize(breakdown.nvme_bytes)}
                  pct={nvmePct}
                  barColor={colors.info}
                />
              )}
              {showHdd && (
                <TierRow
                  Icon={HardDrive}
                  iconColor={colors.warning}
                  iconBg={colors.warningBg}
                  label="Standard storage (HDD)"
                  value={formatSize(breakdown.hdd_bytes)}
                  pct={hddPct}
                  barColor={colors.warning}
                />
              )}
            </View>
          ) : (
            <Text style={styles.mutedSmall}>Could not load storage info.</Text>
          )}
        </View>

        {myServers.length > 0 && (
          <>
            <View style={styles.divider} />
            <View style={styles.cardPad}>
              <Text style={styles.cardTitle}>Servers</Text>
              {myServers.length > 1 && (
                <Text style={[styles.mutedSmall, { marginBottom: spacing.sm }]}>
                  Uploads go to your primary server, falling back to the least-full one when it's full.
                </Text>
              )}
              {myServers.map((srv, i) => (
                <TouchableOpacity
                  key={srv.server_id}
                  style={[styles.serverRow, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}
                  onPress={() => handleSelectPrimary(srv)}
                  disabled={srv.is_primary || settingPrimary !== null}
                  activeOpacity={0.7}
                >
                  <View style={[styles.navIcon, { backgroundColor: srv.drive_type === 'nvme' ? colors.infoBg : colors.warningBg }]}>
                    {srv.drive_type === 'nvme'
                      ? <Zap size={14} color={colors.primary} />
                      : <HardDrive size={14} color={colors.warning} />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                      <Text style={styles.rowTitle}>{srv.name}</Text>
                      <AccountBadge
                        label={srv.drive_type === 'nvme' ? 'Fast' : 'Standard'}
                        color={srv.drive_type === 'nvme' ? colors.primary : colors.amberDeep}
                        bg={srv.drive_type === 'nvme' ? colors.infoBg : colors.warningBg}
                      />
                      {srv.is_primary && <AccountBadge label="Primary" color={colors.primary} bg={colors.infoBg} />}
                    </View>
                    <View style={styles.thinTrack}>
                      <View
                        style={[
                          styles.thinFill,
                          {
                            width: `${allocatedBytes > 0 ? Math.min((srv.used_bytes / allocatedBytes) * 100, 100) : 0}%` as any,
                            backgroundColor: srv.drive_type === 'nvme' ? colors.info : colors.warning,
                          },
                        ]}
                      />
                    </View>
                    <Text style={styles.mutedSmall}>
                      {formatSize(srv.used_bytes)} used of {formatSize(allocatedBytes)}
                      {srv.is_primary && primaryPingMs != null ? ` · ${primaryPingMs} ms` : ''}
                    </Text>
                  </View>
                  {settingPrimary === srv.server_id ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : srv.is_primary ? (
                    <Check size={18} color={colors.primary} />
                  ) : (
                    <View style={styles.radioOuter} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}
      </View>

      {/* Connection card */}
      {breakdown?.server && (
        <View style={[card, styles.cardPad, { marginBottom: spacing.md }]}>
          <View style={styles.rowBetween}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Connection</Text>
              <Text style={styles.mutedSmall}>
                Testing to <Text style={{ fontWeight: '500', color: colors.textSecondary }}>{breakdown.server.name}</Text>
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.refreshBtn, (speedLoading || speedRemaining <= 0) && { opacity: 0.4 }]}
              onPress={() => runSpeed(breakdown)}
              disabled={speedLoading || speedRemaining <= 0}
            >
              {speedLoading
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <RefreshCw size={15} color={colors.primary} />}
            </TouchableOpacity>
          </View>

          {speedRemaining < SPEED_RATE_LIMIT && !speedLoading && (
            <Text style={styles.mutedSmall}>
              {speedRemaining > 0
                ? `${speedRemaining} refresh${speedRemaining !== 1 ? 'es' : ''} remaining this minute`
                : 'Limit reached — try again in a minute'}
            </Text>
          )}
          {speedError && <Text style={styles.errorSmall}>{speedError}</Text>}

          <View style={styles.speedGrid}>
            <SpeedStat label="Ping" value={speedLoading ? '—' : speed?.ping_ms != null ? String(speed.ping_ms) : '—'} unit={!speedLoading && speed?.ping_ms != null ? 'ms' : ''} />
            <SpeedStat
              label="Download"
              value={speedLoading ? '—' : speed?.download_mbps != null
                ? (speed.download_mbps >= 1000 ? (speed.download_mbps / 1000).toFixed(1) : speed.download_mbps.toFixed(1))
                : '—'}
              unit={!speedLoading && speed?.download_mbps != null ? (speed.download_mbps >= 1000 ? 'Gbps' : 'Mbps') : ''}
            />
            <SpeedStat
              label="Upload"
              value={speedLoading ? '—' : speed?.upload_mbps != null
                ? (speed.upload_mbps >= 1000 ? (speed.upload_mbps / 1000).toFixed(1) : speed.upload_mbps.toFixed(1))
                : '—'}
              unit={!speedLoading && speed?.upload_mbps != null ? (speed.upload_mbps >= 1000 ? 'Gbps' : 'Mbps') : ''}
            />
          </View>
        </View>
      )}
    </>
  );
}

function TierRow({ Icon, iconColor, iconBg, label, value, pct, barColor }: {
  Icon: React.ComponentType<{ size: number; color: string }>;
  iconColor: string;
  iconBg: string;
  label: string;
  value: string;
  pct: number;
  barColor: string;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <View style={[styles.navIcon, { backgroundColor: iconBg }]}>
        <Icon size={14} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={[styles.rowBetween, { marginBottom: 5 }]}>
          <Text style={styles.mutedSmall}>{label}</Text>
          <Text style={[styles.rowTitle, { fontSize: 12 }]}>{value}</Text>
        </View>
        <View style={styles.thinTrack}>
          <View style={[styles.thinFill, { width: `${pct}%` as any, backgroundColor: barColor }]} />
        </View>
      </View>
    </View>
  );
}

function SpeedStat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <View style={styles.speedStat}>
      <Text style={styles.speedValue}>{value}</Text>
      <Text style={[styles.mutedSmall, { height: 14 }]}>{unit}</Text>
      <Text style={styles.mutedSmall}>{label}</Text>
    </View>
  );
}

// ── Linked accounts ───────────────────────────────────────────────────────────

function LinkedAccountsCard() {
  const { profile, refreshProfile } = useAuth();
  const [linking, setLinking] = useState(false);

  const handleLinkApple = async () => {
    if (Platform.OS !== 'ios') return;
    setLinking(true);
    try {
      const credential = await appleAuth.performRequest({
        requestedOperation: appleAuth.Operation.LOGIN,
        requestedScopes: [appleAuth.Scope.EMAIL],
      });
      if (!credential.identityToken) throw new Error('No token');
      await linkSocial('apple', credential.identityToken);
      await refreshProfile();
      Alert.alert('Apple linked');
    } catch (e: any) {
      if (e.code !== appleAuth.Error.CANCELED) Alert.alert('Failed to link Apple', e.message);
    } finally {
      setLinking(false);
    }
  };

  const handleUnlinkApple = async () => {
    try { await unlinkSocial('apple'); await refreshProfile(); Alert.alert('Apple unlinked'); }
    catch (e: any) { Alert.alert('Failed', e.message); }
  };

  const handleLinkGoogle = async () => {
    try {
      await GoogleSignin.hasPlayServices();
      const response = await GoogleSignin.signIn();
      const data = (response as any).data ?? response;
      const serverAuthCode: string | null = data?.serverAuthCode ?? null;
      if (!serverAuthCode) throw new Error('No server auth code from Google sign-in');
      await linkSocialGoogle(serverAuthCode);
      await refreshProfile();
      Alert.alert('Google account linked');
    } catch (e: any) {
      if (e.code !== statusCodes.SIGN_IN_CANCELLED) Alert.alert('Failed to link Google', e.message);
    }
  };

  const handleUnlinkGoogle = async () => {
    try { await unlinkSocial('google'); await refreshProfile(); Alert.alert('Google account unlinked'); }
    catch (e: any) { Alert.alert('Failed', e.message); }
  };

  return (
    <View style={[card, styles.cardPad, { marginBottom: spacing.md }]}>
      <Text style={styles.cardTitle}>Linked accounts</Text>
      {Platform.OS === 'ios' && (
        <View style={styles.infoRowFlush}>
          <Text style={styles.navLabel}>Apple</Text>
          {profile?.linked_providers?.includes('apple') ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Check size={13} color={colors.success} />
                <Text style={[styles.mutedSmall, { color: colors.success, fontWeight: '500' }]}>Connected</Text>
              </View>
              <TouchableOpacity onPress={handleUnlinkApple}>
                <Text style={[styles.mutedSmall, { color: colors.error }]}>Remove</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={handleLinkApple} disabled={linking}>
              <Text style={styles.primaryLink}>Link</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      <View style={styles.divider} />
      <View style={styles.infoRowFlush}>
        <Text style={styles.navLabel}>Google</Text>
        {profile?.linked_providers?.includes('google') ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <Check size={13} color={colors.success} />
              <Text style={[styles.mutedSmall, { color: colors.success, fontWeight: '500' }]}>Connected</Text>
            </View>
            <TouchableOpacity onPress={handleUnlinkGoogle}>
              <Text style={[styles.mutedSmall, { color: colors.error }]}>Remove</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity onPress={handleLinkGoogle}>
            <Text style={styles.primaryLink}>Link</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ── Premium (status / renewal / cancel, or upgrade prompt) ────────────────────

function PremiumCard({ onUpgrade }: { onUpgrade: () => void }) {
  const { profile, refreshProfile } = useAuth();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  if (!profile) return null;

  // Admins are implicitly premium — only a real subscription (or a non-admin's
  // own grant) counts as genuine here; with sandbox payments on, admins see
  // the real upgrade flow so it can be tested end-to-end.
  const genuinelyPremium = profile.is_admin ? profile.premium_subscribed : profile.is_premium;

  const handleCancel = async () => {
    setCancelPending(true);
    setCancelError(null);
    try {
      await cancelPremiumSubscription();
      setConfirmingCancel(false);
      await refreshProfile();
    } catch (e: any) {
      setCancelError(apiError(e));
    } finally {
      setCancelPending(false);
    }
  };

  if (genuinelyPremium || (profile.is_admin && !profile.sandbox_payments_enabled)) {
    const periodEnd = profile.premium_current_period_end ? new Date(profile.premium_current_period_end) : null;
    const daysLeft = periodEnd ? Math.max(0, Math.ceil((periodEnd.getTime() - Date.now()) / 86_400_000)) : null;
    return (
      <View style={[card, styles.cardPad, { marginBottom: spacing.md }]}>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Check size={20} color={colors.success} style={{ marginTop: 1 }} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={styles.cardTitle}>Premium</Text>
              {profile.premium_subscribed && profile.premium_environment === 'sandbox' && (
                <AccountBadge label="Sandbox" color={colors.sandbox} bg={colors.sandboxBg} />
              )}
            </View>
            {profile.premium_subscribed ? (
              <>
                {periodEnd && (
                  <Text style={styles.mutedSmall}>
                    Renews {periodEnd.toLocaleDateString()}
                    {daysLeft !== null ? ` (${daysLeft} day${daysLeft === 1 ? '' : 's'})` : ''}
                  </Text>
                )}
              </>
            ) : (
              <Text style={styles.mutedSmall}>
                {profile.is_admin
                  ? 'Included with your admin account.'
                  : profile.premium_granted_at
                    ? `Since ${new Date(profile.premium_granted_at).toLocaleDateString()}.`
                    : 'Active.'}
              </Text>
            )}
          </View>
        </View>

        {profile.premium_subscribed && (
          <View style={{ borderTopWidth: 1, borderTopColor: colors.divider, marginTop: spacing.sm, paddingTop: spacing.sm }}>
            {!confirmingCancel ? (
              <TouchableOpacity onPress={() => { setCancelError(null); setConfirmingCancel(true); }}>
                <Text style={[styles.mutedSmall, { color: colors.error }]}>Cancel Premium Membership</Text>
              </TouchableOpacity>
            ) : (
              <>
                <Text style={[styles.mutedSmall, { color: colors.textSecondary, marginBottom: spacing.sm }]}>
                  This immediately revokes access — your SFS API keys and file-server links stop
                  working right away. You'd need to subscribe again to restore access.
                </Text>
                {cancelError && <Text style={styles.errorSmall}>{cancelError}</Text>}
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <TouchableOpacity style={styles.dangerBtn} onPress={handleCancel} disabled={cancelPending}>
                    <Text style={styles.dangerBtnText}>{cancelPending ? 'Cancelling…' : 'Yes, cancel membership'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.neutralBtn} onPress={() => setConfirmingCancel(false)} disabled={cancelPending}>
                    <Text style={styles.neutralBtnText}>Never mind</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={[styles.premiumUpsell, { marginBottom: spacing.md }]}>
      <Rocket size={22} color={colors.warning} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <Text style={styles.cardTitle}>Upgrade to Premium</Text>
        <Text style={styles.mutedSmall}>SFS S3 API, per-directory keys, and file-server mounts.</Text>
      </View>
      <TouchableOpacity style={styles.upgradeBtn} onPress={onUpgrade}>
        <Text style={styles.upgradeBtnText}>Upgrade</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── File server links (premium WebDAV mounts) ─────────────────────────────────

function FileServerLinksCard() {
  const [links, setLinks] = useState<FileServerLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);

  const load = useCallback(() => {
    listFileServerLinks()
      .then(setLinks)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string) => {
    setDeleting(true);
    try {
      await deleteFileServerLink(id);
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
      load();
    }
  };

  const shareLink = async (link: FileServerLink) => {
    try {
      await NativeShare.share({ message: link.mount_url });
    } catch {
      // dismissed
    }
  };

  return (
    <View style={[card, styles.cardPad, { marginBottom: spacing.md }]}>
      <View style={styles.rowBetween}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <LinkIcon size={14} color={colors.primary} />
          <Text style={styles.cardTitle}>File server links</Text>
        </View>
        <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }} onPress={() => setCreateVisible(true)}>
          <PlusCircle size={13} color={colors.primary} />
          <Text style={styles.primaryLink}>New link</Text>
        </TouchableOpacity>
      </View>
      <Text style={[styles.mutedSmall, { marginBottom: spacing.sm }]}>
        Mount a storage drive as a network drive and manage your files from it — one link per
        server/tier combination you own capacity on.
      </Text>

      {loading && <Text style={styles.mutedSmall}>Loading…</Text>}
      {!loading && links.length === 0 && <Text style={styles.mutedSmall}>No links yet.</Text>}

      {links.map((link) => (
        <View key={link.id} style={styles.fslRow}>
          <View style={styles.rowBetween}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>{link.server_name}</Text>
              <AccountBadge
                label={link.drive_type === 'nvme' ? 'Fast' : 'Standard'}
                color={link.drive_type === 'nvme' ? '#047857' : '#0369a1'}
                bg={link.drive_type === 'nvme' ? '#ecfdf5' : '#f0f9ff'}
              />
              {link.enhanced_security && <AccountBadge label="enhanced security" color="#15803d" bg={colors.successBg} />}
            </View>
            {confirmDelete === link.id ? (
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <TouchableOpacity onPress={() => handleDelete(link.id)} disabled={deleting}>
                  <Text style={[styles.mutedSmall, { color: colors.error, fontWeight: '600' }]}>
                    {deleting ? 'Deleting…' : 'Confirm delete'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setConfirmDelete(null)}>
                  <Text style={styles.mutedSmall}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={() => setConfirmDelete(link.id)}>
                <Text style={styles.mutedSmall}>Delete</Text>
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity onPress={() => shareLink(link)}>
            <Text style={styles.mountUrl} numberOfLines={1}>{link.mount_url}</Text>
          </TouchableOpacity>
          <Text style={styles.mutedSmall}>
            Created {new Date(link.created_at).toLocaleDateString()}
            {link.last_used_at ? ` · last used ${new Date(link.last_used_at).toLocaleString()}` : ' · never used'}
          </Text>
        </View>
      ))}

      {createVisible && (
        <FileServerLinkCreateModal
          existingLinks={links}
          onClose={() => setCreateVisible(false)}
          onCreated={() => {
            setCreateVisible(false);
            load();
          }}
        />
      )}
    </View>
  );
}

function FileServerLinkCreateModal({ existingLinks, onClose, onCreated }: {
  existingLinks: FileServerLink[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [servers, setServers] = useState<MyServer[]>([]);
  const [selectedDriveId, setSelectedDriveId] = useState<string | null>(null);
  const [enhanced, setEnhanced] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ link: FileServerLink; created: boolean } | null>(null);

  useEffect(() => {
    listMyServers().then((list) => {
      setServers(list);
      const available = list.find((s) => !existingLinks.some((l) => l.drive_id === s.drive_id));
      setSelectedDriveId(available?.drive_id ?? list[0]?.drive_id ?? null);
    }).catch(() => {});
  }, [existingLinks]);

  const handleCreate = async () => {
    if (!selectedDriveId) return;
    setPending(true);
    try {
      setResult(await createFileServerLink(selectedDriveId, enhanced));
    } catch (e: any) {
      Alert.alert('Could not create link', apiError(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          {result ? (
            <>
              <Text style={styles.sheetTitle}>
                {result.created ? 'Link created' : 'Link already exists'}
              </Text>
              <Text style={[styles.mutedSmall, { marginBottom: spacing.sm }]}>
                Mount this address as a network drive. Connecting always requires your Apollo SFS
                login credentials.
              </Text>
              <Text style={[styles.mountUrl, { marginBottom: spacing.md }]} selectable>
                {result.link.mount_url}
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={onCreated}>
                <Text style={styles.primaryBtnText}>Done</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.sheetTitle}>New file server link</Text>
              <Text style={[styles.mutedSmall, { marginBottom: spacing.sm }]}>Choose the server/tier to mount.</Text>
              {servers.map((s) => {
                const taken = existingLinks.some((l) => l.drive_id === s.drive_id);
                const sel = selectedDriveId === s.drive_id;
                return (
                  <TouchableOpacity
                    key={s.drive_id}
                    style={[styles.driveOption, sel && { borderColor: colors.primary, backgroundColor: colors.primaryLighter }]}
                    onPress={() => setSelectedDriveId(s.drive_id)}
                    disabled={pending}
                  >
                    {s.drive_type === 'nvme'
                      ? <Zap size={14} color={sel ? colors.primary : colors.textSecondary} />
                      : <HardDrive size={14} color={sel ? colors.primary : colors.textSecondary} />}
                    <Text style={[styles.rowTitle, { flex: 1 }, sel && { color: colors.primaryHover }]}>
                      {s.name} ({s.drive_type === 'nvme' ? 'Fast' : 'Standard'})
                    </Text>
                    {taken && <Text style={styles.mutedSmall}>link exists</Text>}
                  </TouchableOpacity>
                );
              })}
              {servers.length === 0 && <Text style={styles.mutedSmall}>No servers with capacity found.</Text>}

              <View style={[styles.rowBetween, { marginTop: spacing.sm }]}>
                <View style={{ flex: 1, marginRight: spacing.sm }}>
                  <Text style={styles.navLabel}>Enhanced security</Text>
                  <Text style={styles.mutedSmall}>Restrict the mount to verified locations.</Text>
                </View>
                <Switch value={enhanced} onValueChange={setEnhanced} disabled={pending} trackColor={{ false: colors.border, true: colors.primary }} />
              </View>

              <TouchableOpacity
                style={[styles.primaryBtn, (!selectedDriveId || pending) && { opacity: 0.5 }, { marginTop: spacing.md }]}
                onPress={handleCreate}
                disabled={!selectedDriveId || pending}
              >
                <Text style={styles.primaryBtnText}>{pending ? 'Creating…' : 'Create link'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={{ alignItems: 'center', paddingVertical: 10 }} onPress={onClose} disabled={pending}>
                <Text style={styles.neutralBtnText}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Storage UI preferences ────────────────────────────────────────────────────

function StorageUIPreferencesCard() {
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getPreferences().then(setPrefs).catch(() => {});
  }, []);

  const update = async (patch: { show_storage_buttons?: boolean; storage_prompt_enabled?: boolean }) => {
    setSaving(true);
    try {
      await updateStorageUIPreferences(patch);
      setPrefs((p) => (p ? { ...p, ...patch } : p));
    } catch (e: any) {
      Alert.alert('Failed to save preference', apiError(e));
    } finally {
      setSaving(false);
    }
  };

  const showButtons = prefs?.show_storage_buttons ?? true;
  const promptEnabled = prefs?.storage_prompt_enabled ?? true;

  return (
    <View style={[card, styles.cardPad, { marginBottom: spacing.md }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <PlusCircle size={14} color={colors.textSecondary} />
        <Text style={styles.cardTitle}>Storage upgrades</Text>
      </View>
      <Text style={[styles.mutedSmall, { marginBottom: spacing.sm }]}>
        Control where the add-storage shortcuts appear. You can always add storage from this page.
      </Text>
      <View style={styles.rowBetween}>
        <Text style={[styles.navLabel, { flex: 1, marginRight: spacing.sm }]}>
          Show "+" add-storage buttons on the home page and upload dialog
        </Text>
        <Switch
          value={showButtons}
          disabled={saving}
          onValueChange={(v) => update({ show_storage_buttons: v })}
          trackColor={{ false: colors.border, true: colors.primary }}
        />
      </View>
      <View style={[styles.rowBetween, { marginTop: spacing.sm }]}>
        <Text style={[styles.navLabel, { flex: 1, marginRight: spacing.sm }]}>
          Offer more storage when an upload passes 75% of my quota or exceeds it
        </Text>
        <Switch
          value={promptEnabled}
          disabled={saving}
          onValueChange={(v) => update({ storage_prompt_enabled: v })}
          trackColor={{ false: colors.border, true: colors.primary }}
        />
      </View>
    </View>
  );
}

// ── Media auto-upload (unchanged behavior from the previous profile screen) ──

function MediaAutoUploadCard() {
  const [autouploadFolderID, setAutouploadFolderID] = useState<string | null>(null);
  const [mediaFolders, setMediaFolders] = useState<ApiFolder[]>([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [prefs, root] = await Promise.all([getPreferences(), listRoot()]);
        setAutouploadFolderID(prefs.media_autoupload_folder_id);
        setMediaFolders((root.subfolders?.items ?? []).filter((f) => f.kind === 'media'));
      } catch {
        // best-effort
      }
    })();
  }, []);

  const selectFolder = async (folderID: string | null) => {
    setSaving(true);
    try {
      await updatePreferences({ media_autoupload_folder_id: folderID });
      setAutouploadFolderID(folderID);
      setPickerVisible(false);
    } catch (e: any) {
      Alert.alert('Failed to update', e.message);
    } finally {
      setSaving(false);
    }
  };

  const rerouteEnabled = autouploadFolderID != null;

  const toggleReroute = async (enabled: boolean) => {
    setSaving(true);
    try {
      if (!enabled) {
        if (autouploadFolderID) await AsyncStorage.setItem(REROUTE_LAST_KEY, autouploadFolderID);
        await updatePreferences({ media_autoupload_folder_id: null });
        setAutouploadFolderID(null);
      } else {
        const last = await AsyncStorage.getItem(REROUTE_LAST_KEY);
        const target = last && mediaFolders.some((f) => f.id === last) ? last : mediaFolders[0]?.id ?? null;
        if (target == null) {
          Alert.alert('No media collections', 'Create a media collection in Files first, then enable reroute.');
          return;
        }
        await updatePreferences({ media_autoupload_folder_id: target });
        setAutouploadFolderID(target);
      }
    } catch (e: any) {
      Alert.alert('Failed to update', e.message);
    } finally {
      setSaving(false);
    }
  };

  const folderLabel = autouploadFolderID == null
    ? '/ (root)'
    : (mediaFolders.find((f) => f.id === autouploadFolderID)?.name ?? '/ (root)');

  return (
    <View style={[card, styles.cardPad, { marginBottom: spacing.md }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <GalleryHorizontalEnd size={14} color={colors.textSecondary} />
        <Text style={styles.cardTitle}>Media auto-upload</Text>
      </View>
      <Text style={[styles.mutedSmall, { marginBottom: spacing.sm }]}>
        Automatically send every photo and video you upload to a chosen media collection.
      </Text>
      <View style={styles.rowBetween}>
        <Text style={[styles.navLabel, { flex: 1, marginRight: spacing.sm }]}>Auto-upload reroute</Text>
        <Switch
          value={rerouteEnabled}
          onValueChange={toggleReroute}
          disabled={saving}
          trackColor={{ false: colors.border, true: colors.primary }}
        />
      </View>
      {rerouteEnabled && (
        <TouchableOpacity
          style={[styles.rowBetween, { marginTop: spacing.sm }]}
          onPress={() => setPickerVisible(true)}
          disabled={saving}
        >
          <Text style={styles.mutedSmall}>Destination collection</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <Text style={[styles.primaryLink, { fontSize: 13 }]} numberOfLines={1}>{folderLabel}</Text>
            <ChevronRight size={14} color={colors.primary} />
          </View>
        </TouchableOpacity>
      )}

      <Modal visible={pickerVisible} transparent animationType="fade" onRequestClose={() => setPickerVisible(false)}>
        <Pressable style={styles.overlay} onPress={() => !saving && setPickerVisible(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Auto-upload destination</Text>
            <TouchableOpacity style={styles.driveOption} onPress={() => selectFolder(null)} disabled={saving}>
              <GalleryHorizontalEnd size={16} color={colors.textSecondary} />
              <Text style={[styles.rowTitle, { flex: 1 }]}>/  (root)</Text>
              {autouploadFolderID == null && <Check size={16} color={colors.primary} />}
            </TouchableOpacity>
            {mediaFolders.map((folder) => (
              <TouchableOpacity key={folder.id} style={styles.driveOption} onPress={() => selectFolder(folder.id)} disabled={saving}>
                <GalleryHorizontalEnd size={16} color={colors.mediaAccent} />
                <Text style={[styles.rowTitle, { flex: 1 }]} numberOfLines={1}>{folder.name}</Text>
                {autouploadFolderID === folder.id && <Check size={16} color={colors.primary} />}
              </TouchableOpacity>
            ))}
            {mediaFolders.length === 0 && (
              <Text style={[styles.mutedSmall, { textAlign: 'center', paddingVertical: spacing.md }]}>
                No media collections yet. Create one in Files to organize your uploads.
              </Text>
            )}
            {saving && <ActivityIndicator style={{ marginTop: spacing.sm }} color={colors.primary} />}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ── Admin overrides: sandbox payments + storage expansion override ────────────
// Session-scoped toggles, same functionality as the web profile page.

function AdminOverridesCard() {
  const { profile, refreshProfile } = useAuth();
  const [sandboxPending, setSandboxPending] = useState(false);
  const [expansionPending, setExpansionPending] = useState(false);

  if (!profile?.is_admin) return null;

  const toggleSandbox = async (enabled: boolean) => {
    setSandboxPending(true);
    try {
      await updateSandboxPayments(enabled);
      await refreshProfile();
    } catch (e: any) {
      Alert.alert('Failed to save preference', apiError(e));
    } finally {
      setSandboxPending(false);
    }
  };

  const toggleExpansion = async (enabled: boolean) => {
    setExpansionPending(true);
    try {
      await updateExpansionOverride(enabled);
      await refreshProfile();
    } catch (e: any) {
      Alert.alert('Failed to save preference', apiError(e));
    } finally {
      setExpansionPending(false);
    }
  };

  return (
    <View style={[card, styles.cardPad, { marginBottom: spacing.md }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <FlaskConical size={14} color={colors.textSecondary} />
        <Text style={styles.cardTitle}>Sandbox payments</Text>
      </View>
      <Text style={[styles.mutedSmall, { marginBottom: spacing.sm }]}>
        Route your own premium, storage, and expansion purchases through the PayPal sandbox
        instead of live PayPal, so you can test checkout flows safely. Resets to off when you
        log out or your session expires.
      </Text>
      <View style={styles.rowBetween}>
        <Text style={[styles.navLabel, { flex: 1, marginRight: spacing.sm }]}>
          Use PayPal sandbox for my purchases this session
        </Text>
        <Switch
          value={profile.sandbox_payments_enabled}
          disabled={sandboxPending}
          onValueChange={toggleSandbox}
          trackColor={{ false: colors.border, true: colors.primary }}
        />
      </View>

      <View style={{ borderTopWidth: 1, borderTopColor: colors.divider, marginTop: spacing.md, paddingTop: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <HardDrive size={14} color={colors.textSecondary} />
          <Text style={styles.cardTitle}>Storage expansion override</Text>
        </View>
        <Text style={[styles.mutedSmall, { marginBottom: spacing.sm }]}>
          Force the Add storage modal to always show a capacity expansion request instead of a
          direct purchase, so you can test the request/deposit flow without needing a server
          near capacity. Resets to off when you log out or your session expires.
        </Text>
        <View style={styles.rowBetween}>
          <Text style={[styles.navLabel, { flex: 1, marginRight: spacing.sm }]}>
            Always show server expansion requests in Add storage
          </Text>
          <Switch
            value={profile.expansion_override_enabled}
            disabled={expansionPending}
            onValueChange={toggleExpansion}
            trackColor={{ false: colors.border, true: colors.primary }}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  pageTitle: { fontSize: 18, fontWeight: '600', color: colors.textPrimary, marginBottom: spacing.md },

  cardPad: { padding: spacing.md },
  cardTitle: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },

  infoRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: spacing.md, paddingVertical: 12,
  },
  infoRowFlush: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  infoLabel: { fontSize: 14, color: colors.textSecondary },
  infoValue: { fontSize: 14, fontWeight: '500', color: colors.textPrimary, flexShrink: 1, textAlign: 'right' },
  divider: { height: 1, backgroundColor: colors.divider, marginHorizontal: spacing.md },

  storageBlock: { paddingHorizontal: spacing.md, paddingVertical: 12, gap: 8 },
  storageTrack: { height: 8, backgroundColor: colors.divider, borderRadius: 4, overflow: 'hidden' },
  storageFill: { height: '100%', borderRadius: 4 },

  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTitle: { fontSize: 13, fontWeight: '500', color: colors.textPrimary },
  mutedSmall: { fontSize: 11, color: colors.textMuted, lineHeight: 16 },
  errorSmall: { fontSize: 11, color: colors.error, marginTop: 2 },
  subtleLink: { fontSize: 12, fontWeight: '500', color: colors.textSecondary },
  primaryLink: { fontSize: 12, fontWeight: '500', color: colors.primary },

  usernameInput: {
    flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 10, paddingVertical: 6, fontSize: 14, color: colors.textPrimary,
    textAlign: 'right',
  },

  serverRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 10 },
  thinTrack: { height: 6, backgroundColor: colors.divider, borderRadius: 3, overflow: 'hidden', marginBottom: 5 },
  thinFill: { height: '100%', borderRadius: 3 },
  radioOuter: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: colors.border },

  refreshBtn: {
    width: 28, height: 28, borderRadius: radius.sm,
    backgroundColor: colors.infoBg, alignItems: 'center', justifyContent: 'center',
  },
  speedGrid: { flexDirection: 'row', marginTop: spacing.sm },
  speedStat: { flex: 1, alignItems: 'center', paddingVertical: 8 },
  speedValue: { fontSize: 22, fontWeight: '700', color: colors.textPrimary },

  premiumUpsell: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.warningBg, borderWidth: 2, borderColor: '#fde68a',
    borderRadius: radius.lg, padding: spacing.md,
  },
  upgradeBtn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 8 },
  upgradeBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  dangerBtn: { backgroundColor: '#dc2626', borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 7 },
  dangerBtnText: { fontSize: 12, fontWeight: '600', color: '#fff' },
  neutralBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 7 },
  neutralBtnText: { fontSize: 12, color: colors.textSecondary },

  fslRow: {
    borderWidth: 1, borderColor: colors.divider, borderRadius: radius.md,
    padding: spacing.sm, marginTop: spacing.sm, gap: 4,
  },
  mountUrl: { fontSize: 12, color: colors.primary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  navRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: 12 },
  navIcon: {
    width: 30, height: 30, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  navLabel: { fontSize: 14, color: colors.textPrimary, flexShrink: 1 },
  countBadge: {
    minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.error,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  countBadgeText: { fontSize: 10, fontWeight: '700', color: '#fff' },

  signOutButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, gap: spacing.sm,
  },
  signOutText: { color: colors.error, fontWeight: '600', fontSize: 16 },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: spacing.md },
  sheet: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: spacing.md, width: '100%', maxWidth: 420,
  },
  sheetTitle: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, marginBottom: 4 },
  driveOption: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md,
    padding: spacing.sm, marginTop: spacing.xs,
  },
  primaryBtn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 11, alignItems: 'center' },
  primaryBtnText: { fontSize: 14, fontWeight: '600', color: '#fff' },
});
