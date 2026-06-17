import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import appleAuth from '@invertase/react-native-apple-authentication';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import { Bug, Cpu, HardDrive, Key, LogOut, Rocket, Server, Thermometer, Upload, Wifi, Zap } from 'lucide-react-native';
import { linkSocial, unlinkSocial } from '../api/auth';
import { ALARM_TYPES, type AlarmSettings, getAlarmSettings, toggleAlarmSubscription } from '../api/alarms';
import { useAuth } from '../context/AuthContext';
import { colors, radius, shadow, spacing } from '../theme';

const PREMIUM_FEATURES: { Icon: React.ComponentType<{ size: number; color: string; strokeWidth?: number }>; title: string; description: string }[] = [
  { Icon: Key,    title: 'Per-directory API keys',  description: 'Issue scoped keys tied to specific folders for fine-grained access control.' },
  { Icon: Server, title: 'S3-compatible API',        description: 'Access your files via an S3-like HTTP API, compatible with standard S3 clients.' },
  { Icon: Upload, title: 'Expanded storage quota',   description: 'Get significantly more storage space for your files and media.' },
  { Icon: Zap,    title: 'Priority support',         description: 'Jump to the front of the queue when you need help from the SFS team.' },
];

const ALARM_ICONS: Record<string, React.ComponentType<{ size: number; color: string; strokeWidth?: number }>> = {
  cpu_usage: Cpu,
  cpu_temp: Thermometer,
  drive_temp: Thermometer,
  drive_load: HardDrive,
  network_traffic: Wifi,
  api_error_rate: Bug,
};

