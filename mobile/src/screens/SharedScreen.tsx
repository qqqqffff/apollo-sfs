import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  Share as NativeShare,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import {
  ArrowLeft,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderInput,
  Link2,
  Link2Off,
} from 'lucide-react-native';
import {
  getSharedContents,
  listMyShares,
  listSharedWithMe,
  revokeShare,
  type Share,
  type SharedContents,
} from '../api/shares';
import { card, colors, radius, spacing } from '../theme';

function formatSize(bytes: number): string {
  const GB = 1024 ** 3;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function permissionLabel(share: Share): string {
  if (share.item_type === 'folder') {
    if (share.can_upload) return 'view · upload · download';
    return share.can_download ? 'view · download' : 'view only';
  }
  return share.can_download ? 'view · download' : 'view only';
}

// Port of the web /client/shared page: shares received (browsable for folders)
// and shares granted (revoke + share link via the native share sheet).
export default function SharedScreen() {
  const navigation = useNavigation<any>();
  const [withMe, setWithMe] = useState<Share[]>([]);
  const [mine, setMine] = useState<Share[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  // Folder-browsing state for an opened folder share.
  const [openShare, setOpenShare] = useState<Share | null>(null);
  const [folderStack, setFolderStack] = useState<{ id: string | null; name: string }[]>([]);
  const [contents, setContents] = useState<SharedContents | null>(null);
  const [contentsLoading, setContentsLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, m] = await Promise.all([
        listSharedWithMe().catch(() => [] as Share[]),
        listMyShares().catch(() => [] as Share[]),
      ]);
      setWithMe(w);
      setMine(m);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleRevoke = (share: Share) => {
    Alert.alert('Revoke share?', `${share.recipient_email} will lose access to "${share.item_name}".`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: async () => {
          setRevoking(share.id);
          try {
            await revokeShare(share.id);
            setMine((cur) => cur.filter((s) => s.id !== share.id));
          } catch {
            Alert.alert('Failed to revoke share');
          } finally {
            setRevoking(null);
          }
        },
      },
    ]);
  };

  const handleShareLink = async (share: Share) => {
    try {
      await NativeShare.share({ message: share.share_url });
    } catch {
      // user dismissed the sheet
    }
  };

  const browseTo = async (share: Share, folderId: string | null, name: string, push: boolean) => {
    setOpenShare(share);
    setContentsLoading(true);
    if (push) setFolderStack((s) => [...s, { id: folderId, name }]);
    try {
      setContents(await getSharedContents(share.id, folderId));
    } catch (e: any) {
      Alert.alert('Could not open share', e?.response?.data?.error ?? e?.message ?? 'Unknown error');
      setOpenShare(null);
      setFolderStack([]);
    } finally {
      setContentsLoading(false);
    }
  };

  const openItem = (share: Share) => {
    if (share.item_type === 'folder') {
      setFolderStack([]);
      browseTo(share, null, share.item_name, true);
    } else {
      Alert.alert(share.item_name, `${share.item_mime_type ?? 'file'} · ${formatSize(share.item_size_bytes)}\nShared by ${share.owner_email ?? 'unknown'}.`);
    }
  };

  const goBackFolder = () => {
    if (!openShare) return;
    const next = folderStack.slice(0, -1);
    setFolderStack(next);
    if (next.length === 0) {
      setOpenShare(null);
      setContents(null);
      return;
    }
    browseTo(openShare, next[next.length - 1].id, next[next.length - 1].name, false);
  };

  // ── Folder browser view ─────────────────────────────────────────────────────
  if (openShare) {
    const current = folderStack[folderStack.length - 1];
    return (
      <View style={styles.container}>
        <View style={styles.browserHeader}>
          <TouchableOpacity style={styles.backRow} onPress={goBackFolder}>
            <ArrowLeft size={16} color={colors.textSecondary} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
          <Text style={styles.pageTitle} numberOfLines={1}>{current?.name ?? openShare.item_name}</Text>
          <Text style={styles.browserMeta}>
            from {openShare.owner_email ?? 'unknown'} · {permissionLabel(openShare)}
          </Text>
        </View>
        {contentsLoading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
        ) : (
          <ScrollView contentContainerStyle={{ padding: spacing.md }}>
            <View style={card}>
              {(contents?.subfolders?.items ?? []).map((f, i) => (
                <TouchableOpacity
                  key={f.id}
                  style={[styles.itemRow, i > 0 && styles.rowBorder]}
                  onPress={() => openShare.include_children && browseTo(openShare, f.id, f.name, true)}
                  disabled={!openShare.include_children}
                >
                  <Folder size={18} color={colors.primary} />
                  <Text style={styles.itemName} numberOfLines={1}>{f.name}</Text>
                  {openShare.include_children && <ChevronRight size={16} color={colors.textMuted} />}
                </TouchableOpacity>
              ))}
              {(contents?.files?.items ?? []).map((f, i) => (
                <View
                  key={f.id}
                  style={[styles.itemRow, ((contents?.subfolders?.items?.length ?? 0) > 0 || i > 0) && styles.rowBorder]}
                >
                  <FileIcon size={18} color={colors.textMuted} />
                  <Text style={styles.itemName} numberOfLines={1}>{f.name}</Text>
                  <Text style={styles.itemMeta}>{formatSize(f.size_bytes)}</Text>
                </View>
              ))}
              {(contents?.subfolders?.items?.length ?? 0) === 0 && (contents?.files?.items?.length ?? 0) === 0 && (
                <Text style={[styles.emptyText, { padding: spacing.md }]}>This folder is empty.</Text>
              )}
            </View>
          </ScrollView>
        )}
      </View>
    );
  }

  // ── List view ───────────────────────────────────────────────────────────────
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={styles.headerRow}>
        <Text style={styles.pageTitle}>Shared</Text>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backLink}>Back</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : (
        <>
          <Text style={styles.groupTitle}>SHARED WITH ME</Text>
          {withMe.length === 0 ? (
            <Text style={[styles.emptyText, { marginBottom: spacing.lg }]}>
              Nothing has been shared with you yet.
            </Text>
          ) : (
            <View style={[card, { marginBottom: spacing.lg }]}>
              {withMe.map((s, i) => (
                <TouchableOpacity
                  key={s.id}
                  style={[styles.itemRow, i > 0 && styles.rowBorder]}
                  onPress={() => openItem(s)}
                >
                  {s.item_type === 'folder'
                    ? (s.include_children
                        ? <FolderInput size={18} color={colors.primary} />
                        : <Folder size={18} color={colors.primary} />)
                    : <FileIcon size={18} color={colors.textMuted} />}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName} numberOfLines={1}>{s.item_name}</Text>
                    <Text style={styles.itemMeta}>from {s.owner_email ?? 'unknown'}</Text>
                  </View>
                  <View style={styles.permBadge}>
                    <Text style={styles.permBadgeText}>{permissionLabel(s)}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <Text style={styles.groupTitle}>SHARED BY ME</Text>
          {mine.length === 0 ? (
            <Text style={styles.emptyText}>
              You haven't shared anything. Use the share option next to a file or folder.
            </Text>
          ) : (
            <View style={card}>
              {mine.map((s, i) => (
                <View key={s.id} style={[styles.itemRow, i > 0 && styles.rowBorder]}>
                  {s.item_type === 'folder'
                    ? <Folder size={18} color={colors.primary} />
                    : <FileIcon size={18} color={colors.textMuted} />}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.itemName} numberOfLines={1}>{s.item_name}</Text>
                    <Text style={styles.itemMeta}>to {s.recipient_email}</Text>
                  </View>
                  <View style={styles.permBadge}>
                    <Text style={styles.permBadgeText}>{permissionLabel(s)}</Text>
                  </View>
                  <TouchableOpacity onPress={() => handleShareLink(s)} hitSlop={8} style={styles.iconBtn}>
                    <Link2 size={17} color={colors.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleRevoke(s)}
                    hitSlop={8}
                    style={styles.iconBtn}
                    disabled={revoking === s.id}
                  >
                    <Link2Off size={17} color={revoking === s.id ? colors.border : colors.error} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },

  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  pageTitle: { fontSize: 18, fontWeight: '600', color: colors.textPrimary },
  backLink: { fontSize: 12, color: colors.primary },

  groupTitle: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.8, marginBottom: spacing.xs },
  emptyText: { fontSize: 13, color: colors.textMuted, lineHeight: 19 },

  itemRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: 12,
  },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.divider },
  itemName: { fontSize: 14, color: colors.textPrimary, flexShrink: 1 },
  itemMeta: { fontSize: 11, color: colors.textMuted, marginTop: 1 },

  permBadge: { backgroundColor: colors.divider, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  permBadgeText: { fontSize: 9, color: colors.textSecondary },
  iconBtn: { padding: 2 },

  browserHeader: {
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border,
    paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.sm,
  },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 },
  backText: { fontSize: 13, color: colors.textSecondary },
  browserMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
});
