import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image as RNImage,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { ArrowLeft, Check, Merge, Pencil, Sparkles, Trash2, Video, X } from 'lucide-react-native';
import {
  deleteGroup,
  downloadRecognitionThumb,
  getGroupFiles,
  getRecognitionStatus,
  listRecognitionGroups,
  mergeGroups,
  renameGroup,
  type RecognitionGroup,
  type RecognitionKind,
  type RecognitionStatus,
} from '../api/recognition';
import { downloadFile, type ApiFile } from '../api/files';
import { colors, radius, spacing } from '../theme';

interface Props {
  visible: boolean;
  collectionID: string;
  // Deep link from a search hit: open directly on this group.
  initialGroupID?: string;
  onClose: () => void;
}

type Tab = 'all' | 'labeled';
type KindFilter = RecognitionKind | 'all';

const thumbCache = new Map<string, string>();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function groupLabel(g: RecognitionGroup): string {
  return g.user_label ?? g.auto_label;
}

// GroupCover loads the encrypted face/pet crop (or the first member file's
// preview for object groups) as an authed data URI, cached per source id.
function GroupCover({ group, size }: { group: RecognitionGroup; size: number }) {
  const sourceID = group.kind !== 'object' && group.cover_detection_id
    ? `det:${group.cover_detection_id}`
    : group.cover_file_id
      ? `file:${group.cover_file_id}`
      : null;
  const [uri, setUri] = useState<string | null>(sourceID ? thumbCache.get(sourceID) ?? null : null);

  useEffect(() => {
    if (!sourceID || uri) return;
    const [kind, id] = sourceID.split(':');
    const fetcher = kind === 'det' ? downloadRecognitionThumb(id) : downloadFile(id);
    fetcher
      .then((u) => { thumbCache.set(sourceID, u); setUri(u); })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceID]);

  if (!uri) {
    return (
      <View style={[styles.coverFallback, { width: size, height: size }]}>
        <Sparkles size={22} color={colors.textMuted} />
      </View>
    );
  }
  return <RNImage source={{ uri }} style={{ width: size, height: size }} resizeMode="cover" />;
}

