import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  ChevronRight,
  FileText,
  Folder,
  Image,
  Music,
  Star,
  Trash2,
  Video,
} from 'lucide-react-native';
import { deleteFile, favoriteFile, getFolder, listRoot, type ApiFile, type ApiFolder } from '../api/files';
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

export default function FilesScreen() {
  const [subfolders, setSubfolders] = useState<ApiFolder[]>([]);
  const [files, setFiles] = useState<ApiFile[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const currentFolderID = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1].id : null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = currentFolderID ? await getFolder(currentFolderID) : await listRoot();
      setSubfolders(data.subfolders?.items ?? []);
      setFiles(data.files?.items ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [currentFolderID]);

  useEffect(() => { load(); }, [load]);

  const enterFolder = (folder: ApiFolder) => {
    setBreadcrumb((prev) => [...prev, { id: folder.id, name: folder.name }]);
  };

  const navigateToCrumb = (index: number) => {
    setBreadcrumb((prev) => prev.slice(0, index));
  };

  const handleFavorite = async (fileID: string) => {
    try { await favoriteFile(fileID); } catch {}
  };

  const handleDelete = async (fileID: string) => {
    try {
      await deleteFile(fileID);
      setFiles((prev) => prev.filter((f) => f.id !== fileID));
    } catch {}
  };

  const listData: ListItem[] = [
    ...subfolders.map((f) => ({ type: 'folder' as const, item: f })),
    ...files.map((f) => ({ type: 'file' as const, item: f })),
  ];

  return (
    <View style={styles.container}>
      {/* Breadcrumb */}
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

      {loading ? (
        <ActivityIndicator style={styles.center} color={colors.primary} />
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={load} style={styles.retryButton}>
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
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
              return (
                <TouchableOpacity style={styles.row} onPress={() => enterFolder(folder)}>
                  <View style={[styles.iconWrap, styles.folderIconWrap]}>
                    <Folder size={20} color={colors.primary} strokeWidth={1.5} />
                  </View>
                  <View style={styles.info}>
                    <Text style={styles.name} numberOfLines={1}>{folder.name}</Text>
                    <Text style={styles.meta}>Folder</Text>
                  </View>
                  <ChevronRight size={18} color={colors.textMuted} />
                </TouchableOpacity>
              );
            }

            const file = item.item;
            const FileIcon = fileMimeIcon(file.mime_type);
            const isImage = file.mime_type.startsWith('image/');
            return (
              <View style={styles.row}>
                <View style={[styles.iconWrap, isImage && styles.imageIconWrap]}>
                  <FileIcon size={20} color={isImage ? colors.primary : colors.textSecondary} strokeWidth={1.5} />
                </View>
                <View style={styles.info}>
                  <Text style={styles.name} numberOfLines={1}>{file.name}</Text>
                  <Text style={styles.meta}>{formatBytes(file.size_bytes)}</Text>
                </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  breadcrumbBar: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexGrow: 0,
  },
  breadcrumbContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  crumbText: { fontSize: 14, color: colors.textSecondary },
  crumbActive: { color: colors.textPrimary, fontWeight: '600' },
  crumbSep: { marginHorizontal: spacing.xs },

  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  list: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.lg },
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
  imageIconWrap: { backgroundColor: colors.primaryLighter },
  info: { flex: 1, marginRight: spacing.xs },
  name: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  meta: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
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
});
