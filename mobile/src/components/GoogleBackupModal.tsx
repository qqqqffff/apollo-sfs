import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image as RNImage,
  Modal,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  FileText,
  Folder,
  GalleryHorizontalEnd,
  Image,
  Info,
  Music,
  Settings,
  Trash2,
  Video,
  X,
  Zap,
} from 'lucide-react-native';
import { listRoot, type ApiFolder } from '../api/files';
import {
  deleteGoogleDriveFile,
  googlePreviewSource,
  uploadGoogleEntries,
  type BackupEntry,
  type BackupItemStatus,
  type BackupResult,
  type GoogleBackupItem,
} from '../services/GoogleBackupService';
import { loadBackupSettings, setBackupSetting } from '../services/backupSettings';
import { requestNotificationPermission } from '../services/notifications';
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
type DestTarget = { kind: 'file'; index: number } | { kind: 'category'; category: Category };

interface ListItem    { entry: FileEntry; index: number }
interface TypeSection { title: Category; data: ListItem[]; allItems: ListItem[] }

interface Props {
  visible: boolean;
  items: GoogleBackupItem[];
  accessToken: string;
  quotaBytes: number;
  usedBytes: number;
  redirectFolderName: string | null;
  onClose: () => void;
  onDone: () => void;
  onStartBackground: (entries: BackupEntry[], accessToken: string, notify: boolean) => void;
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

// Images/videos are force-routed to the media auto-upload folder by the backend,
// so the per-file destination control is locked for them when a redirect is set.
function isMediaEntry(entry: FileEntry): boolean {
  return entry.type.startsWith('image/') || entry.type.startsWith('video/');
}

function fmt(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3)   return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function GoogleBackupModal({
  visible, items, accessToken, quotaBytes, usedBytes, redirectFolderName,
  onClose, onDone, onStartBackground, onStoragePurchased,
}: Props) {
  const [entries, setEntries]         = useState<FileEntry[]>([]);
  const [selected, setSelected]       = useState<Set<number>>(new Set());
  const [sort, setSort]               = useState<SortMode>('type');
  const [tab, setTab]                 = useState<'files' | 'settings'>('files');
  const [collapsed, setCollapsed]     = useState<Set<Category>>(new Set());
  const [folders, setFolders]         = useState<ApiFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [destTarget, setDestTarget]   = useState<DestTarget | null>(null);
  const [previewEntry, setPreviewEntry]     = useState<FileEntry | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploading, setUploading]     = useState(false);
  const [progress, setProgress]       = useState<{ done: number; total: number } | null>(null);
  const [result, setResult]           = useState<BackupResult | null>(null);
  const [statusMap, setStatusMap]     = useState<Record<number, BackupItemStatus>>({});
  const [finished, setFinished]       = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [upgradeVisible, setUpgradeVisible] = useState(false);
  const [bgEnabled, setBgEnabled]     = useState(true);
  const [notifyEnabled, setNotifyEnabled]   = useState(true);

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
    setTab('files');
    setCollapsed(new Set());
    setDestTarget(null);
    setPreviewEntry(null);
    setUploading(false);
    setProgress(null);
    setResult(null);
    setStatusMap({});
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
    loadBackupSettings().then((s) => { setBgEnabled(s.background); setNotifyEnabled(s.notify); });
  }, [visible]);

  // ── Settings ────────────────────────────────────────────────────────────────

  const toggleBackground = (v: boolean) => { setBgEnabled(v); setBackupSetting('background', v); };
  const toggleNotify = (v: boolean) => {
    setNotifyEnabled(v);
    setBackupSetting('notify', v);
    if (v) requestNotificationPermission();
  };

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

  const toggleCollapse = (cat: Category) =>
    setCollapsed((prev) => { const s = new Set(prev); s.has(cat) ? s.delete(cat) : s.add(cat); return s; });

  const allSelected = selected.size === entries.length;

  // ── Destinations ──────────────────────────────────────────────────────────

  const applyDest = (folderId: string | null) => {
    if (!destTarget) return;
    if (destTarget.kind === 'file') {
      const idx = destTarget.index;
      setEntries((prev) => prev.map((e, j) => (j === idx ? { ...e, destFolderId: folderId } : e)));
    } else {
      const cat = destTarget.category;
      setEntries((prev) => prev.map((e) => (getCategory(e) === cat ? { ...e, destFolderId: folderId } : e)));
    }
    setDestTarget(null);
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
      .map((c) => {
        const allItems = map.get(c)!;
        return { title: c, allItems, data: collapsed.has(c) ? [] : allItems };
      });
  }, [entries, collapsed]);

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

    // Background mode: hand off to the parent and close, progress shows in the card.
    if (bgEnabled) {
      onStartBackground(toUpload, accessToken, notifyEnabled);
      return;
    }

    // Foreground mode: upload in place, marking each row, then show the finished screen.
    setUploading(true);
    setStatusMap({});
    setProgress({ done: 0, total: toUpload.length });
    const res = await uploadGoogleEntries(
      toUpload, accessToken, (done, total, done2) => {
        setProgress({ done, total });
        if (done2) {
          const idx = entries.indexOf(done2.entry as FileEntry);
          if (idx >= 0) setStatusMap((m) => ({ ...m, [idx]: done2.status }));
        }
      },
    );
    setResult(res);
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
    const checked    = selected.has(index);
    const Icon       = fileIcon(entry);
    const isDrive    = entry.source === 'drive';
    const locked     = redirectFolderName !== null && isMediaEntry(entry);
    const previewable = !finished && googlePreviewSource(entry.googleItem, accessToken) !== null;
    const status     = statusMap[index];

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
        {previewable ? (
          <TouchableOpacity
            style={[styles.fileIconWrap, isDrive ? styles.fileIconDrive : styles.fileIconPhotos]}
            onPress={() => setPreviewEntry(entry)}
            hitSlop={6}
          >
            <Icon size={18} color={isDrive ? colors.primary : colors.error} strokeWidth={1.5} />
          </TouchableOpacity>
        ) : (
          <View style={[styles.fileIconWrap, isDrive ? styles.fileIconDrive : styles.fileIconPhotos]}>
            <Icon size={18} color={isDrive ? colors.primary : colors.error} strokeWidth={1.5} />
          </View>
        )}
        <View style={styles.fileInfo}>
          <Text style={[styles.fileName, !checked && styles.textDimmed]} numberOfLines={1}>{entry.name}</Text>
          <View style={styles.fileMeta}>
            <View style={[styles.sourceBadge, isDrive ? styles.badgeDrive : styles.badgePhotos]}>
              <Text style={styles.sourceBadgeText}>{isDrive ? 'Drive' : 'Photos'}</Text>
            </View>
            <Text style={styles.fileSize}>{entry.size > 0 ? fmt(entry.size) : '—'}</Text>
          </View>
        </View>
        {status ? (
          <View style={[
            styles.statusBadge,
            status === 'duplicate' ? styles.statusBadgeDuplicate
              : status === 'error' ? styles.statusBadgeError
              : styles.statusBadgeDone,
          ]}>
            <Text style={[
              styles.statusBadgeText,
              status === 'duplicate' ? styles.statusBadgeTextDuplicate
                : status === 'error' ? styles.statusBadgeTextError
                : styles.statusBadgeTextDone,
            ]}>
              {status === 'duplicate' ? 'Duplicate' : status === 'error' ? 'Failed' : 'Backed up'}
            </Text>
          </View>
        ) : locked ? (
          <View style={[styles.destBtn, styles.destBtnLocked]}>
            <GalleryHorizontalEnd size={11} color={colors.mediaAccent} strokeWidth={1.5} />
            <Text style={[styles.destBtnText, styles.destBtnTextLocked]} numberOfLines={1}>{redirectFolderName}</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.destBtn, (!checked || uploading || finished) && styles.destBtnDisabled]}
            onPress={() => checked && !uploading && !finished && setDestTarget({ kind: 'file', index })}
            hitSlop={4}
          >
            <Text style={styles.destBtnText} numberOfLines={1}>{folderLabel(entry.destFolderId)}</Text>
            <ChevronDown size={12} color={colors.primary} />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    );
  };

  // ── Section header renderer ───────────────────────────────────────────────

  const renderSectionHeader = ({ section }: { section: TypeSection }) => {
    const items      = section.allItems;
    const indices    = items.map((d) => d.index);
    const selCount   = indices.filter((i) => selected.has(i)).length;
    const allGroupOn = items.length > 0 && selCount === items.length;
    const isCollapsed = collapsed.has(section.title);
    const catRedirected = redirectFolderName !== null && items.every((d) => isMediaEntry(d.entry));

    return (
      <View style={styles.sectionHeader}>
        <TouchableOpacity style={styles.sectionHeaderLeft} onPress={() => toggleCollapse(section.title)} hitSlop={6}>
          {isCollapsed
            ? <ChevronRight size={15} color={colors.textSecondary} strokeWidth={2} />
            : <ChevronDown  size={15} color={colors.textSecondary} strokeWidth={2} />}
          <Text style={styles.sectionTitle}>{section.title}</Text>
        </TouchableOpacity>
        <View style={styles.sectionHeaderRight}>
          {!finished && (
            <TouchableOpacity
              style={[styles.sectionDestBtn, catRedirected && styles.sectionDestBtnDisabled]}
              onPress={() => !catRedirected && setDestTarget({ kind: 'category', category: section.title })}
              disabled={catRedirected}
              hitSlop={6}
            >
              <Folder size={12} color={colors.primary} strokeWidth={1.5} />
              <Text style={styles.sectionDestBtnText}>Folder</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => !finished && toggleGroup(indices)} hitSlop={6}>
            <Text style={styles.sectionToggle}>
              {selCount}/{items.length}{'  '}
              {!finished && (allGroupOn ? 'Deselect all' : 'Select all')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ── Derived UI state ──────────────────────────────────────────────────────

  const canBackUp    = selected.size > 0 && !isOverQuota && !uploading;
  const showSections = sort === 'type' && !finished;
  const listData     = finished
    ? entries.map((entry, index) => ({ entry, index }))
    : flatData;

  const driveCount   = entries.filter((e) => e.source === 'drive').length;
  const photoCount   = entries.filter((e) => e.source === 'photos').length;

  const cleanupLabel = driveCount > 0
    ? `Delete ${driveCount} Drive file${driveCount !== 1 ? 's' : ''} from Google Drive`
    : `${photoCount} photo${photoCount !== 1 ? 's' : ''} — delete manually in Google Photos`;

  const activeDest = (() => {
    if (!destTarget) return undefined;
    if (destTarget.kind === 'file') return entries[destTarget.index]?.destFolderId;
    const catEntries = entries.filter((e) => getCategory(e) === destTarget.category);
    const first = catEntries[0]?.destFolderId ?? null;
    return catEntries.every((e) => (e.destFolderId ?? null) === first) ? first : undefined;
  })();

  const previewSource = previewEntry ? googlePreviewSource(previewEntry.googleItem, accessToken) : null;
  const showTabs = !finished && !uploading;

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

        {/* Tab bar */}
        {showTabs && (
          <View style={styles.tabBar}>
            {(['files', 'settings'] as const).map((t) => (
              <TouchableOpacity
                key={t}
                style={[styles.tabPill, tab === t && styles.tabPillActive]}
                onPress={() => setTab(t)}
              >
                {t === 'settings' && (
                  <Settings size={13} color={tab === t ? colors.primary : colors.textSecondary} strokeWidth={2} style={{ marginRight: 5 }} />
                )}
                <Text style={[styles.tabPillText, tab === t && styles.tabPillTextActive]}>
                  {t === 'files' ? 'Files' : 'Settings'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {tab === 'settings' ? (
          // ── Settings tab ──────────────────────────────────────────────────
          <ScrollView style={styles.list} contentContainerStyle={styles.settingsContent}>
            <View style={styles.settingRow}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Back up in the background</Text>
                <Text style={styles.settingDesc}>
                  Close this window when you start a backup and keep uploading, with progress shown on the Google Backup card.
                </Text>
              </View>
              <Switch value={bgEnabled} onValueChange={toggleBackground} />
            </View>
            <View style={styles.settingRow}>
              <View style={styles.settingInfo}>
                <Text style={styles.settingLabel}>Notify when complete</Text>
                <Text style={styles.settingDesc}>
                  Send a notification when the backup finishes.
                </Text>
              </View>
              <Switch value={notifyEnabled} onValueChange={toggleNotify} />
            </View>
          </ScrollView>
        ) : (
          // ── Files tab ─────────────────────────────────────────────────────
          <>
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

            {/* Photo redirect notice */}
            {redirectFolderName !== null && (
              <View style={styles.redirectStrip}>
                <GalleryHorizontalEnd size={14} color={colors.mediaAccent} strokeWidth={1.5} style={{ marginRight: 6 }} />
                <Text style={styles.redirectText} numberOfLines={2}>
                  Photos &amp; videos will be saved to “{redirectFolderName}” (auto-upload)
                </Text>
              </View>
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
          </>
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

          {finished && result && (
            <Text style={[styles.resultText, result.errors > 0 ? styles.textWarning : styles.textSuccess]}>
              {[
                `${result.uploaded} backed up`,
                result.duplicates > 0 ? `${result.duplicates} duplicate${result.duplicates !== 1 ? 's' : ''}` : null,
                result.errors > 0 ? `${result.errors} failed` : null,
              ].filter(Boolean).join(' · ')}
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

      {/* Destination picker (single file or whole category) */}
      <Modal visible={destTarget !== null} transparent animationType="fade" onRequestClose={() => setDestTarget(null)}>
        <Pressable style={styles.overlay} onPress={() => setDestTarget(null)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>
              {destTarget?.kind === 'category' ? `Destination for all ${destTarget.category}` : 'Choose destination'}
            </Text>
            <TouchableOpacity style={styles.sheetRow} onPress={() => applyDest(null)}>
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
                <TouchableOpacity key={folder.id} style={styles.sheetRow} onPress={() => applyDest(folder.id)}>
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

      {/* Picture preview */}
      <Modal visible={previewEntry !== null} transparent animationType="fade" onRequestClose={() => setPreviewEntry(null)}>
        <View style={styles.previewBackdrop}>
          <TouchableOpacity style={styles.previewClose} onPress={() => setPreviewEntry(null)} hitSlop={12}>
            <X size={26} color="#fff" strokeWidth={2} />
          </TouchableOpacity>
          {previewSource && (
            <RNImage
              source={{ uri: previewSource.uri, headers: previewSource.headers }}
              style={styles.previewImage}
              resizeMode="contain"
              onLoadStart={() => setPreviewLoading(true)}
              onLoadEnd={() => setPreviewLoading(false)}
            />
          )}
          {previewLoading && <ActivityIndicator size="large" color="#fff" style={styles.previewSpinner} />}
          {previewEntry && (
            <Text style={styles.previewName} numberOfLines={1}>{previewEntry.name}</Text>
          )}
        </View>
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

  tabBar: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: spacing.sm,
  },
  tabPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.divider,
  },
  tabPillActive: { backgroundColor: colors.primaryLighter },
  tabPillText: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  tabPillTextActive: { color: colors.primary },

  settingsContent: { padding: spacing.md, paddingBottom: 200 },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadow.sm,
  },
  settingInfo: { flex: 1, marginRight: spacing.md },
  settingLabel: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  settingDesc: { fontSize: 12, color: colors.textSecondary, marginTop: 3, lineHeight: 17 },

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

  redirectStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.mediaAccentLighter,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 10,
  },
  redirectText: { flex: 1, fontSize: 12, color: colors.mediaAccent, fontWeight: '500', lineHeight: 16 },

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
  sectionHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  sectionHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionTitle:  { fontSize: 13, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionToggle: { fontSize: 12, color: colors.primary, fontWeight: '500' },
  sectionDestBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm,
    backgroundColor: colors.primaryLighter,
  },
  sectionDestBtnDisabled: { opacity: 0.4 },
  sectionDestBtnText: { fontSize: 11, color: colors.primary, fontWeight: '600' },

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
  destBtnLocked: { backgroundColor: colors.mediaAccentLighter },
  destBtnText: { fontSize: 12, color: colors.primary, fontWeight: '500', flexShrink: 1 },
  destBtnTextLocked: { color: colors.mediaAccent },

  statusBadge: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radius.sm },
  statusBadgeDuplicate: { backgroundColor: colors.warningBg },
  statusBadgeDone:      { backgroundColor: colors.successBg },
  statusBadgeError:     { backgroundColor: colors.errorBg },
  statusBadgeText:          { fontSize: 11, fontWeight: '600' },
  statusBadgeTextDuplicate: { color: colors.warning },
  statusBadgeTextDone:      { color: colors.success },
  statusBadgeTextError:     { color: colors.error },

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

  previewBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' },
  previewClose: { position: 'absolute', top: 50, right: 20, zIndex: 2 },
  previewImage: { width: '100%', height: '80%' },
  previewSpinner: { position: 'absolute' },
  previewName: { position: 'absolute', bottom: 50, left: 20, right: 20, color: '#fff', fontSize: 14, textAlign: 'center' },
});
