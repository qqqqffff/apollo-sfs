import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { FileText, Image, Music, Star, Video } from 'lucide-react-native';
import { listFavorites, unfavoriteFile } from '../api/files';
import { colors, radius, shadow, spacing } from '../theme';

interface FavoriteFile {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
}

function fileMimeIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.startsWith('audio/')) return Music;
  return FileText;
}

export default function FavoritesScreen() {
  const [files, setFiles] = useState<FavoriteFile[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listFavorites();
      setFiles(data.files ?? []);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleUnfavorite = async (fileID: string) => {
    try {
      await unfavoriteFile(fileID);
      setFiles((prev) => prev.filter((f) => f.id !== fileID));
    } catch {}
  };

  if (loading) return <ActivityIndicator style={styles.center} color={colors.primary} />;

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.list}
      data={files}
      keyExtractor={(f) => f.id}
      onRefresh={load}
      refreshing={loading}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      ListEmptyComponent={
        <View style={styles.emptyState}>
          <Star size={48} color={colors.textMuted} strokeWidth={1} />
          <Text style={styles.emptyText}>No favorites yet</Text>
          <Text style={styles.emptySubtext}>Star files in the Files tab to find them here</Text>
        </View>
      }
      renderItem={({ item }) => {
        const FileIcon = fileMimeIcon(item.mime_type);
        return (
          <View style={styles.row}>
            <View style={styles.iconWrap}>
              <FileIcon size={20} color={colors.primary} strokeWidth={1.5} />
            </View>
            <View style={styles.info}>
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.meta}>{item.mime_type.split('/')[1]?.toUpperCase()}</Text>
            </View>
            <TouchableOpacity onPress={() => handleUnfavorite(item.id)} style={styles.action}>
              <Star size={20} color={colors.warning} fill={colors.warning} strokeWidth={0} />
            </TouchableOpacity>
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  list: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.lg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
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
    backgroundColor: colors.primaryLighter,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  info: { flex: 1 },
  name: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  meta: { fontSize: 12, color: colors.textSecondary, marginTop: 1 },
  action: { padding: spacing.sm },
  emptyState: { alignItems: 'center', paddingTop: 80 },
  emptyText: { marginTop: spacing.md, fontSize: 16, fontWeight: '600', color: colors.textSecondary },
  emptySubtext: { marginTop: spacing.xs, fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingHorizontal: spacing.xl },
});
