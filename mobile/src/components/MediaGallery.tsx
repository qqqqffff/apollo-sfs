import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Image as RNImage,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  ArrowRightFromLine,
  Check,
  Info,
  Smartphone,
  Star,
  Trash2,
  X,
} from 'lucide-react-native';
import {
  deleteFile,
  downloadFile,
  favoriteFile,
  getFolder,
  listRoot,
  moveFile,
  type ApiFile,
  type ApiFolder,
} from '../api/files';
import { getDoneHashSet } from '../services/UploadQueue';
import { colors, radius, spacing } from '../theme';

const { width: SCREEN_W } = Dimensions.get('window');
const GAP = 1;
const COL = 3;
const TILE_SIZE = Math.floor((SCREEN_W - GAP * (COL - 1)) / COL);
const SELECT_BAR_H = 64;

const urlCache = new Map<string, string>();

// ─── Grouping ─────────────────────────────────────────────────────────────────

type GallerySection = { title: string; dateKey: string; data: ApiFile[][] };

function buildSections(files: ApiFile[]): GallerySection[] {
  const sorted = [...files].sort((a, b) =>
    new Date(b.taken_at ?? b.created_at).getTime() -
    new Date(a.taken_at ?? a.created_at).getTime(),
  );
  const grouped = new Map<string, ApiFile[]>();
  for (const f of sorted) {
    const d = new Date(f.taken_at ?? f.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(f);
  }
  return Array.from(grouped.entries()).map(([dateKey, items]) => {
    const d = new Date(`${dateKey}-15T12:00:00`);
    const title = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
    const rows: ApiFile[][] = [];
    for (let i = 0; i < items.length; i += COL) rows.push(items.slice(i, i + COL));
    return { title, dateKey, data: rows };
  });
}

function formatBytes(b: number) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ─── Tile ─────────────────────────────────────────────────────────────────────

interface TileProps {
  file: ApiFile;
  isSelected: boolean;
  isSelectMode: boolean;
  isSynced: boolean;
  onToggle: () => void;
  onLongPress: () => void;
  onFavorite: () => void;
  onDelete: () => void;
  onInfo: () => void;
}

function Tile({ file, isSelected, isSelectMode, isSynced, onToggle, onLongPress, onFavorite, onDelete, onInfo }: TileProps) {
  const [url, setUrl] = useState<string | null>(urlCache.get(file.id) ?? null);
  const [fetching, setFetching] = useState(!urlCache.has(file.id));
  const [urlError, setUrlError] = useState(false);
  const [showErrorBar, setShowErrorBar] = useState(false);
  const scanAnim = useRef(new Animated.Value(0)).current;
  const scanLoop = useRef<Animated.CompositeAnimation | null>(null);
  const justLongPressed = useRef(false);

  useEffect(() => {
    if (url) { setFetching(false); return; }
    setFetching(true);
    downloadFile(file.id)
      .then((u) => { urlCache.set(file.id, u); setUrl(u); setFetching(false); })
      .catch((err: any) => {
        console.error('[MediaGallery] preview fetch failed', file.id, err?.response?.status, err?.message);
        setFetching(false);
        setUrlError(true);
        setShowErrorBar(true);
        setTimeout(() => setShowErrorBar(false), 1400);
      });
  // intentionally run once per file.id only
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  useEffect(() => {
    if (fetching) {
      scanAnim.setValue(0);
      scanLoop.current = Animated.loop(
        Animated.timing(scanAnim, { toValue: 1, duration: 1100, useNativeDriver: true }),
      );
      scanLoop.current.start();
    } else {
      scanLoop.current?.stop();
    }
    return () => { scanLoop.current?.stop(); };
  }, [fetching, scanAnim]);

  const translateX = scanAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-TILE_SIZE, TILE_SIZE],
  });

  const handlePress = () => {
    if (justLongPressed.current) { justLongPressed.current = false; return; }
    onToggle();
  };
  const handleLongPress = () => {
    if (!isSelectMode) { justLongPressed.current = true; onLongPress(); }
  };

  const isImage = file.mime_type.startsWith('image/');
  const isVideo = file.mime_type.startsWith('video/');

  return (
    <TouchableOpacity
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={350}
      activeOpacity={0.85}
      style={{ width: TILE_SIZE, height: TILE_SIZE, overflow: 'hidden', backgroundColor: colors.divider }}
    >
      {/* Image */}
      {url && isImage && !urlError ? (
        <RNImage source={{ uri: url }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={(e) => { console.error('[MediaGallery] RNImage load failed', file.id, e.nativeEvent.error); setUrlError(true); setShowErrorBar(true); setTimeout(() => setShowErrorBar(false), 1400); }} />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.tilePlaceholder]}>
          {urlError && !showErrorBar && (
            <Text style={{ fontSize: isVideo ? 22 : 11, color: colors.textMuted }}>
              {isVideo ? '▶' : file.name.split('.').pop()?.toUpperCase() ?? '?'}
            </Text>
          )}
          {!urlError && !fetching && !isImage && (
            <Text style={{ fontSize: isVideo ? 22 : 11, color: colors.textMuted }}>
              {isVideo ? '▶' : file.name.split('.').pop()?.toUpperCase() ?? '?'}
            </Text>
          )}
        </View>
      )}

      {/* Loading scan bar */}
      {fetching && (
        <View style={styles.loadBar}>
          <Animated.View style={[styles.loadBarFill, { transform: [{ translateX }] }]} />
        </View>
      )}

      {/* Error bar */}
      {showErrorBar && <View style={[styles.loadBar, styles.loadBarError]} />}

      {/* Selection overlay */}
      {isSelectMode && isSelected && (
        <View style={[StyleSheet.absoluteFill, styles.selectedOverlay]} pointerEvents="none" />
      )}

      {/* Checkbox */}
      {isSelectMode && (
        <View style={styles.checkbox}>
          {isSelected ? (
            <View style={styles.checkboxOn}>
              <Check size={10} color="#fff" strokeWidth={3.5} />
            </View>
          ) : (
            <View style={styles.checkboxOff} />
          )}
        </View>
      )}

      {/* Per-tile toolbar (hidden in select mode) */}
      {!isSelectMode && isSelected && (
        <View style={styles.toolbar}>
          <TouchableOpacity style={styles.toolBtn} onPress={onFavorite} hitSlop={6}>
            <Star size={15} color="#fff" strokeWidth={1.5} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.toolBtn} onPress={onDelete} hitSlop={6}>
            <Trash2 size={15} color="#ffaaaa" strokeWidth={1.5} />
          </TouchableOpacity>
          {isSynced && (
            <View style={styles.toolBtn}>
              <Smartphone size={15} color={colors.success} strokeWidth={1.5} />
            </View>
          )}
          <TouchableOpacity style={styles.toolBtn} onPress={onInfo} hitSlop={6}>
            <Info size={15} color="#fff" strokeWidth={1.5} />
          </TouchableOpacity>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ─── Info row ─────────────────────────────────────────────────────────────────

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, mono && { fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface MediaGalleryProps {
  files: ApiFile[];
  currentFolderID: string;
  isSubcollection?: boolean;
  onDeleteFile: (id: string) => void;
}

interface MoveDestinations {
  subcollections: ApiFolder[];
  others: ApiFolder[];
}

export default function MediaGallery({ files, currentFolderID, isSubcollection, onDeleteFile }: MediaGalleryProps) {
  // View state
  const [toolbarFileId, setToolbarFileId] = useState<string | null>(null);
  const [infoFile, setInfoFile] = useState<ApiFile | null>(null);
  const [syncedHashes, setSyncedHashes] = useState<Set<string>>(new Set());
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const listRef = useRef<SectionList<ApiFile[], GallerySection>>(null);

  // Select mode
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const isSelectMode = selectedIds.size > 0;

  // Move modal
  const [moveModalVisible, setMoveModalVisible] = useState(false);
  const [moveDestinations, setMoveDestinations] = useState<MoveDestinations | null>(null);
  const [moveLoading, setMoveLoading] = useState(false);

  // Bulk action progress
  const [bulkInProgress, setBulkInProgress] = useState(false);

  useEffect(() => {
    getDoneHashSet().then(setSyncedHashes).catch(() => {});
  }, []);

  const sections = useMemo(() => buildSections(files), [files]);
  const dates = useMemo(() => sections.map((s) => ({ key: s.dateKey, title: s.title })), [sections]);

  const scrollToDate = (dateKey: string, index: number) => {
    setActiveDate(dateKey);
    try {
      listRef.current?.scrollToLocation({ sectionIndex: index, itemIndex: 0, animated: true, viewPosition: 0 });
    } catch {}
  };

  // ── Single-item actions ──────────────────────────────────────────────────────

  const handleSingleFavorite = async (fileId: string) => {
    try { await favoriteFile(fileId); } catch {}
    setToolbarFileId(null);
  };

  const handleSingleDelete = (fileId: string) => {
    Alert.alert('Delete File', 'Permanently delete this file from Apollo SFS?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await deleteFile(fileId);
            urlCache.delete(fileId);
            onDeleteFile(fileId);
            setToolbarFileId(null);
          } catch (e: any) { Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  // ── Select mode ──────────────────────────────────────────────────────────────

  const enterSelectMode = useCallback((fileId: string) => {
    setToolbarFileId(null);
    setSelectedIds(new Set([fileId]));
  }, []);

  const toggleSelected = useCallback((fileId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId); else next.add(fileId);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // ── Bulk actions ─────────────────────────────────────────────────────────────

  const handleBulkFavorite = async () => {
    setBulkInProgress(true);
    try {
      for (const id of selectedIds) { try { await favoriteFile(id); } catch {} }
    } finally {
      setBulkInProgress(false);
      exitSelectMode();
    }
  };

  const handleBulkDelete = () => {
    const count = selectedIds.size;
    Alert.alert(
      `Delete ${count} File${count !== 1 ? 's' : ''}`,
      'These files will be permanently deleted from Apollo SFS.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Delete ${count}`,
          style: 'destructive',
          onPress: async () => {
            setBulkInProgress(true);
            try {
              for (const id of selectedIds) {
                try { await deleteFile(id); urlCache.delete(id); onDeleteFile(id); } catch {}
              }
            } finally {
              setBulkInProgress(false);
              exitSelectMode();
            }
          },
        },
      ],
    );
  };

  const openMoveModal = useCallback(async () => {
    setMoveModalVisible(true);
    setMoveLoading(true);
    setMoveDestinations(null);
    try {
      const [currentData, rootData] = await Promise.all([
        getFolder(currentFolderID),
        listRoot(),
      ]);
      const subcollections = (currentData.subfolders?.items ?? []).filter((f) => f.kind === 'media');
      const others = (rootData.subfolders?.items ?? []).filter(
        (f) => f.kind === 'media' && f.id !== currentFolderID,
      );
      setMoveDestinations({ subcollections, others });
    } catch {
      setMoveDestinations({ subcollections: [], others: [] });
    } finally {
      setMoveLoading(false);
    }
  }, [currentFolderID]);

  const handleBulkMove = async (targetFolderID: string) => {
    setMoveModalVisible(false);
    setBulkInProgress(true);
    try {
      for (const id of selectedIds) {
        try { await moveFile(id, targetFolderID); onDeleteFile(id); } catch {}
      }
    } finally {
      setBulkInProgress(false);
      exitSelectMode();
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  if (sections.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No media in this collection</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Date jump nav */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.dateNav}
        contentContainerStyle={styles.dateNavContent}
      >
        {dates.map((d, i) => (
          <TouchableOpacity
            key={d.key}
            style={[styles.datePill, activeDate === d.key && styles.datePillActive]}
            onPress={() => scrollToDate(d.key, i)}
          >
            <Text style={[styles.datePillText, activeDate === d.key && styles.datePillTextActive]}>
              {d.title}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Photo grid */}
      <SectionList
        ref={listRef}
        sections={sections}
        stickySectionHeadersEnabled={false}
        keyExtractor={(row, i) => (row[0]?.id ?? 'pad') + i}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionHeaderText}>{section.title}</Text>
          </View>
        )}
        renderItem={({ item: row }) => {
          const padded: (ApiFile | null)[] = [...row, ...Array(COL - row.length).fill(null)];
          return (
            <View style={styles.gridRow}>
              {padded.map((file, i) => (
                <React.Fragment key={file?.id ?? `pad-${i}`}>
                  {i > 0 && <View style={{ width: GAP }} />}
                  {file ? (
                    <Tile
                      file={file}
                      isSelected={isSelectMode ? selectedIds.has(file.id) : toolbarFileId === file.id}
                      isSelectMode={isSelectMode}
                      isSynced={!!file.sha256_hash && syncedHashes.has(file.sha256_hash)}
                      onToggle={() => {
                        if (isSelectMode) {
                          toggleSelected(file.id);
                        } else {
                          setToolbarFileId((prev) => prev === file.id ? null : file.id);
                        }
                      }}
                      onLongPress={() => enterSelectMode(file.id)}
                      onFavorite={() => handleSingleFavorite(file.id)}
                      onDelete={() => handleSingleDelete(file.id)}
                      onInfo={() => { setInfoFile(file); setToolbarFileId(null); }}
                    />
                  ) : (
                    <View style={{ width: TILE_SIZE, height: TILE_SIZE }} />
                  )}
                </React.Fragment>
              ))}
            </View>
          );
        }}
        ItemSeparatorComponent={() => <View style={{ height: GAP }} />}
        contentContainerStyle={isSelectMode ? { paddingBottom: SELECT_BAR_H + 16 } : undefined}
        onScrollToIndexFailed={() => {}}
      />

      {/* Select mode sticky toolbar */}
      {isSelectMode && (
        <View style={styles.selectBar}>
          <TouchableOpacity style={styles.selectBarCancel} onPress={exitSelectMode}>
            <X size={18} color={colors.textSecondary} strokeWidth={2} />
          </TouchableOpacity>

          <Text style={styles.selectBarCount}>
            {selectedIds.size} selected
          </Text>

          {bulkInProgress ? (
            <ActivityIndicator color={colors.surface} style={{ marginRight: spacing.md }} />
          ) : (
            <View style={styles.selectBarActions}>
              <TouchableOpacity
                style={[styles.selectBarBtn, selectedIds.size === 0 && styles.selectBarBtnDisabled]}
                onPress={handleBulkFavorite}
                disabled={selectedIds.size === 0}
              >
                <Star size={20} color="#fff" strokeWidth={1.5} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.selectBarBtn, selectedIds.size === 0 && styles.selectBarBtnDisabled]}
                onPress={openMoveModal}
                disabled={selectedIds.size === 0}
              >
                <ArrowRightFromLine size={20} color="#fff" strokeWidth={1.5} />
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.selectBarBtn, styles.selectBarBtnDelete, selectedIds.size === 0 && styles.selectBarBtnDisabled]}
                onPress={handleBulkDelete}
                disabled={selectedIds.size === 0}
              >
                <Trash2 size={20} color="#fff" strokeWidth={1.5} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* Move destination modal */}
      <Modal
        visible={moveModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMoveModalVisible(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setMoveModalVisible(false)}>
          <Pressable style={styles.moveSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.moveTitle}>
              Move {selectedIds.size} file{selectedIds.size !== 1 ? 's' : ''} to…
            </Text>

            {moveLoading ? (
              <ActivityIndicator color={colors.primary} style={{ paddingVertical: spacing.lg }} />
            ) : moveDestinations ? (
              <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 360 }}>
                {moveDestinations.subcollections.length > 0 && (
                  <>
                    <Text style={styles.moveSectionLabel}>Subcollections</Text>
                    {moveDestinations.subcollections.map((f) => (
                      <TouchableOpacity key={f.id} style={styles.moveRow} onPress={() => handleBulkMove(f.id)}>
                        <View style={[styles.moveIcon, styles.moveIconMedia]}>
                          <Star size={16} color={colors.mediaAccent} strokeWidth={1.5} />
                        </View>
                        <Text style={styles.moveRowText} numberOfLines={1}>{f.name}</Text>
                      </TouchableOpacity>
                    ))}
                  </>
                )}

                {moveDestinations.others.length > 0 && (
                  <>
                    <Text style={styles.moveSectionLabel}>Other Collections</Text>
                    {moveDestinations.others.map((f) => (
                      <TouchableOpacity key={f.id} style={styles.moveRow} onPress={() => handleBulkMove(f.id)}>
                        <View style={[styles.moveIcon, styles.moveIconMedia]}>
                          <Star size={16} color={colors.mediaAccent} strokeWidth={1.5} />
                        </View>
                        <Text style={styles.moveRowText} numberOfLines={1}>{f.name}</Text>
                      </TouchableOpacity>
                    ))}
                  </>
                )}

                {moveDestinations.subcollections.length === 0 && moveDestinations.others.length === 0 && (
                  <Text style={styles.moveEmpty}>
                    No other collections available. Create subcollections or media collections in Files.
                  </Text>
                )}
              </ScrollView>
            ) : null}

            <TouchableOpacity style={styles.moveCancelBtn} onPress={() => setMoveModalVisible(false)}>
              <Text style={styles.moveCancelText}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Info modal */}
      <Modal visible={infoFile !== null} transparent animationType="fade" onRequestClose={() => setInfoFile(null)}>
        <Pressable style={styles.overlay} onPress={() => setInfoFile(null)}>
          <Pressable style={styles.infoSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.infoTitle}>File Info</Text>
            {infoFile && (
              <>
                <InfoRow label="Name" value={infoFile.name} />
                <InfoRow label="Type" value={infoFile.mime_type} />
                <InfoRow label="Size" value={formatBytes(infoFile.size_bytes)} />
                {infoFile.taken_at && <InfoRow label="Taken" value={new Date(infoFile.taken_at).toLocaleString()} />}
                <InfoRow label="Uploaded" value={new Date(infoFile.created_at).toLocaleString()} />
                {infoFile.sha256_hash && <InfoRow label="SHA-256" value={`${infoFile.sha256_hash.slice(0, 16)}…`} mono />}
                <InfoRow
                  label="Device Sync"
                  value={infoFile.sha256_hash && syncedHashes.has(infoFile.sha256_hash) ? '✓ Synced from this device' : 'Not from this device'}
                />
              </>
            )}
            <TouchableOpacity style={styles.infoCloseBtn} onPress={() => setInfoFile(null)}>
              <Text style={styles.infoCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 15, color: colors.textMuted },

  dateNav: { backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border, maxHeight: 44, flexGrow: 0 },
  dateNavContent: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm, paddingVertical: 6, gap: spacing.xs },
  datePill: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.xl, backgroundColor: colors.divider },
  datePillActive: { backgroundColor: colors.mediaAccent },
  datePillText: { fontSize: 12, fontWeight: '500', color: colors.textSecondary },
  datePillTextActive: { color: '#fff' },

  sectionHeader: { paddingHorizontal: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.xs, backgroundColor: colors.background },
  sectionHeaderText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, letterSpacing: 0.3 },

  gridRow: { flexDirection: 'row' },
  tilePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  selectedOverlay: { backgroundColor: 'rgba(124,58,237,0.22)' },

  loadBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: 3, overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.08)',
  },
  loadBarFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.primary,
    opacity: 0.7,
  },
  loadBarError: {
    backgroundColor: colors.error,
    opacity: 0.85,
  },

  checkbox: { position: 'absolute', top: 6, left: 6 },
  checkboxOff: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)',
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  checkboxOn: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: colors.mediaAccent,
    alignItems: 'center', justifyContent: 'center',
  },

  toolbar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingVertical: 5, paddingHorizontal: 2,
    justifyContent: 'space-around', alignItems: 'center',
  },
  toolBtn: { padding: 4 },

  // Select bar
  selectBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: SELECT_BAR_H,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  selectBarCancel: { padding: 4 },
  selectBarCount: { fontSize: 14, fontWeight: '600', color: '#fff', flex: 1 },
  selectBarActions: { flexDirection: 'row', gap: spacing.xs },
  selectBarBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  selectBarBtnDelete: { backgroundColor: 'rgba(239,68,68,0.3)' },
  selectBarBtnDisabled: { opacity: 0.4 },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },

  // Move modal
  moveSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.xl,
  },
  moveTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.sm },
  moveSectionLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8,
    marginTop: spacing.sm, marginBottom: spacing.xs,
  },
  moveRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.divider },
  moveIcon: { width: 30, height: 30, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', marginRight: spacing.sm },
  moveIconMedia: { backgroundColor: colors.mediaAccentLighter },
  moveRowText: { flex: 1, fontSize: 15, color: colors.textPrimary },
  moveEmpty: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.lg, lineHeight: 19 },
  moveCancelBtn: { marginTop: spacing.md, paddingVertical: 11, backgroundColor: colors.divider, borderRadius: radius.md, alignItems: 'center' },
  moveCancelText: { fontSize: 15, fontWeight: '500', color: colors.textSecondary },

  // Info modal
  infoSheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.md, paddingBottom: spacing.xl },
  infoTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.sm },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.divider },
  infoLabel: { fontSize: 13, color: colors.textSecondary, flex: 0.35 },
  infoValue: { fontSize: 13, color: colors.textPrimary, flex: 0.65, textAlign: 'right' },
  infoCloseBtn: { marginTop: spacing.md, paddingVertical: 10, backgroundColor: colors.primaryLight, borderRadius: radius.md, alignItems: 'center' },
  infoCloseBtnText: { color: colors.primary, fontWeight: '600', fontSize: 15 },
});
