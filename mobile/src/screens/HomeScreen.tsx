import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CameraRoll } from '@react-native-camera-roll/camera-roll';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  CloudUpload,
  FileText,
  FolderUp,
  GalleryHorizontalEnd,
  Image,
  Music,
  Star,
  Trash2,
  Video,
} from 'lucide-react-native';
import DocumentPicker from 'react-native-document-picker';
import { registerDevice } from '../api/sync';
import {
  getPreferences,
  listFavorites,
  listRoot,
  unfavoriteFile,
  updatePreferences,
  uploadFile,
  type ApiFolder,
} from '../api/files';
import { registerBackgroundSync } from '../tasks/backgroundSync';
import { useSync } from '../context/SyncContext';
import { useAuth } from '../context/AuthContext';
import { getAllDoneItems } from '../services/UploadQueue';
import { colors, radius, shadow, spacing } from '../theme';

const DEVICE_ID_KEY = 'apollo_device_id';
const FILES_DEST_KEY = 'apollo_files_dest_folder_id';

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

interface FavoriteFile {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
}

function formatSyncDate(d: Date): string {
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Today ${time}`;
  if (isYesterday) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function fileMimeIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.startsWith('audio/')) return Music;
  return FileText;
}

export default function HomeScreen() {
  const { profile } = useAuth();
  const { pendingCount, syncedCount, inProgressFiles, lastSyncedAt, isSyncing, lastError, triggerSync } = useSync();
  const [favorites, setFavorites] = useState<FavoriteFile[]>([]);
  const [favLoading, setFavLoading] = useState(true);
  const [statusExpanded, setStatusExpanded] = useState(false);

  const [autouploadFolderID, setAutouploadFolderID] = useState<string | null>(null);
  const [filesDestFolderID, setFilesDestFolderID] = useState<string | null>(null);
  const [mediaFolders, setMediaFolders] = useState<ApiFolder[]>([]);
  // 'camera' = camera roll picker, 'files' = files app picker, null = closed
  const [pickerMode, setPickerMode] = useState<'camera' | 'files' | null>(null);
  const [pickerSaving, setPickerSaving] = useState(false);

  const [filesUploading, setFilesUploading] = useState(false);
  const [filesUploadProgress, setFilesUploadProgress] = useState<{ done: number; total: number } | null>(null);

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

  // Load preferences + media folder list + files destination on mount
  useEffect(() => {
    (async () => {
      try {
        const [prefs, root, savedFilesDest] = await Promise.all([
          getPreferences(),
          listRoot(),
          AsyncStorage.getItem(FILES_DEST_KEY),
        ]);
        setAutouploadFolderID(prefs.media_autoupload_folder_id);
        setMediaFolders((root.subfolders?.items ?? []).filter((f) => f.kind === 'media'));
        setFilesDestFolderID(savedFilesDest);
      } catch {
        // best-effort
      }
    })();
  }, []);

  const loadFavorites = useCallback(async () => {
    setFavLoading(true);
    try {
      const data = await listFavorites();
      setFavorites(data.files ?? []);
    } catch {
      setFavorites([]);
    } finally {
      setFavLoading(false);
    }
  }, []);

  useEffect(() => { loadFavorites(); }, [loadFavorites]);

  const handleUnfavorite = async (fileID: string) => {
    try {
      await unfavoriteFile(fileID);
      setFavorites((prev) => prev.filter((f) => f.id !== fileID));
    } catch {}
  };

  const handleSelectDestination = async (folderID: string | null) => {
    setPickerSaving(true);
    try {
      if (pickerMode === 'camera') {
        await updatePreferences({ media_autoupload_folder_id: folderID });
        setAutouploadFolderID(folderID);
      } else {
        await AsyncStorage.setItem(FILES_DEST_KEY, folderID ?? '');
        setFilesDestFolderID(folderID);
      }
      setPickerMode(null);
    } catch {
      // keep picker open on failure
    } finally {
      setPickerSaving(false);
    }
  };

  const handleCleanupSynced = async () => {
    try {
      const items = await getAllDoneItems();
      const uris = items.map((i) => i.local_uri).filter((u) => u.startsWith('ph://'));
      if (uris.length === 0) {
        Alert.alert('Nothing to clean up', 'No synced photos found on this device.');
        return;
      }
      Alert.alert(
        'Clean Up Device',
        `Remove ${uris.length} backed-up photo${uris.length !== 1 ? 's' : ''} from this device? They are safely stored in Apollo SFS.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: `Delete ${uris.length} Photo${uris.length !== 1 ? 's' : ''}`,
            style: 'destructive',
            onPress: async () => {
              try {
                await CameraRoll.deletePhotos(uris);
              } catch (e: any) {
                Alert.alert('Error', e.message);
              }
            },
          },
        ],
      );
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  };

  const handleFilesAppSync = async () => {
    const destIsMediaCollection = filesDestFolderID !== null;
    try {
      const results = await DocumentPicker.pick({
        allowMultiSelection: true,
        presentationStyle: 'pageSheet',
        copyTo: 'cachesDirectory',
        ...(destIsMediaCollection && { type: ['image/*'] }),
      });

      if (results.length === 0) return;
      setFilesUploading(true);
      setFilesUploadProgress({ done: 0, total: results.length });

      let done = 0;
      for (const file of results) {
        try {
          await uploadFile(
            file.fileCopyUri ?? file.uri,
            file.name ?? 'upload',
            file.type ?? 'application/octet-stream',
            filesDestFolderID ?? undefined,
          );
        } catch {
          // continue with remaining files
        }
        done += 1;
        setFilesUploadProgress({ done, total: results.length });
      }
    } catch (e: any) {
      if (!DocumentPicker.isCancel(e)) {
        Alert.alert('Upload failed', e.message);
      }
    } finally {
      setFilesUploading(false);
      setFilesUploadProgress(null);
    }
  };

  const destinationLabel =
    autouploadFolderID == null
      ? '/'
      : (mediaFolders.find((f) => f.id === autouploadFolderID)?.name ?? '/');

  const filesDestLabel =
    !filesDestFolderID
      ? '/'
      : (mediaFolders.find((f) => f.id === filesDestFolderID)?.name ?? '/');

  const usedBytes = profile?.storage_used_bytes ?? 0;
  const quotaBytes = profile?.storage_quota_bytes ?? 0;
  const usedPct = quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : 0;
  const barColor = usedPct > 90 ? colors.error : usedPct > 70 ? colors.warning : colors.primary;

  return (
    <View style={styles.container}>
      {/* Sync status bar */}
      {isSyncing && (
        <View>
          <TouchableOpacity
            style={styles.statusBar}
            onPress={() => setStatusExpanded((v) => !v)}
            activeOpacity={0.85}
          >
            <View style={styles.statusBarLeft}>
              <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 8 }} />
              <Text style={styles.statusBarText}>
                {inProgressFiles.length > 0
                  ? `Uploading ${inProgressFiles.length} file${inProgressFiles.length !== 1 ? 's' : ''}…`
                  : 'Scanning camera roll…'}
              </Text>
            </View>
            <ChevronDown
              size={14}
              color={colors.textSecondary}
              style={statusExpanded ? { transform: [{ rotate: '180deg' }] } : undefined}
            />
          </TouchableOpacity>
          {statusExpanded && inProgressFiles.length > 0 && (
            <View style={styles.statusDropdown}>
              {inProgressFiles.map((name) => (
                <Text key={name} style={styles.statusDropdownItem} numberOfLines={1}>· {name}</Text>
              ))}
            </View>
          )}
        </View>
      )}

      <ScrollView contentContainerStyle={styles.content}>
      {/* Storage card */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Storage</Text>
        <View style={styles.storageRow}>
          <Text style={styles.storageValue}>{formatBytes(usedBytes)}</Text>
          <Text style={styles.storageQuota}> / {formatBytes(quotaBytes)}</Text>
        </View>
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${Math.min(usedPct, 100)}%` as any, backgroundColor: barColor }]} />
        </View>
        <Text style={styles.barLabel}>{usedPct.toFixed(1)}% used</Text>
      </View>

      {/* Camera Roll Backup card */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Camera Roll Backup</Text>

        <TouchableOpacity style={styles.destinationRow} onPress={() => setPickerMode('camera')} activeOpacity={0.7}>
          <Text style={styles.destinationLabel}>Destination</Text>
          <View style={styles.destinationRight}>
            <Text style={styles.destinationValue}>{destinationLabel}</Text>
            <ChevronDown size={14} color={colors.primary} style={styles.destinationChevron} />
          </View>
        </TouchableOpacity>

        {(syncedCount > 0 || lastSyncedAt) && (
          <View style={styles.syncSummaryRow}>
            <View style={styles.syncSummaryLeft}>
              <CheckCircle2 size={13} color={colors.success} style={{ marginRight: 5 }} />
              <Text style={styles.syncSummaryCount}>
                {syncedCount.toLocaleString()} photo{syncedCount !== 1 ? 's' : ''} synced
              </Text>
            </View>
            {lastSyncedAt && (
              <Text style={styles.syncSummaryDate}>
                {formatSyncDate(lastSyncedAt)}
              </Text>
            )}
          </View>
        )}

        {pendingCount > 0 && (
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: colors.warning }]} />
            <Text style={styles.statusText}>{pendingCount} photo{pendingCount !== 1 ? 's' : ''} waiting to upload</Text>
          </View>
        )}

        {lastError && (
          <View style={styles.errorBox}>
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

        {syncedCount > 0 && (
          <TouchableOpacity style={styles.cleanupButton} onPress={handleCleanupSynced}>
            <Trash2 size={15} color={colors.error} strokeWidth={1.5} style={{ marginRight: 6 }} />
            <Text style={styles.cleanupButtonText}>
              Free up device space ({syncedCount.toLocaleString()} synced)
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Files App card */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>On Device Files</Text>

        <TouchableOpacity style={styles.destinationRow} onPress={() => setPickerMode('files')} activeOpacity={0.7}>
          <Text style={styles.destinationLabel}>Destination</Text>
          <View style={styles.destinationRight}>
            <Text style={styles.destinationValue}>{filesDestLabel}</Text>
            <ChevronDown size={14} color={colors.primary} style={styles.destinationChevron} />
          </View>
        </TouchableOpacity>

        {filesUploadProgress && (
          <View style={styles.progressRow}>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round((filesUploadProgress.done / filesUploadProgress.total) * 100)}%` as any },
                ]}
              />
            </View>
            <Text style={styles.progressLabel}>
              {filesUploadProgress.done} / {filesUploadProgress.total}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.syncButton, styles.filesButton, filesUploading && styles.syncButtonDisabled]}
          onPress={handleFilesAppSync}
          disabled={filesUploading}
        >
          {filesUploading ? (
            <ActivityIndicator color={colors.surface} size="small" />
          ) : (
            <>
              <FolderUp size={18} color={colors.surface} strokeWidth={2} style={styles.syncIcon} />
              <Text style={styles.syncButtonText}>Pick Files to Upload</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Favorites card */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardLabel}>Favorites</Text>
          {favLoading && <ActivityIndicator size="small" color={colors.primary} />}
        </View>

        {!favLoading && favorites.length === 0 && (
          <View style={styles.emptyState}>
            <Star size={32} color={colors.textMuted} strokeWidth={1} />
            <Text style={styles.emptyText}>No favorites yet</Text>
          </View>
        )}

        {favorites.map((item, index) => {
          const FileIcon = fileMimeIcon(item.mime_type);
          return (
            <View key={item.id}>
              {index > 0 && <View style={styles.separator} />}
              <View style={styles.favRow}>
                <View style={styles.iconWrap}>
                  <FileIcon size={18} color={colors.primary} strokeWidth={1.5} />
                </View>
                <View style={styles.favInfo}>
                  <Text style={styles.favName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.favMeta}>{item.mime_type.split('/')[1]?.toUpperCase()}</Text>
                </View>
                <TouchableOpacity onPress={() => handleUnfavorite(item.id)} style={styles.favAction}>
                  <Star size={18} color={colors.warning} fill={colors.warning} strokeWidth={0} />
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
      </View>

      {/* Destination picker modal — shared by camera roll and files app */}
      <Modal
        visible={pickerMode !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerMode(null)}
      >
        <Pressable style={styles.overlay} onPress={() => !pickerSaving && setPickerMode(null)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>
              {pickerMode === 'camera' ? 'Camera Roll Destination' : 'Files Upload Destination'}
            </Text>

            {(() => {
              const selectedID = pickerMode === 'camera' ? autouploadFolderID : filesDestFolderID;
              return (
                <>
                  <TouchableOpacity
                    style={styles.sheetRow}
                    onPress={() => handleSelectDestination(null)}
                    disabled={pickerSaving}
                  >
                    <View style={styles.sheetIconWrap}>
                      <GalleryHorizontalEnd size={18} color={colors.textSecondary} strokeWidth={1.5} />
                    </View>
                    <Text style={styles.sheetRowText}>/  (root)</Text>
                    {!selectedID && <Check size={18} color={colors.primary} strokeWidth={2.5} />}
                  </TouchableOpacity>

                  {mediaFolders.map((folder) => (
                    <TouchableOpacity
                      key={folder.id}
                      style={styles.sheetRow}
                      onPress={() => handleSelectDestination(folder.id)}
                      disabled={pickerSaving}
                    >
                      <View style={[styles.sheetIconWrap, styles.sheetMediaIconWrap]}>
                        <GalleryHorizontalEnd size={18} color={colors.mediaAccent} strokeWidth={1.5} />
                      </View>
                      <Text style={styles.sheetRowText} numberOfLines={1}>{folder.name}</Text>
                      {selectedID === folder.id && <Check size={18} color={colors.primary} strokeWidth={2.5} />}
                    </TouchableOpacity>
                  ))}

                  {mediaFolders.length === 0 && (
                    <Text style={styles.sheetEmptyText}>
                      No media collections yet. Create one in Files to organize your uploads.
                    </Text>
                  )}
                </>
              );
            })()}

            {pickerSaving && (
              <ActivityIndicator style={styles.sheetSpinner} color={colors.primary} />
            )}
          </Pressable>
        </Pressable>
      </Modal>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },

  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  statusBarLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  statusBarText: { fontSize: 13, color: colors.textSecondary },
  statusDropdown: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  statusDropdownItem: { fontSize: 12, color: colors.textMuted, paddingVertical: 2 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadow.md,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  cardLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
  },

  destinationRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  destinationLabel: { fontSize: 13, color: colors.textSecondary },
  destinationRight: { flexDirection: 'row', alignItems: 'center' },
  destinationValue: { fontSize: 13, fontWeight: '600', color: colors.primary },
  destinationChevron: { marginLeft: 4 },

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

  syncSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  syncSummaryLeft: { flexDirection: 'row', alignItems: 'center' },
  syncSummaryCount: { fontSize: 13, color: colors.success, fontWeight: '500' },
  syncSummaryDate: { fontSize: 12, color: colors.textMuted },

  statusRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs },
  statusDot: { width: 7, height: 7, borderRadius: 4, marginRight: spacing.sm },
  statusIcon: { marginRight: spacing.sm },
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
  filesButton: { backgroundColor: colors.mediaAccent },
  syncButtonDisabled: { opacity: 0.6 },
  cleanupButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingVertical: 9,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.error,
  },
  cleanupButtonText: { fontSize: 13, color: colors.error, fontWeight: '500' },
  syncIcon: { marginRight: spacing.sm },
  syncButtonText: { color: colors.surface, fontWeight: '600', fontSize: 15 },


  progressRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm, gap: spacing.sm },
  progressTrack: {
    flex: 1,
    height: 6,
    backgroundColor: colors.border,
    borderRadius: radius.xl,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: colors.mediaAccent, borderRadius: radius.xl },
  progressLabel: { fontSize: 12, color: colors.textSecondary, minWidth: 36, textAlign: 'right' },

  emptyState: { alignItems: 'center', paddingVertical: spacing.lg },
  emptyText: { marginTop: spacing.sm, fontSize: 14, color: colors.textMuted },

  separator: { height: 1, backgroundColor: colors.divider, marginLeft: 48 },
  favRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.primaryLighter,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  favInfo: { flex: 1 },
  favName: { fontSize: 14, fontWeight: '500', color: colors.textPrimary },
  favMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  favAction: { padding: spacing.xs },

  // Modal / sheet
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl + spacing.md,
  },
  sheetTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  sheetIconWrap: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: colors.divider,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  sheetMediaIconWrap: { backgroundColor: colors.mediaAccentLighter },
  sheetRowText: { flex: 1, fontSize: 15, color: colors.textPrimary },
  sheetEmptyText: {
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 19,
    paddingVertical: spacing.md,
    textAlign: 'center',
  },
  sheetSpinner: { marginTop: spacing.sm },
});
