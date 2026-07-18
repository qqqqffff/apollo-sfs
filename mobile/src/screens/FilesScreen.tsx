import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  ChevronRight,
  Download,
  FileText,
  Folder,
  GalleryHorizontalEnd,
  Image,
  Info,
  Music,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
  Upload,
  Video,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react-native';
import DocumentPicker from 'react-native-document-picker';
import {
  createFolder,
  deleteFile,
  downloadAndSaveFile,
  favoriteFile,
  getFolder,
  listRoot,
  uploadFile,
  type ApiFile,
  type ApiFolder,
} from '../api/files';
import { searchWithGroups, type RecognitionGroupSearchHit } from '../api/recognition';
import CollectionSettingsSheet from '../components/CollectionSettingsSheet';
import MediaGallery from '../components/MediaGallery';
import RecognitionGroupsModal from '../components/RecognitionGroupsModal';
import { useAuth } from '../context/AuthContext';
import { colors, radius, shadow, spacing } from '../theme';

interface Crumb { id: string; name: string; }
type ListItem = { type: 'folder'; item: ApiFolder } | { type: 'file'; item: ApiFile };

function fileMimeIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.startsWith('audio/')) return Music;
  return FileText;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 2 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type CreateKind = 'regular' | 'media';

export default function FilesScreen() {
  const { profile } = useAuth();
  const isPremiumUser = !!(profile?.is_premium || profile?.is_admin);
  const [currentFolder, setCurrentFolder] = useState<ApiFolder | null>(null);
  const [subfolders, setSubfolders] = useState<ApiFolder[]>([]);
  const [files, setFiles] = useState<ApiFile[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AI recognition (premium)
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [groupsModal, setGroupsModal] = useState<{ collectionID: string; initialGroupID?: string } | null>(null);

  // Search (file names + labeled recognition groups)
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ files: ApiFile[]; groups: RecognitionGroupSearchHit[] } | null>(null);
  const [searching, setSearching] = useState(false);

  // Create folder modal
  const [galleryCols, setGalleryCols] = useState(3);

  const [createVisible, setCreateVisible] = useState(false);
  const [createKind, setCreateKind] = useState<CreateKind>('regular');
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);

  const currentFolderID = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1].id : null;

  // Depth / kind rules
  const isAtRoot = breadcrumb.length === 0;
  const isInsideMediaCollection = currentFolder?.kind === 'media' && !currentFolder?.parent_id;
  const isInsideSubcollection = currentFolder?.kind === 'media' && !!currentFolder?.parent_id;
  const isMediaFolder = currentFolder?.kind === 'media';
  const canCreateNew = !isInsideSubcollection;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = currentFolderID ? await getFolder(currentFolderID) : await listRoot();
      setCurrentFolder(data.folder ?? null);
      setSubfolders(data.subfolders?.items ?? []);
      setFiles(data.files?.items ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [currentFolderID]);

  useEffect(() => { load(); }, [load]);

  // Debounced search over file names + labeled recognition groups. Cleared
  // whenever the user navigates.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        setSearchResults(await searchWithGroups(q));
      } catch {
        setSearchResults({ files: [], groups: [] });
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const enterFolder = (folder: ApiFolder) => {
    setSearchQuery('');
    setBreadcrumb((prev) => [...prev, { id: folder.id, name: folder.name }]);
  };

  const openSearchedGroup = (hit: RecognitionGroupSearchHit) => {
    setSearchQuery('');
    setBreadcrumb([{ id: hit.collection_id, name: hit.collection_name }]);
    setGroupsModal({ collectionID: hit.collection_id, initialGroupID: hit.id });
  };

  const navigateToCrumb = (index: number) => {
    setBreadcrumb((prev) => prev.slice(0, index));
  };

  const handleFavorite = async (fileID: string) => {
    try { await favoriteFile(fileID); } catch {}
  };

  const handleDownload = async (file: ApiFile) => {
    try {
      await downloadAndSaveFile(file.id, file.name, file.mime_type);
    } catch (e: any) {
      Alert.alert('Download failed', e.message);
    }
  };

  const handleDelete = async (fileID: string) => {
    try {
      await deleteFile(fileID);
      setFiles((prev) => prev.filter((f) => f.id !== fileID));
    } catch {}
  };

  const handleUpload = async () => {
    try {
      const result = await DocumentPicker.pickSingle({
        presentationStyle: 'pageSheet',
        copyTo: 'cachesDirectory',
      });
      if (!result.uri) return;
      setUploading(true);
      await uploadFile(
        result.fileCopyUri ?? result.uri,
        result.name ?? 'upload',
        result.type ?? 'application/octet-stream',
        currentFolderID ?? undefined,
      );
      await load();
    } catch (e: any) {
      if (!DocumentPicker.isCancel(e)) Alert.alert('Upload failed', e.message);
    } finally {
      setUploading(false);
    }
  };

  const openCreateModal = () => {
    // Pre-select the right kind based on context
    if (isInsideMediaCollection) {
      setCreateKind('media'); // subcollection
    } else if (isAtRoot) {
      setCreateKind('regular');
    } else {
      setCreateKind('regular');
    }
    setCreateName('');
    setCreateVisible(true);
  };

  const handleCreate = async () => {
    const name = createName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await createFolder(
        name,
        currentFolderID ?? undefined,
        isInsideMediaCollection ? 'media' : createKind,
      );
      setCreateVisible(false);
      setCreateName('');
      await load();
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Could not create folder');
    } finally {
      setCreating(false);
    }
  };

  // Labels for the create modal
  const createTitle = isInsideMediaCollection
    ? 'New Subcollection'
    : isAtRoot
    ? 'New…'
    : 'New Folder';

  const listData: ListItem[] = [
    ...subfolders.map((f) => ({ type: 'folder' as const, item: f })),
    ...files.map((f) => ({ type: 'file' as const, item: f })),
  ];

  return (
    <View style={styles.container}>
      {/* Breadcrumb + create button */}
      <View style={styles.breadcrumbWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.breadcrumbBar}
          contentContainerStyle={styles.breadcrumbContent}
        >
          <TouchableOpacity onPress={() => setBreadcrumb([])}>
            <Text style={[styles.crumbText, breadcrumb.length === 0 && styles.crumbActive]}>
              Files
            </Text>
          </TouchableOpacity>
          {breadcrumb.map((crumb, i) => (
            <React.Fragment key={crumb.id}>
              <ChevronRight size={14} color={colors.textMuted} style={styles.crumbSep} />
              <TouchableOpacity onPress={() => navigateToCrumb(i + 1)}>
                <Text style={[styles.crumbText, i === breadcrumb.length - 1 && styles.crumbActive]}>
                  {crumb.name}
                </Text>
              </TouchableOpacity>
            </React.Fragment>
          ))}
        </ScrollView>
        {isMediaFolder && currentFolder?.ai_recognition_enabled && (
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => setGroupsModal({ collectionID: currentFolder.id })}
            testID="recognition-groups-btn"
          >
            <Sparkles size={18} color={colors.warning} strokeWidth={2} />
          </TouchableOpacity>
        )}
        {isMediaFolder && (
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => setSettingsVisible(true)}
            testID="collection-info-btn"
          >
            <Info size={18} color={colors.primary} strokeWidth={2} />
          </TouchableOpacity>
        )}
        {isMediaFolder && (
          <TouchableOpacity
            style={styles.addBtn}
            onPress={() => setGalleryCols((c) => (c >= 5 ? 1 : c + 1))}
          >
            {galleryCols >= 5
              ? <ZoomIn size={18} color={colors.primary} strokeWidth={2} />
              : <ZoomOut size={18} color={colors.primary} strokeWidth={2} />
            }
          </TouchableOpacity>
        )}
        {canCreateNew && (
          <TouchableOpacity style={styles.addBtn} onPress={openCreateModal}>
            <Plus size={18} color={colors.primary} strokeWidth={2.5} />
          </TouchableOpacity>
        )}
      </View>

      {/* Search bar (hidden inside media galleries, which have their own UI) */}
      {!isMediaFolder && (
        <View style={styles.searchRow}>
          <Search size={16} color={colors.textMuted} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search files and labeled groups"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
            autoCorrect={false}
            testID="files-search-input"
          />
          {searchQuery !== '' && (
            <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <X size={16} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {searchQuery.trim() !== '' && !isMediaFolder ? (
        // ── Search results ────────────────────────────────────────────────
        <ScrollView contentContainerStyle={styles.list}>
          {searching && <ActivityIndicator style={{ marginTop: spacing.md }} color={colors.primary} />}
          {!searching && searchResults && searchResults.groups.length > 0 && (
            <>
              <Text style={styles.searchSection}>People &amp; groups</Text>
              <View style={styles.groupChipWrap}>
                {searchResults.groups.map((g) => (
                  <TouchableOpacity key={g.id} style={styles.groupChip} onPress={() => openSearchedGroup(g)}>
                    <Sparkles size={13} color={colors.warning} />
                    <Text style={styles.groupChipLabel}>{g.label}</Text>
                    <Text style={styles.groupChipMeta}>{g.file_count} · {g.collection_name}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}
          {!searching && searchResults && searchResults.files.length > 0 && (
            <>
              <Text style={styles.searchSection}>Files</Text>
              {searchResults.files.map((f) => {
                const Icon = fileMimeIcon(f.mime_type);
                return (
                  <TouchableOpacity key={f.id} style={styles.searchFileRow} onPress={() => handleDownload(f)}>
                    <Icon size={18} color={colors.textSecondary} />
                    <Text style={styles.searchFileName} numberOfLines={1}>{f.name}</Text>
                    <Text style={styles.searchFileSize}>{formatBytes(f.size_bytes)}</Text>
                    <Download size={16} color={colors.textMuted} />
                  </TouchableOpacity>
                );
              })}
            </>
          )}
          {!searching && searchResults &&
            searchResults.files.length === 0 && searchResults.groups.length === 0 && (
            <Text style={styles.emptySearchText}>No results for “{searchQuery.trim()}”.</Text>
          )}
        </ScrollView>
      ) : loading ? (
        <ActivityIndicator style={styles.center} color={colors.primary} />
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={load} style={styles.retryButton}>
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : isMediaFolder ? (
        <MediaGallery
          files={files}
          currentFolderID={currentFolderID!}
          isSubcollection={isInsideSubcollection}
          cols={galleryCols}
          onDeleteFile={(id) => setFiles((prev) => prev.filter((f) => f.id !== id))}
        />
      ) : (
        <FlatList
          data={listData}
          keyExtractor={(item) => (item.type === 'folder' ? `f:${item.item.id}` : `file:${item.item.id}`)}
          onRefresh={load}
          refreshing={loading}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Folder size={48} color={colors.textMuted} strokeWidth={1} />
              <Text style={styles.emptyText}>This folder is empty</Text>
            </View>
          }
          renderItem={({ item }) => {
            if (item.type === 'folder') {
              const folder = item.item;
              const isMedia = folder.kind === 'media';
              return (
                <TouchableOpacity style={styles.row} onPress={() => enterFolder(folder)}>
                  <View style={[styles.iconWrap, isMedia ? styles.mediaIconWrap : styles.folderIconWrap]}>
                    {isMedia
                      ? <GalleryHorizontalEnd size={20} color={colors.mediaAccent} strokeWidth={1.5} />
                      : <Folder size={20} color={colors.primary} strokeWidth={1.5} />
                    }
                  </View>
                  <View style={styles.info}>
                    <Text style={styles.name} numberOfLines={1}>{folder.name}</Text>
                    <Text style={[styles.meta, isMedia && styles.mediaMeta]}>
                      {isMedia ? 'Media Collection' : 'Folder'}
                    </Text>
                  </View>
                  <ChevronRight size={18} color={colors.textMuted} />
                </TouchableOpacity>
              );
            }

            const file = item.item;
            const FileIcon = fileMimeIcon(file.mime_type);
            const isMedia = file.mime_type.startsWith('image/') || file.mime_type.startsWith('video/');
            return (
              <View style={styles.row}>
                <View style={[styles.iconWrap, isMedia && styles.imageIconWrap]}>
                  <FileIcon size={20} color={isMedia ? colors.primary : colors.textSecondary} strokeWidth={1.5} />
                </View>
                <View style={styles.info}>
                  <Text style={styles.name} numberOfLines={1}>{file.name}</Text>
                  <Text style={styles.meta}>{formatBytes(file.size_bytes)}</Text>
                </View>
                <TouchableOpacity onPress={() => handleDownload(file)} style={styles.action}>
                  <Download size={18} color={colors.primary} strokeWidth={1.5} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => handleFavorite(file.id)} style={styles.action}>
                  <Star size={18} color={colors.warning} strokeWidth={1.5} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => handleDelete(file.id)} style={styles.action}>
                  <Trash2 size={18} color={colors.error} strokeWidth={1.5} />
                </TouchableOpacity>
              </View>
            );
          }}
        />
      )}

      {/* Upload FAB — hidden inside media collections (gallery has its own actions) */}
      {!isMediaFolder && (
        <TouchableOpacity
          style={[styles.fab, uploading && styles.fabDisabled]}
          onPress={handleUpload}
          disabled={uploading}
        >
          {uploading
            ? <ActivityIndicator color={colors.surface} size="small" />
            : <Upload size={22} color={colors.surface} strokeWidth={2} />
          }
        </TouchableOpacity>
      )}

      {/* Create folder modal */}
      <Modal
        visible={createVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCreateVisible(false)}
      >
        <Pressable style={styles.overlay} onPress={() => !creating && setCreateVisible(false)}>
          <Pressable style={styles.createSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.createTitle}>{createTitle}</Text>

            {/* Type selector — only shown at root level */}
            {isAtRoot && !isInsideMediaCollection && (
              <View style={styles.kindRow}>
                <TouchableOpacity
                  style={[styles.kindPill, createKind === 'regular' && styles.kindPillActive]}
                  onPress={() => setCreateKind('regular')}
                >
                  <Folder size={14} color={createKind === 'regular' ? colors.primary : colors.textMuted} strokeWidth={1.5} style={{ marginRight: 5 }} />
                  <Text style={[styles.kindPillText, createKind === 'regular' && styles.kindPillTextActive]}>
                    Folder
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.kindPill, createKind === 'media' && styles.kindPillMediaActive]}
                  onPress={() => setCreateKind('media')}
                >
                  <GalleryHorizontalEnd size={14} color={createKind === 'media' ? colors.mediaAccent : colors.textMuted} strokeWidth={1.5} style={{ marginRight: 5 }} />
                  <Text style={[styles.kindPillText, createKind === 'media' && styles.kindPillTextMedia]}>
                    Media Collection
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            <TextInput
              style={styles.nameInput}
              placeholder={
                isInsideMediaCollection ? 'Subcollection name' :
                createKind === 'media' ? 'Collection name' : 'Folder name'
              }
              placeholderTextColor={colors.textMuted}
              value={createName}
              onChangeText={setCreateName}
              autoFocus
              onSubmitEditing={handleCreate}
              returnKeyType="done"
            />

            <View style={styles.createActions}>
              <TouchableOpacity
                style={styles.createCancelBtn}
                onPress={() => setCreateVisible(false)}
                disabled={creating}
              >
                <Text style={styles.createCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.createConfirmBtn, (!createName.trim() || creating) && styles.createConfirmDisabled]}
                onPress={handleCreate}
                disabled={!createName.trim() || creating}
              >
                {creating
                  ? <ActivityIndicator size="small" color={colors.surface} />
                  : <Text style={styles.createConfirmText}>Create</Text>
                }
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* AI recognition: collection settings + groups browser */}
      {currentFolder && isMediaFolder && (
        <CollectionSettingsSheet
          visible={settingsVisible}
          folder={currentFolder}
          isPremium={isPremiumUser}
          onClose={() => setSettingsVisible(false)}
          onChanged={load}
        />
      )}
      {groupsModal && (
        <RecognitionGroupsModal
          visible
          collectionID={groupsModal.collectionID}
          initialGroupID={groupsModal.initialGroupID}
          onClose={() => setGroupsModal(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.textPrimary, padding: 0 },
  searchSection: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  groupChipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  groupChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  groupChipLabel: { fontSize: 13, color: colors.textPrimary, fontWeight: '500' },
  groupChipMeta: { fontSize: 11, color: colors.textMuted },
  searchFileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  searchFileName: { flex: 1, fontSize: 14, color: colors.textPrimary },
  searchFileSize: { fontSize: 11, color: colors.textMuted },
  emptySearchText: { fontSize: 13, color: colors.textSecondary, marginTop: spacing.md },

  breadcrumbWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  breadcrumbBar: { flex: 1 },
  breadcrumbContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  crumbText: { fontSize: 14, color: colors.textSecondary },
  crumbActive: { color: colors.textPrimary, fontWeight: '600' },
  crumbSep: { marginHorizontal: spacing.xs },
  addBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },

  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  list: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: 100 },
  separator: { height: 1, backgroundColor: colors.divider, marginLeft: 56 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 10,
    ...shadow.sm,
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.divider,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  folderIconWrap: { backgroundColor: colors.primaryLighter },
  mediaIconWrap: { backgroundColor: colors.mediaAccentLighter },
  imageIconWrap: { backgroundColor: colors.primaryLighter },
  info: { flex: 1, marginRight: spacing.xs },
  name: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  meta: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  mediaMeta: { color: colors.mediaAccent },
  action: { padding: spacing.sm },

  emptyState: { alignItems: 'center', paddingTop: 80 },
  emptyText: { marginTop: spacing.md, fontSize: 15, color: colors.textMuted },

  errorText: { color: colors.error, marginBottom: spacing.sm, textAlign: 'center' },
  retryButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
  },
  retryText: { color: colors.primary, fontWeight: '600' },

  fab: {
    position: 'absolute',
    bottom: spacing.xl,
    right: spacing.lg,
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.md,
  },
  fabDisabled: { opacity: 0.6 },

  // Create modal
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: spacing.lg },
  createSheet: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  createTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  kindRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  kindPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  kindPillActive: { borderColor: colors.primary, backgroundColor: colors.primaryLighter },
  kindPillMediaActive: { borderColor: colors.mediaAccent, backgroundColor: colors.mediaAccentLighter },
  kindPillText: { fontSize: 13, fontWeight: '500', color: colors.textMuted },
  kindPillTextActive: { color: colors.primary },
  kindPillTextMedia: { color: colors.mediaAccent },
  nameInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  createActions: { flexDirection: 'row', gap: spacing.sm },
  createCancelBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: radius.md,
    backgroundColor: colors.divider,
    alignItems: 'center',
  },
  createCancelText: { fontSize: 15, fontWeight: '500', color: colors.textSecondary },
  createConfirmBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  createConfirmDisabled: { opacity: 0.5 },
  createConfirmText: { fontSize: 15, fontWeight: '600', color: colors.surface },
});