export default function ProfileScreen() {
  const { profile, signOut } = useAuth();
  const [linking, setLinking] = useState(false);
  const [alarmSettings, setAlarmSettings] = useState<AlarmSettings | null>(null);
  const [alarmLoading, setAlarmLoading] = useState(false);
  const [upgradeVisible, setUpgradeVisible] = useState(false);

  const loadAlarms = useCallback(async () => {
    if (!profile?.is_admin) return;
    setAlarmLoading(true);
    try {
      const settings = await getAlarmSettings();
      setAlarmSettings(settings);
    } catch {
      // non-fatal
    } finally {
      setAlarmLoading(false);
    }
  }, [profile?.is_admin]);

  useEffect(() => { loadAlarms(); }, [loadAlarms]);

  const handleToggleAlarm = async (alarmType: string, currentlySubscribed: boolean) => {
    try {
      const updated = await toggleAlarmSubscription(alarmType, !currentlySubscribed);
      setAlarmSettings(updated);
    } catch (e: any) {
      Alert.alert('Failed to update alarm', e.message);
    }
  };

  const isSubscribed = (emailField: keyof AlarmSettings): boolean => {
    if (!alarmSettings || !profile?.email) return false;
    const emails = alarmSettings[emailField];
    return Array.isArray(emails) && emails.includes(profile.email);
  };

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
      Alert.alert('Apple ID linked');
    } catch (e: any) {
      if (e.code !== appleAuth.Error.CANCELED) Alert.alert('Failed to link Apple ID', e.message);
    } finally {
      setLinking(false);
    }
  };

  const handleUnlinkApple = async () => {
    try { await unlinkSocial('apple'); Alert.alert('Apple ID unlinked'); }
    catch (e: any) { Alert.alert('Failed', e.message); }
  };

  const handleLinkGoogle = async () => {
    try {
      await GoogleSignin.hasPlayServices();
      const response = await GoogleSignin.signIn();
      const idToken = (response as any).data?.idToken ?? (response as any).idToken;
      if (!idToken) throw new Error('No ID token');
      await linkSocial('google', idToken);
      Alert.alert('Google account linked');
    } catch (e: any) {
      if (e.code !== statusCodes.SIGN_IN_CANCELLED) Alert.alert('Failed to link Google', e.message);
    }
  };

  const handleUnlinkGoogle = async () => {
    try { await unlinkSocial('google'); Alert.alert('Google account unlinked'); }
    catch (e: any) { Alert.alert('Failed', e.message); }
  };

  const usedPct =
    profile && profile.storage_quota_bytes > 0
      ? ((profile.storage_used_bytes / profile.storage_quota_bytes) * 100).toFixed(1)
      : '0';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Account info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Username</Text>
          <Text style={styles.infoValue}>{profile?.username}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Email</Text>
          <Text style={styles.infoValue}>{profile?.email}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Account type</Text>
          <Text style={[
            styles.infoValue,
            profile?.is_admin ? styles.badgeAdmin : profile?.is_premium ? styles.badgePremium : styles.badgeUser,
          ]}>
            {profile?.is_admin ? 'Admin' : profile?.is_premium ? 'Premium' : 'User'}
          </Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Storage used</Text>
          <Text style={styles.infoValue}>{usedPct}%</Text>
        </View>
      </View>

      {/* Premium upgrade card (non-premium, non-admin only) */}
      {!profile?.is_premium && !profile?.is_admin && (
        <View style={styles.premiumCard}>
          <View style={styles.premiumCardInner}>
            <View style={styles.premiumIconWrap}>
              <Rocket size={20} color={colors.warning} strokeWidth={1.5} />
            </View>
            <View style={styles.premiumCardText}>
              <Text style={styles.premiumCardTitle}>Upgrade to Premium</Text>
              <Text style={styles.premiumCardDesc}>Unlock the S3 API, per-directory API keys, and more.</Text>
            </View>
            <TouchableOpacity style={styles.upgradeBtn} onPress={() => setUpgradeVisible(true)}>
              <Text style={styles.upgradeBtnText}>Upgrade</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Premium features modal */}
      <Modal
        visible={upgradeVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setUpgradeVisible(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setUpgradeVisible(false)}>
          <Pressable style={styles.upgradeSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.upgradeHeader}>
              <Rocket size={22} color={colors.warning} strokeWidth={1.5} />
              <View style={styles.upgradeHeaderText}>
                <Text style={styles.upgradeTitle}>Premium</Text>
                <Text style={styles.upgradeSubtitle}>One-time payment. No subscriptions.</Text>
              </View>
            </View>

            {PREMIUM_FEATURES.map(({ Icon, title, description }, i) => (
              <View key={title} style={[styles.featureRow, i > 0 && styles.featureRowBorder]}>
                <View style={styles.featureIconWrap}>
                  <Icon size={16} color={colors.warning} strokeWidth={1.5} />
                </View>
                <View style={styles.featureText}>
                  <Text style={styles.featureTitle}>{title}</Text>
                  <Text style={styles.featureDesc}>{description}</Text>
                </View>
              </View>
            ))}

            <View style={styles.upgradeActions}>
              <TouchableOpacity style={styles.maybeLaterBtn} onPress={() => setUpgradeVisible(false)}>
                <Text style={styles.maybeLaterText}>Maybe later</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.getPremiumBtn} onPress={() => setUpgradeVisible(false)}>
                <Text style={styles.getPremiumText}>Get Premium</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Linked accounts */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Linked Accounts</Text>

        {Platform.OS === 'ios' && (
          <View style={styles.linkedRow}>
            <Text style={styles.linkedLabel}>Apple ID</Text>
            <View style={styles.linkedActions}>
              <TouchableOpacity onPress={handleLinkApple} disabled={linking} style={styles.linkBtn}>
                <Text style={styles.linkText}>Link</Text>
              </TouchableOpacity>
              <Text style={styles.sep}> · </Text>
              <TouchableOpacity onPress={handleUnlinkApple} style={styles.linkBtn}>
                <Text style={styles.unlinkText}>Unlink</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.linkedRow}>
          <Text style={styles.linkedLabel}>Google</Text>
          <View style={styles.linkedActions}>
            <TouchableOpacity onPress={handleLinkGoogle} style={styles.linkBtn}>
              <Text style={styles.linkText}>Link</Text>
            </TouchableOpacity>
            <Text style={styles.sep}> · </Text>
            <TouchableOpacity onPress={handleUnlinkGoogle} style={styles.linkBtn}>
              <Text style={styles.unlinkText}>Unlink</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Admin: alarm notifications */}
      {profile?.is_admin && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Alarm Notifications</Text>
          <Text style={styles.sectionSubtitle}>
            Receive email notifications when server thresholds are breached.
          </Text>

          {alarmLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.alarmLoader} />
          ) : (
            ALARM_TYPES.map(({ key, emailField, label, description }, i) => {
              const Icon = ALARM_ICONS[key] ?? Server;
              const subscribed = isSubscribed(emailField);
              return (
                <React.Fragment key={key}>
                  {i > 0 && <View style={styles.divider} />}
                  <View style={styles.alarmRow}>
                    <View style={[styles.alarmIconWrap, subscribed && styles.alarmIconActive]}>
                      <Icon size={18} color={subscribed ? colors.primary : colors.textMuted} strokeWidth={1.5} />
                    </View>
                    <View style={styles.alarmText}>
                      <Text style={styles.alarmLabel}>{label}</Text>
                      <Text style={styles.alarmDesc}>{description}</Text>
                    </View>
                    <Switch
                      value={subscribed}
                      onValueChange={() => handleToggleAlarm(key, subscribed)}
                      trackColor={{ false: colors.border, true: colors.primaryLight }}
                      thumbColor={subscribed ? colors.primary : colors.textMuted}
                    />
                  </View>
                </React.Fragment>
              );
            })
          )}
        </View>
      )}

      {/* Sign out */}
      <TouchableOpacity style={styles.signOutButton} onPress={signOut}>
        <LogOut size={18} color={colors.error} strokeWidth={2} />
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },

  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadow.sm,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
  },
  sectionSubtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.md,
    lineHeight: 18,
  },

  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  infoLabel: { fontSize: 15, color: colors.textSecondary },
  infoValue: { fontSize: 15, fontWeight: '500', color: colors.textPrimary, flexShrink: 1, marginLeft: spacing.sm, textAlign: 'right' },

  divider: { height: 1, backgroundColor: colors.divider },

  linkedRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  linkedLabel: { fontSize: 15, color: colors.textPrimary },
  linkedActions: { flexDirection: 'row', alignItems: 'center' },
  linkBtn: { padding: spacing.xs },
  linkText: { color: colors.primary, fontSize: 14, fontWeight: '500' },
  unlinkText: { color: colors.error, fontSize: 14, fontWeight: '500' },
  sep: { color: colors.textMuted },

  alarmLoader: { marginVertical: spacing.md },
  alarmRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  alarmIconWrap: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.divider,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  alarmIconActive: { backgroundColor: colors.primaryLighter },
  alarmText: { flex: 1, marginRight: spacing.sm },
  alarmLabel: { fontSize: 14, fontWeight: '500', color: colors.textPrimary },
  alarmDesc: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },

  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingVertical: 14,
    gap: spacing.sm,
    ...shadow.sm,
  },
  signOutText: { color: colors.error, fontWeight: '600', fontSize: 16 },

  badgeAdmin:   { color: colors.primary },
  badgePremium: { color: colors.warning },
  badgeUser:    {},

  premiumCard: {
    backgroundColor: colors.warningBg,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: '#fcd34d',
    marginBottom: spacing.md,
    ...shadow.sm,
  },
  premiumCardInner: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: spacing.sm },
  premiumIconWrap: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: '#fef3c7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  premiumCardText: { flex: 1 },
  premiumCardTitle: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  premiumCardDesc:  { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  upgradeBtn: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 7 },
  upgradeBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: spacing.md },
  upgradeSheet: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    width: '100%',
    maxWidth: 420,
    padding: spacing.lg,
    ...shadow.sm,
  },
  upgradeHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  upgradeHeaderText: { flex: 1 },
  upgradeTitle:    { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  upgradeSubtitle: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },

  featureRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, gap: spacing.sm },
  featureRowBorder: { borderTopWidth: 1, borderTopColor: colors.divider },
  featureIconWrap: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    backgroundColor: colors.warningBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureText:  { flex: 1 },
  featureTitle: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  featureDesc:  { fontSize: 12, color: colors.textSecondary, marginTop: 2, lineHeight: 16 },

  upgradeActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  maybeLaterBtn: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 14, paddingVertical: 9 },
  maybeLaterText: { fontSize: 14, color: colors.textSecondary, fontWeight: '500' },
  getPremiumBtn: { backgroundColor: colors.primary, borderRadius: radius.sm, paddingHorizontal: 14, paddingVertical: 9 },
  getPremiumText: { fontSize: 14, color: '#fff', fontWeight: '600' },
});
