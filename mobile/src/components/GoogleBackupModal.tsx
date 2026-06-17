import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Check,
  ChevronDown,
  Cloud,
  FileText,
  Folder,
  GalleryHorizontalEnd,
  Image,
  Info,
  Music,
  Trash2,
  Video,
  X,
  Zap,
} from 'lucide-react-native';
import RNBlobUtil from 'react-native-blob-util';
import { listRoot, uploadFile, type ApiFolder } from '../api/files';
import {
  downloadGoogleFile,
  deleteGoogleDriveFile,
  type GoogleBackupItem,
} from '../services/GoogleBackupService';
import { colors, radius, shadow, spacing } from '../theme';
import StorageUpgradeModal from './StorageUpgradeModal';

// ── Internal types ────────────────────────────────────────────────────────────

interface FileEntry {
  googleItem: GoogleBackupItem;
  name: string;
  type: string;
  size: number;
  source: 'drive' | 'photos';
  destFolderId: string | null;
}

type SortMode = 'type' | 'size' | 'name';
type Category = 'Photos' | 'Images' | 'Videos' | 'Audio' | 'Documents' | 'Other';

interface ListItem    { entry: FileEntry; index: number }
interface TypeSection { title: Category; data: ListItem[] }

interface Props {
  visible: boolean;
  items: GoogleBackupItem[];
  accessToken: string;
  quotaBytes: number;
  usedBytes: number;
  onClose: () => void;
  onDone: () => void;
  onStoragePurchased?: (newQuota: number) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CATEGORY_ORDER: Category[] = ['Photos', 'Images', 'Videos', 'Audio', 'Documents', 'Other'];

function getCategory(entry: FileEntry): Category {
  if (entry.source === 'photos') return 'Photos';
  const m = entry.type;
  if (m.startsWith('image/'))  return 'Images';
  if (m.startsWith('video/'))  return 'Videos';
  if (m.startsWith('audio/'))  return 'Audio';
  if (m.startsWith('text/') || m.startsWith('application/') || entry.googleItem.isGoogleDoc) return 'Documents';
  return 'Other';
}

function fileIcon(entry: FileEntry) {
  if (entry.source === 'photos')       return Image;
  if (entry.type.startsWith('image/')) return Image;
  if (entry.type.startsWith('video/')) return Video;
  if (entry.type.startsWith('audio/')) return Music;
  return FileText;
}

function fmt(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3)   return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function GoogleBackupModal({
  visible, items, accessToken, quotaBytes, usedBytes, onClose, onDone, onStoragePurchased,
}: Props) {
  const [entries, setEntries]         = useState<FileEntry[]>([]);
  const [selected, setSelected]       = useState<Set<number>>(new Set());
  const [sort, setSort]               = useState<SortMode>('type');
  const [folders, setFolders]         = useState<ApiFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [destPickerFor, setDestPickerFor]   = useState<number | null>(null);
  const [uploading, setUploading]     = useState(false);
  const [progress, setProgress]       = useState<{ done: number; total: number } | null>(null);
  const [uploadedCount, setUploadedCount]   = useState(0);
  const [uploadErrors, setUploadErrors]     = useState(0);
  const [finished, setFinished]       = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [upgradeVisible, setUpgradeVisible] = useState(false);

  // Reset when modal opens
  useEffect(() => {
    if (!visible || items.length === 0) return;
    const mapped: FileEntry[] = items.map((g) => ({
      googleItem:   g,
      name:         g.isGoogleDoc ? `${g.name}.pdf` : g.name,
      type:         g.isGoogleDoc ? 'application/pdf' : g.mimeType,
      size:         g.size ?? 0,
      source:       g.source,
      destFolderId: null,
    }));
    setEntries(mapped);
    setSelected(new Set(mapped.map((_, i) => i)));
    setSort('type');
    setUploading(false);
    setProgress(null);
    setUploadedCount(0);
    setUploadErrors(0);
    setFinished(false);
    setCleanupLoading(false);
  }, [visible, items]);

  useEffect(() => {
    if (!visible) return;
    setFoldersLoading(true);
    listRoot()
      .then((root) => setFolders(root.subfolders?.items ?? []))
      .catch(() => setFolders([]))
      .finally(() => setFoldersLoading(false));
  }, [visible]);

  // ── Selection ─────────────────────────────────────────────────────────────

  const toggle = (i: number) =>
    setSelected((prev) => { const s = new Set(prev); s.has(i) ? s.delete(i) : s.add(i); return s; });

  const toggleGroup = (indices: number[]) => {
    const allOn = indices.every((i) => selected.has(i));
    setSelected((prev) => {
      const s = new Set(prev);
      indices.forEach((i) => (allOn ? s.delete(i) : s.add(i)));
      return s;
    });
  };

  const allSelected = selected.size === entries.length;

  // ── Destinations ──────────────────────────────────────────────────────────

  const setDest = (i: number, folderId: string | null) => {
    setEntries((prev) => prev.map((e, j) => (j === i ? { ...e, destFolderId: folderId } : e)));
    setDestPickerFor(null);
  };

  const folderLabel = (id: string | null) =>
    id ? (folders.find((f) => f.id === id)?.name ?? '/ Root') : '/ Root';

  // ── Quota maths ───────────────────────────────────────────────────────────

  const selectedSize = useMemo(
    () => entries.filter((_, i) => selected.has(i)).reduce((s, e) => s + e.size, 0),
    [entries, selected],
  );

  const projectedUsed = usedBytes + selectedSize;
  const isOverQuota   = quotaBytes > 0 && projectedUsed > quotaBytes;
  const overflowBytes = isOverQuota ? projectedUsed - quotaBytes : 0;

  const usedPct  = quotaBytes > 0 ? Math.min((usedBytes / quotaBytes) * 100, 100) : 0;
  const fitsPct  = quotaBytes > 0
    ? (Math.max(0, Math.min(selectedSize, quotaBytes - usedBytes)) / quotaBytes) * 100
    : 0;
  const overflowPct = isOverQuota ? Math.max(0, 100 - usedPct - fitsPct) : 0;

  // ── Sorted / grouped data ─────────────────────────────────────────────────

  const typeSections: TypeSection[] = useMemo(() => {
    const map = new Map<Category, ListItem[]>(CATEGORY_ORDER.map((c) => [c, []]));
    entries.forEach((entry, index) => map.get(getCategory(entry))!.push({ entry, index }));
    return CATEGORY_ORDER
      .filter((c) => map.get(c)!.length > 0)
      .map((c) => ({ title: c, data: map.get(c)! }));
  }, [entries]);

  const flatData: ListItem[] = useMemo(() => {
    const indexed = entries.map((entry, index) => ({ entry, index }));
    if (sort === 'size') return [...indexed].sort((a, b) => b.entry.size - a.entry.size);
    if (sort === 'name') return [...indexed].sort((a, b) => a.entry.name.localeCompare(b.entry.name));
    return indexed;
  }, [entries, sort]);

  // ── Upload ────────────────────────────────────────────────────────────────

  const handleBackUp = async () => {
    const toUpload = entries.filter((_, i) => selected.has(i));
    if (toUpload.length === 0) return;
    setUploadedCount(toUpload.length);
    setUploading(true);
    setProgress({ done: 0, total: toUpload.length });
    let errors = 0;

    for (let i = 0; i < toUpload.length; i++) {
      const e = toUpload[i];
      let localUri: string | null = null;
      try {
        localUri = await downloadGoogleFile(e.googleItem, accessToken);
        await uploadFile(localUri, e.name, e.type, e.destFolderId ?? undefined);
      } catch {
        errors++;
      } finally {
        // Clean up the temp file regardless of upload success
        if (localUri) {
          try { await RNBlobUtil.fs.unlink(localUri.replace(/^file:\/\//, '')); }
          catch {}
        }
      }
      setProgress({ done: i + 1, total: toUpload.length });
    }

    setUploadErrors(errors);
    setUploading(false);
    setFinished(true);
  };

  // ── Cleanup ───────────────────────────────────────────────────────────────

  const handleCleanup = () => {
    const driveEntries  = entries.filter((e) => e.source === 'drive');
    const photoEntries  = entries.filter((e) => e.source === 'photos');
    const driveCount    = driveEntries.length;
    const photoCount    = photoEntries.length;

    // Photos-only: Google API can't delete them
    if (driveCount === 0) {
      Alert.alert(
        'Photos cannot be deleted via API',
        `Google does not allow third-party apps to delete Google Photos. Open the Google Photos app to remove ${photoCount} photo${photoCount !== 1 ? 's' : ''} manually.`,
      );
      return;
    }

    const driveLabel  = `${driveCount} Drive file${driveCount !== 1 ? 's' : ''}`;
    const photosNote  = photoCount > 0
      ? `\n\n${photoCount} Google Photo${photoCount !== 1 ? 's' : ''} cannot be deleted via API — remove them manually from the Google Photos app.`
      : '';

    Alert.alert(
      'Delete from Google Drive?',
      `Move ${driveLabel} to your Google Drive trash? They are safely backed up in Apollo SFS.${photosNote}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Trash ${driveLabel}`,
          style: 'destructive',
          onPress: async () => {
            setCleanupLoading(true);
            let failed = 0;
            for (const e of driveEntries) {
              try { await deleteGoogleDriveFile(e.googleItem.id, accessToken); }
              catch { failed++; }
            }
            setCleanupLoading(false);
            const resultMsg = failed === 0
              ? `${driveCount} file${driveCount !== 1 ? 's' : ''} moved to Google Drive trash.${photosNote}`
              : `${driveCount - failed} of ${driveCount} moved to trash. ${failed} failed.`;
            Alert.alert('Done', resultMsg);
          },
        },
      ],
    );
  };

  // ── Row renderer ──────────────────────────────────────────────────────────

  const renderRow = ({ entry, index }: ListItem) => {
    const checked = selected.has(index);
    const Icon    = fileIcon(entry);
    const isDrive = entry.source === 'drive';

    return (
      <TouchableOpacity
        style={styles.fileRow}
        onPress={() => toggle(index)}
        activeOpacity={0.7}
        disabled={uploading || finished}
      >
        <View style={[styles.checkbox, checked && styles.checkboxOn]}>
          {checked && <Check size={11} color={colors.surface} strokeWidth={3} />}
        </View>
        <View style={[styles.fileIconWrap, isDrive ? styles.fileIconDrive : styles.fileIconPhotos]}>
          <Icon size={18} color={isDrive ? colors.primary : colors.error} strokeWidth={1.5} />
        </View>
        <View style={styles.fileInfo}>
          <Text style={[styles.fileName, !checked && styles.textDimmed]} numberOfLines={1}>{entry.name}</Text>
          <View style={styles.fileMeta}>
            <View style={[styles.sourceBadge, isDrive ? styles.badgeDrive : styles.badgePhotos]}>
              <Text style={styles.sourceBadgeText}>{isDrive ? 'Drive' : 'Photos'}</Text>
            </View>
            <Text style={styles.fileSize}>{entry.size > 0 ? fmt(entry.size) : '—'}</Text>
          </View>
        </View>
        <TouchableOpacity
          style={[styles.destBtn, (!checked || uploading || finished) && styles.destBtnDisabled]}
          onPress={() => checked && !uploading && !finished && setDestPickerFor(index)}
          hitSlop={4}
        >
          <Text style={styles.destBtnText} numberOfLines={1}>{folderLabel(entry.destFolderId)}</Text>
          <ChevronDown size={12} color={colors.primary} />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  // ── Section header renderer ───────────────────────────────────────────────

  const renderSectionHeader = ({ section }: { section: TypeSection }) => {
    const indices    = section.data.map((d) => d.index);
    const selCount   = indices.filter((i) => selected.has(i)).length;
    const allGroupOn = selCount === section.data.length;
    return (
      <Pressable style={styles.sectionHeader} onPress={() => !finished && toggleGroup(indices)}>
        <Text style={styles.sectionTitle}>{section.title}</Text>
        <Text style={styles.sectionToggle}>
          {selCount}/{section.data.length}{'  '}
          {!finished && (allGroupOn ? 'Deselect all' : 'Select all')}
        </Text>
      </Pressable>
    );
  };

  // ── Derived UI state ──────────────────────────────────────────────────────

  const canBackUp    = selected.size > 0 && !isOverQuota && !uploading;
  const activeDest   = destPickerFor !== null ? entries[destPickerFor]?.destFolderId : undefined;
  const showSections = sort === 'type' && !finished;
  const listData     = finished
    ? entries.map((entry, index) => ({ entry, index }))
    : flatData;

  const driveCount   = entries.filter((e) => e.source === 'drive').length;
  const photoCount   = entries.filter((e) => e.source === 'photos').length;

  const cleanupLabel = driveCount > 0
    ? `Delete ${driveCount} Drive file${driveCount !== 1 ? 's' : ''} from Google Drive`
    : `${photoCount} photo${photoCount !== 1 ? 's' : ''} — delete manually in Google Photos`;

  return (
    <>
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={finished ? onDone : onClose}
    >
      <View style={styles.root}>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={finished ? onDone : onClose} style={styles.closeBtn} hitSlop={12}>
            <X size={20} color={colors.textPrimary} strokeWidth={2} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Google Backup</Text>
          {!finished ? (
            <TouchableOpacity
              style={styles.allBtn}
              onPress={() => setSelected(allSelected ? new Set() : new Set(entries.map((_, i) => i)))}
            >
              <Text style={styles.allBtnText}>{allSelected ? 'None' : 'All'}</Text>
            </TouchableOpacity>
          ) : <View style={styles.allBtn} />}
        </View>

        {/* Quota impact card */}
        {quotaBytes > 0 && (
          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryCount}>
                {selected.size} of {entries.length} file{entries.length !== 1 ? 's' : ''} selected
              </Text>
              <Text style={[styles.summarySize, isOverQuota && styles.textError]}>
                {fmt(selectedSize)}
              </Text>
            </View>

            {/* Quota impact bar */}
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${usedPct}%` as any, backgroundColor: colors.primary, opacity: 0.3 }]} />
              <View style={[styles.barFill, {
                left: `${usedPct}%` as any,
                width: `${fitsPct}%` as any,
                backgroundColor: isOverQuota ? colors.error : colors.primary,
              }]} />
              {isOverQuota && overflowPct > 0 && (
                <View style={[styles.barFill, {
                  left: `${usedPct + fitsPct}%` as any,
                  width: `${overflowPct}%` as any,
                  backgroundColor: colors.error,
                  opacity: 0.45,
                }]} />
              )}
            </View>

            <View style={styles.barLabels}>
              <Text style={[styles.barLabel, isOverQuota && styles.textError]}>
                {fmt(usedBytes)} before  →  {fmt(projectedUsed)} after
              </Text>
              <Text style={styles.barLabel}>{fmt(quotaBytes)} quota</Text>
            </View>

            {photoCount > 0 && (
              <Text style={styles.photoSizeNote}>
                * Google Photos sizes are not reported by the API and are excluded from the estimate.
              </Text>
            )}
          </View>
        )}

        {/* Over-quota strip */}
        {isOverQuota && (
          <TouchableOpacity style={styles.overQuotaStrip} onPress={() => setUpgradeVisible(true)} activeOpacity={0.85}>
            <Zap size={14} color={colors.surface} strokeWidth={2.5} style={{ marginRight: 6 }} />
            <Text style={styles.overQuotaText}>{fmt(overflowBytes)} over quota</Text>
            <Text style={styles.overQuotaAction}>Get more storage →</Text>
          </TouchableOpacity>
        )}

        {/* Sort bar */}
        {!finished && (
          <View style={styles.sortBar}>
            <Text style={styles.sortLabel}>Sort by</Text>
            {(['type', 'size', 'name'] as SortMode[]).map((s) => (
              <TouchableOpacity
                key={s}
                style={[styles.sortPill, sort === s && styles.sortPillActive]}
                onPress={() => setSort(s)}
              >
                <Text style={[styles.sortPillText, sort === s && styles.sortPillTextActive]}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* File list */}
        {showSections ? (
          <SectionList<ListItem, TypeSection>
            style={styles.list}
            contentContainerStyle={styles.listContent}
            sections={typeSections}
            keyExtractor={(item) => String(item.index)}
            stickySectionHeadersEnabled={false}
            renderSectionHeader={renderSectionHeader}
            renderItem={({ item }) => renderRow(item)}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
          />
        ) : (
          <FlatList<ListItem>
            style={styles.list}
            contentContainerStyle={styles.listContent}
            data={listData}
            keyExtractor={(item) => String(item.index)}
            renderItem={({ item }) => renderRow(item)}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
          />
        )}

        {/* Footer */}
        <View style={styles.footer}>
          {uploading && progress && (
            <View style={styles.progressWrap}>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.round((progress.done / progress.total) * 100)}%` as any }]} />
              </View>
              <Text style={styles.progressLabel}>{progress.done} / {progress.total}</Text>
            </View>
          )}

          {finished && (
            <Text style={[styles.resultText, uploadErrors > 0 ? styles.textWarning : styles.textSuccess]}>
              {uploadErrors === 0
                ? `All ${uploadedCount} file${uploadedCount !== 1 ? 's' : ''} backed up successfully.`
                : `${uploadedCount - uploadErrors} of ${uploadedCount} backed up · ${uploadErrors} failed.`}
            </Text>
          )}

          {finished && (
            <TouchableOpacity
              style={[styles.cleanupBtn, driveCount === 0 && styles.cleanupBtnInfo, cleanupLoading && styles.btnDisabled]}
              onPress={handleCleanup}
              disabled={cleanupLoading}
            >
              {cleanupLoading ? (
                <ActivityIndicator color={driveCount > 0 ? colors.error : colors.textSecondary} size="small" />
              ) : (
                <>
                  {driveCount > 0
                    ? <Trash2 size={15} color={colors.error} strokeWidth={1.5} style={{ marginRight: 6 }} />
                    : <Info  size={15} color={colors.textSecondary} strokeWidth={1.5} style={{ marginRight: 6 }} />}
                  <Text style={[styles.cleanupBtnText, driveCount === 0 && styles.cleanupBtnTextInfo]}>
                    {cleanupLabel}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {finished ? (
            <TouchableOpacity style={styles.backupBtn} onPress={onDone}>
              <Check size={18} color={colors.surface} strokeWidth={2.5} style={{ marginRight: spacing.sm }} />
              <Text style={styles.backupBtnText}>Done</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.backupBtn, !canBackUp && styles.btnDisabled]}
              onPress={handleBackUp}
              disabled={!canBackUp}
            >
              {uploading ? (
                <ActivityIndicator color={colors.surface} size="small" />
              ) : (
                <>
                  <Cloud size={18} color={colors.surface} strokeWidth={1.5} style={{ marginRight: spacing.sm }} />
                  <Text style={styles.backupBtnText}>
                    {isOverQuota
                      ? 'Over quota — deselect files or upgrade'
                      : selected.size === 0
                        ? 'No files selected'
                        : `Back Up ${selected.size} File${selected.size !== 1 ? 's' : ''}`}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>

      </View>

      {/* Per-file destination picker */}
      <Modal visible={destPickerFor !== null} transparent animationType="fade" onRequestClose={() => setDestPickerFor(null)}>
        <Pressable style={styles.overlay} onPress={() => setDestPickerFor(null)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>Choose destination</Text>
            <TouchableOpacity style={styles.sheetRow} onPress={() => setDest(destPickerFor!, null)}>
              <View style={styles.sheetIconWrap}>
                <Folder size={18} color={colors.textSecondary} strokeWidth={1.5} />
              </View>
              <Text style={styles.sheetRowText}>/  (root)</Text>
              {activeDest == null && <Check size={18} color={colors.primary} strokeWidth={2.5} />}
            </TouchableOpacity>
            {foldersLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: spacing.md }} />
            ) : (
              folders.map((folder) => (
                <TouchableOpacity key={folder.id} style={styles.sheetRow} onPress={() => setDest(destPickerFor!, folder.id)}>
                  <View style={[styles.sheetIconWrap, folder.kind === 'media' && styles.sheetMediaIconWrap]}>
                    {folder.kind === 'media'
                      ? <GalleryHorizontalEnd size={18} color={colors.mediaAccent} strokeWidth={1.5} />
                      : <Folder size={18} color={colors.textSecondary} strokeWidth={1.5} />}
                  </View>
                  <Text style={styles.sheetRowText} numberOfLines={1}>{folder.name}</Text>
                  {activeDest === folder.id && <Check size={18} color={colors.primary} strokeWidth={2.5} />}
                </TouchableOpacity>
              ))
            )}
            {!foldersLoading && folders.length === 0 && (
              <Text style={styles.sheetEmptyText}>No folders yet. Files will be saved to root.</Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </Modal>

    <StorageUpgradeModal
      visible={upgradeVisible}
      quotaBytes={quotaBytes}
      usedBytes={usedBytes}
      onPurchased={(newQuota) => {
        setUpgradeVisible(false);
        onStoragePurchased?.(newQuota);
      }}
      onClose={() => setUpgradeVisible(false)}
    />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  closeBtn: { width: 36, alignItems: 'flex-start' },
  headerTitle: { fontSize: 17, fontWeight: '600', color: colors.textPrimary },
  allBtn: { width: 36, alignItems: 'flex-end' },
  allBtnText: { fontSize: 14, fontWeight: '600', color: colors.primary },

  summaryCard: {
    backgroundColor: colors.surface,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    borderRadius: radius.lg,
    padding: spacing.md,
    ...shadow.sm,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  summaryCount: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  summarySize:  { fontSize: 15, color: colors.textSecondary },

  barTrack: {
    height: 8,
    backgroundColor: colors.border,
    borderRadius: 4,
    overflow: 'hidden',
    position: 'relative',
    marginBottom: spacing.xs,
  },
  barFill: { position: 'absolute', top: 0, bottom: 0 },
  barLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  barLabel: { fontSize: 11, color: colors.textMuted },
  photoSizeNote: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: spacing.xs,
    fontStyle: 'italic',
  },

  overQuotaStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.error,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 10,
  },
  overQuotaText:   { flex: 1, fontSize: 13, color: colors.surface, fontWeight: '500' },
  overQuotaAction: { fontSize: 13, fontWeight: '700', color: colors.surface },

  sortBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  sortLabel:         { fontSize: 13, color: colors.textMuted, marginRight: spacing.xs },
  sortPill:          { paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.xl, backgroundColor: colors.divider },
  sortPillActive:    { backgroundColor: colors.primary },
  sortPillText:      { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  sortPillTextActive:{ color: colors.surface },

  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  sectionTitle:  { fontSize: 13, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionToggle: { fontSize: 12, color: colors.primary, fontWeight: '500' },

  list: { flex: 1 },
  listContent: { paddingBottom: 240 },
  separator: { height: 1, backgroundColor: colors.divider, marginLeft: spacing.md + 22 + 8 + 34 + 8 },

  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: colors.surface,
  },
  checkbox: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.sm,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  fileIconWrap: {
    width: 34, height: 34, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.sm,
  },
  fileIconDrive:  { backgroundColor: colors.primaryLighter },
  fileIconPhotos: { backgroundColor: '#fef2f2' },

  fileInfo: { flex: 1, marginRight: spacing.sm },
  fileMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 3 },
  fileName:   { fontSize: 14, fontWeight: '500', color: colors.textPrimary },
  fileSize:   { fontSize: 12, color: colors.textSecondary },
  sourceBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radius.sm,
  },
  badgeDrive:  { backgroundColor: colors.primaryLighter },
  badgePhotos: { backgroundColor: '#fef2f2' },
  sourceBadgeText: { fontSize: 10, fontWeight: '600', color: colors.textSecondary },

  destBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.primaryLighter,
    maxWidth: 110,
  },
  destBtnDisabled: { opacity: 0.35 },
  destBtnText: { fontSize: 12, color: colors.primary, fontWeight: '500', flexShrink: 1 },

  footer: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    padding: spacing.md,
    paddingBottom: spacing.lg,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  progressWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  progressTrack: {
    flex: 1, height: 6, backgroundColor: colors.border,
    borderRadius: radius.xl, overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.success, borderRadius: radius.xl },
  progressLabel: { fontSize: 12, color: colors.textSecondary, minWidth: 40, textAlign: 'right' },
  resultText: { fontSize: 13, textAlign: 'center' },

  cleanupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.error,
    borderRadius: radius.md,
    paddingVertical: 11,
  },
  cleanupBtnInfo:     { borderColor: colors.border },
  cleanupBtnText:     { fontSize: 14, color: colors.error, fontWeight: '500' },
  cleanupBtnTextInfo: { color: colors.textSecondary },

  backupBtn: {
    flexDirection: 'row',
    backgroundColor: colors.success,
    borderRadius: radius.md,
    padding: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled:   { opacity: 0.5 },
  backupBtnText: { color: colors.surface, fontWeight: '600', fontSize: 16 },

  textDimmed:  { color: colors.textMuted },
  textError:   { color: colors.error, fontWeight: '600' },
  textSuccess: { color: colors.success },
  textWarning: { color: colors.warning },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl + spacing.md,
  },
  sheetTitle: {
    fontSize: 14, fontWeight: '600', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: spacing.sm,
  },
  sheetRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.divider,
  },
  sheetIconWrap: {
    width: 32, height: 32, borderRadius: radius.sm,
    backgroundColor: colors.divider, alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.sm,
  },
  sheetMediaIconWrap: { backgroundColor: colors.mediaAccentLighter },
  sheetRowText:  { flex: 1, fontSize: 15, color: colors.textPrimary },
  sheetEmptyText: {
    fontSize: 13, color: colors.textMuted, lineHeight: 19,
    paddingVertical: spacing.md, textAlign: 'center',
  },
});