// RecognitionGroupsModal browses a collection's face/pet/object groups:
// All/Labeled tabs, kind filters, inline rename, select-to-merge, delete,
// indexing status, and the recognition storage note.
export default function RecognitionGroupsModal({ visible, collectionID, initialGroupID, onClose }: Props) {
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState<Tab>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [groups, setGroups] = useState<RecognitionGroup[]>([]);
  const [status, setStatus] = useState<RecognitionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [openGroup, setOpenGroup] = useState<RecognitionGroup | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renamingID, setRenamingID] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);
  const openedInitial = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, s] = await Promise.all([
        listRecognitionGroups(collectionID, kind === 'all' ? undefined : kind, tab === 'labeled'),
        getRecognitionStatus(collectionID),
      ]);
      setGroups(g);
      setStatus(s);
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [collectionID, kind, tab]);

  useEffect(() => {
    if (visible) { load(); }
    else {
      setOpenGroup(null); setSelected(new Set()); setRenamingID(null); openedInitial.current = false;
    }
  }, [visible, load]);

  // Deep-link into a group once its data arrives.
  useEffect(() => {
    if (!visible || openedInitial.current || !initialGroupID || groups.length === 0) return;
    const g = groups.find((x) => x.id === initialGroupID);
    if (g) { setOpenGroup(g); openedInitial.current = true; }
  }, [visible, groups, initialGroupID]);

  // Poll status while indexing runs.
  useEffect(() => {
    if (!visible || !status) return;
    if (status.counts.pending + status.counts.processing === 0) return;
    const t = setInterval(async () => {
      try { setStatus(await getRecognitionStatus(collectionID)); } catch {}
    }, 5000);
    return () => clearInterval(t);
  }, [visible, status, collectionID]);

  const indexing = (status?.counts.pending ?? 0) + (status?.counts.processing ?? 0);
  const indexed = status?.counts.done ?? 0;

  const selectedGroups = groups.filter((g) => selected.has(g.id));
  const canMerge =
    selectedGroups.length >= 2 &&
    new Set(selectedGroups.map((g) => `${g.kind}:${g.class_label ?? ''}`)).size === 1;

  const tileSize = useMemo(() => Math.floor((width - spacing.lg * 2 - spacing.sm * 2) / 3), [width]);

  const toggleSelect = (g: RecognitionGroup) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(g.id)) next.delete(g.id);
      else next.add(g.id);
      return next;
    });
  };

  const submitRename = async (g: RecognitionGroup) => {
    setBusy(true);
    try {
      await renameGroup(g.id, renameValue.trim());
      setRenamingID(null);
      await load();
    } catch {
      Alert.alert('Rename failed', 'Could not update the group label.');
    } finally {
      setBusy(false);
    }
  };

  const submitMerge = async () => {
    const [target, ...sources] = selectedGroups.map((g) => g.id);
    setBusy(true);
    try {
      await mergeGroups(target, sources);
      setSelected(new Set());
      await load();
    } catch {
      Alert.alert('Merge failed', 'Groups must be the same kind (and species for pets).');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = (g: RecognitionGroup) => {
    Alert.alert('Delete group', `Delete “${groupLabel(g)}”? Its photos are not deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try { await deleteGroup(g.id); await load(); } catch {
            Alert.alert('Delete failed', 'Could not delete the group.');
          }
        },
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          {openGroup ? (
            <TouchableOpacity onPress={() => setOpenGroup(null)} style={styles.backBtn}>
              <ArrowLeft size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          ) : (
            <Sparkles size={20} color={colors.warning} />
          )}
          <Text style={styles.title} numberOfLines={1}>
            {openGroup ? groupLabel(openGroup) : 'People, pets & objects'}
          </Text>
          <View style={[styles.statusChip, indexing > 0 ? styles.statusChipActive : styles.statusChipDone]}>
            <Text style={[styles.statusChipText, { color: indexing > 0 ? colors.primary : colors.success }]}>
              {indexing > 0 ? `Indexing ${indexed}/${indexed + indexing}…` : 'Up to date'}
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <X size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {status && status.storage_bytes > 0 && !openGroup && (
          <Text style={styles.storageNote}>
            Recognition data uses {formatBytes(status.storage_bytes)} of your storage.
          </Text>
        )}

        {openGroup ? (
          <GroupFilesGrid group={openGroup} tileSize={tileSize} />
        ) : (
          <>
            {/* Tabs + kind pills */}
            <View style={styles.pillRow}>
              {(['all', 'labeled'] as const).map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[styles.tabPill, tab === t && styles.tabPillActive]}
                  onPress={() => { setTab(t); setSelected(new Set()); }}
                >
                  <Text style={[styles.tabPillText, tab === t && styles.tabPillTextActive]}>
                    {t === 'all' ? 'All groups' : 'Labeled'}
                  </Text>
                </TouchableOpacity>
              ))}
              <View style={styles.pillDivider} />
              {(['all', 'face', 'pet', 'object'] as const).map((k) => (
                <TouchableOpacity
                  key={k}
                  style={[styles.kindPill, kind === k && styles.kindPillActive]}
                  onPress={() => { setKind(k); setSelected(new Set()); }}
                >
                  <Text style={[styles.kindPillText, kind === k && styles.kindPillTextActive]}>
                    {k === 'all' ? 'All' : k === 'face' ? 'Faces' : k === 'pet' ? 'Pets' : 'Objects'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {loading ? (
              <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.primary} />
            ) : groups.length === 0 ? (
              <Text style={styles.emptyText}>
                {tab === 'labeled'
                  ? 'No labeled groups yet — label a group to make it searchable.'
                  : indexing > 0
                    ? 'No groups yet — indexing is still running.'
                    : 'No groups found in this collection yet.'}
              </Text>
            ) : (
              <FlatList
                data={groups}
                keyExtractor={(g) => g.id}
                numColumns={3}
                contentContainerStyle={{ padding: spacing.lg }}
                columnWrapperStyle={{ gap: spacing.sm }}
                renderItem={({ item: g }) => (
                  <View style={{ width: tileSize, marginBottom: spacing.md }}>
                    <Pressable
                      onPress={() => (selected.size > 0 ? toggleSelect(g) : setOpenGroup(g))}
                      onLongPress={() => toggleSelect(g)}
                      style={[styles.tile, selected.has(g.id) && styles.tileSelected]}
                    >
                      <GroupCover group={g} size={tileSize} />
                      {selected.has(g.id) && (
                        <View style={styles.tileCheck}><Check size={14} color="#fff" /></View>
                      )}
                    </Pressable>
                    {renamingID === g.id ? (
                      <View style={styles.renameRow}>
                        <TextInput
                          autoFocus
                          value={renameValue}
                          onChangeText={setRenameValue}
                          placeholder={g.auto_label}
                          maxLength={80}
                          style={styles.renameInput}
                          onSubmitEditing={() => submitRename(g)}
                        />
                        <TouchableOpacity onPress={() => submitRename(g)} disabled={busy}>
                          <Check size={16} color={colors.success} />
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <View style={styles.labelRow}>
                        <Text style={styles.labelText} numberOfLines={1}>{groupLabel(g)}</Text>
                        <Text style={styles.countText}>{g.file_count}</Text>
                        <TouchableOpacity
                          onPress={() => { setRenamingID(g.id); setRenameValue(g.user_label ?? ''); }}
                          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                        >
                          <Pencil size={13} color={colors.textMuted} />
                        </TouchableOpacity>
                        {tab === 'labeled' && (
                          <TouchableOpacity onPress={() => confirmDelete(g)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                            <Trash2 size={13} color={colors.error} />
                          </TouchableOpacity>
                        )}
                      </View>
                    )}
                  </View>
                )}
              />
            )}

            {/* Merge bar */}
            {selected.size >= 2 && (
              <View style={styles.mergeBar}>
                <Text style={styles.mergeText}>
                  {selected.size} selected{!canMerge ? ' — kinds must match' : ''}
                </Text>
                <TouchableOpacity style={styles.cancelBtn} onPress={() => setSelected(new Set())}>
                  <Text style={styles.cancelBtnText}>Clear</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.mergeBtn, (!canMerge || busy) && { opacity: 0.4 }]}
                  disabled={!canMerge || busy}
                  onPress={submitMerge}
                >
                  <Merge size={14} color="#fff" />
                  <Text style={styles.mergeBtnText}>Merge</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}
      </View>
    </Modal>
  );
}

// GroupFilesGrid pages a group's files as authed data-URI thumbs; tapping an
// image shows it fullscreen inside the modal.
function GroupFilesGrid({ group, tileSize }: { group: RecognitionGroup; tileSize: number }) {
  const [files, setFiles] = useState<ApiFile[]>([]);
  const [nextToken, setNextToken] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [fullscreen, setFullscreen] = useState<string | null>(null);

  const loadPage = useCallback(async (cursor?: string) => {
    const page = await getGroupFiles(group.id, cursor);
    setFiles((prev) => (cursor ? [...prev, ...page.items] : page.items));
    setNextToken(page.next_token || undefined);
  }, [group.id]);

  useEffect(() => {
    setLoading(true);
    loadPage().catch(() => {}).finally(() => setLoading(false));
  }, [loadPage]);

  if (loading) return <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.primary} />;
  if (files.length === 0) return <Text style={styles.emptyText}>No files in this group.</Text>;

  return (
    <>
      <FlatList
        data={files}
        keyExtractor={(f) => f.id}
        numColumns={3}
        contentContainerStyle={{ padding: spacing.lg }}
        columnWrapperStyle={{ gap: spacing.sm }}
        onEndReached={() => { if (nextToken) loadPage(nextToken).catch(() => {}); }}
        onEndReachedThreshold={0.5}
        renderItem={({ item }) => <FileThumb file={item} size={tileSize} onOpen={setFullscreen} />}
      />
      <Modal visible={!!fullscreen} transparent animationType="fade" onRequestClose={() => setFullscreen(null)}>
        <Pressable style={styles.fullscreenOverlay} onPress={() => setFullscreen(null)}>
          {fullscreen && <RNImage source={{ uri: fullscreen }} style={styles.fullscreenImage} resizeMode="contain" />}
        </Pressable>
      </Modal>
    </>
  );
}

function FileThumb({ file, size, onOpen }: { file: ApiFile; size: number; onOpen: (uri: string) => void }) {
  const cacheKey = `file:${file.id}`;
  const [uri, setUri] = useState<string | null>(thumbCache.get(cacheKey) ?? null);
  const isImage = file.mime_type.startsWith('image/');

  useEffect(() => {
    if (!isImage || uri) return;
    downloadFile(file.id)
      .then((u) => { thumbCache.set(cacheKey, u); setUri(u); })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  return (
    <TouchableOpacity
      style={[styles.tile, { width: size, height: size, marginBottom: spacing.sm }]}
      onPress={() => { if (uri) onOpen(uri); }}
      activeOpacity={0.85}
    >
      {isImage && uri ? (
        <RNImage source={{ uri }} style={{ width: size, height: size }} resizeMode="cover" />
      ) : (
        <View style={[styles.coverFallback, { width: size, height: size }]}>
          <Video size={22} color={colors.textMuted} />
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: { padding: 2 },
  title: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  statusChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statusChipActive: { backgroundColor: colors.infoBg },
  statusChipDone: { backgroundColor: colors.successBg },
  statusChipText: { fontSize: 10, fontWeight: '600' },
  storageNote: {
    fontSize: 11,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tabPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.sm },
  tabPillActive: { backgroundColor: colors.primaryLighter },
  tabPillText: { fontSize: 12, fontWeight: '600', color: colors.textSecondary },
  tabPillTextActive: { color: colors.primary },
  pillDivider: { width: 1, height: 16, backgroundColor: colors.border },
  kindPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: colors.divider },
  kindPillActive: { backgroundColor: colors.textPrimary },
  kindPillText: { fontSize: 11, fontWeight: '500', color: colors.textSecondary },
  kindPillTextActive: { color: '#fff' },
  emptyText: { fontSize: 13, color: colors.textSecondary, padding: spacing.lg },
  tile: {
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.divider,
  },
  tileSelected: { borderWidth: 2, borderColor: colors.primary },
  tileCheck: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.divider },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  labelText: { flex: 1, fontSize: 11, color: colors.textPrimary },
  countText: { fontSize: 10, color: colors.textMuted },
  renameRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  renameInput: {
    flex: 1,
    fontSize: 11,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 3,
    color: colors.textPrimary,
  },
  mergeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  mergeText: { flex: 1, fontSize: 12, color: colors.textSecondary },
  cancelBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border },
  cancelBtnText: { fontSize: 12, color: colors.textSecondary },
  mergeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  mergeBtnText: { fontSize: 12, color: '#fff', fontWeight: '600' },
  fullscreenOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  fullscreenImage: { width: '100%', height: '80%' },
});
