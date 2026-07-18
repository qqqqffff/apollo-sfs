import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Sparkles, X } from 'lucide-react-native';
import { getRecognitionStatus, setRecognitionEnabled, type RecognitionStatus } from '../api/recognition';
import type { ApiFolder } from '../api/files';
import { colors, radius, spacing } from '../theme';

interface Props {
  visible: boolean;
  folder: ApiFolder;
  isPremium: boolean;
  onClose: () => void;
  // Called after the toggle changes so the parent can refresh the folder.
  onChanged: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// CollectionSettingsSheet is the media collection's info sheet: it hosts the
// premium AI recognition toggle with the enable disclaimer and the optional
// disable-time purge of stored recognition data.
export default function CollectionSettingsSheet({ visible, folder, isPremium, onClose, onChanged }: Props) {
  const [status, setStatus] = useState<RecognitionStatus | null>(null);
  const [confirming, setConfirming] = useState<'enable' | 'disable' | null>(null);
  const [purge, setPurge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isPremium) return;
    try {
      setStatus(await getRecognitionStatus(folder.id));
    } catch {
      setStatus(null);
    }
  }, [folder.id, isPremium]);

  useEffect(() => {
    if (visible) { setConfirming(null); setPurge(false); setError(null); refresh(); }
  }, [visible, refresh]);

  // Poll while indexing is active so the progress line moves.
  useEffect(() => {
    if (!visible || !status) return;
    const active = status.counts.pending + status.counts.processing > 0;
    if (!active) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [visible, status, refresh]);

  const enabled = status?.enabled ?? folder.ai_recognition_enabled ?? false;
  const indexing = (status?.counts.pending ?? 0) + (status?.counts.processing ?? 0);
  const indexed = status?.counts.done ?? 0;

  const applyToggle = async (nextEnabled: boolean, purgeData: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await setRecognitionEnabled(folder.id, nextEnabled, purgeData);
      setConfirming(null);
      setPurge(false);
      await refresh();
      onChanged();
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Failed to update setting');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>{folder.name}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <X size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={styles.aiCard}>
            <View style={styles.aiRow}>
              <View style={styles.aiTitleWrap}>
                <View style={styles.aiTitleRow}>
                  <Sparkles size={16} color="#f59e0b" />
                  <Text style={styles.aiTitle}>AI recognition</Text>
                </View>
                <Text style={styles.aiSubtitle}>
                  Group similar faces, identify unique pets, and label objects. Labeled groups
                  become searchable.
                </Text>
              </View>
              <Switch
                value={enabled}
                disabled={!isPremium || busy || !!confirming}
                onValueChange={(v) => setConfirming(v ? 'enable' : 'disable')}
              />
            </View>

            {!isPremium && (
              <Text style={styles.premiumHint}>
                AI recognition is a premium feature. Upgrade to Premium to enable it.
              </Text>
            )}

            {confirming === 'enable' && (
              <View style={styles.confirmBox}>
                <Text style={styles.confirmText}>
                  Photos and videos in this collection will be analyzed on the server to detect
                  faces, pets, and objects. Small encrypted thumbnails are stored in your storage
                  and count toward your storage quota. Indexing runs in the background and can
                  take a while for large collections.
                </Text>
                <View style={styles.confirmActions}>
                  <TouchableOpacity style={styles.cancelBtn} onPress={() => setConfirming(null)}>
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.confirmBtn}
                    disabled={busy}
                    onPress={() => applyToggle(true, false)}
                  >
                    {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.confirmBtnText}>Enable</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {confirming === 'disable' && (
              <View style={styles.confirmBox}>
                <Text style={styles.confirmText}>
                  Stop indexing this collection? Existing groups are kept unless you also delete
                  the recognition data.
                </Text>
                <TouchableOpacity style={styles.purgeRow} onPress={() => setPurge((p) => !p)}>
                  <View style={[styles.checkbox, purge && styles.checkboxChecked]} />
                  <Text style={styles.purgeText}>
                    Also delete groups and stored thumbnails
                    {status && status.storage_bytes > 0 ? ` (frees ${formatBytes(status.storage_bytes)})` : ''}
                  </Text>
                </TouchableOpacity>
                <View style={styles.confirmActions}>
                  <TouchableOpacity style={styles.cancelBtn} onPress={() => { setConfirming(null); setPurge(false); }}>
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.confirmBtn, styles.dangerBtn]}
                    disabled={busy}
                    onPress={() => applyToggle(false, purge)}
                  >
                    {busy ? <ActivityIndicator size="small" color="#fff" /> : (
                      <Text style={styles.confirmBtnText}>{purge ? 'Disable & delete' : 'Disable'}</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {enabled && status && (
              <Text style={styles.statusLine}>
                {indexing > 0 ? `Indexing ${indexed}/${indexed + indexing}…` : 'Up to date'}
                {status.storage_bytes > 0 ? ` · ${formatBytes(status.storage_bytes)} of your storage used` : ''}
              </Text>
            )}

            {enabled && status && !status.service_available && (
              <Text style={styles.errorText}>Recognition service is currently unavailable.</Text>
            )}
            {error && <Text style={styles.errorText}>{error}</Text>}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  sheet: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  title: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, flex: 1, marginRight: spacing.sm },
  aiCard: { backgroundColor: colors.background, borderRadius: radius.md, padding: spacing.md },
  aiRow: { flexDirection: 'row', alignItems: 'center' },
  aiTitleWrap: { flex: 1, marginRight: spacing.md },
  aiTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  aiTitle: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  aiSubtitle: { fontSize: 12, color: colors.textSecondary, marginTop: 2, lineHeight: 16 },
  premiumHint: { fontSize: 12, color: '#d97706', marginTop: spacing.sm },
  confirmBox: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: '#fcd34d',
    backgroundColor: '#fffbeb',
    borderRadius: radius.md,
    padding: spacing.md,
  },
  confirmText: { fontSize: 12, color: colors.textPrimary, lineHeight: 17 },
  confirmActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  cancelBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.divider },
  cancelBtnText: { fontSize: 12, color: colors.textSecondary },
  confirmBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.sm, backgroundColor: colors.primary },
  dangerBtn: { backgroundColor: '#dc2626' },
  confirmBtnText: { fontSize: 12, color: '#fff', fontWeight: '600' },
  purgeRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, gap: 8 },
  checkbox: { width: 16, height: 16, borderRadius: 4, borderWidth: 1.5, borderColor: colors.textSecondary },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  purgeText: { fontSize: 12, color: colors.textPrimary, flex: 1 },
  statusLine: { fontSize: 11, color: colors.textSecondary, marginTop: spacing.sm },
  errorText: { fontSize: 11, color: '#dc2626', marginTop: spacing.xs },
});
