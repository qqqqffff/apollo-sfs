import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { deleteFile, favoriteFile, listRoot, type ApiFile } from '../api/files';

export default function FilesScreen() {
  const [files, setFiles] = useState<ApiFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const contents = await listRoot();
      setFiles(contents.files.items);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleFavorite = async (fileID: string) => {
    try { await favoriteFile(fileID); } catch {}
  };

  const handleDelete = async (fileID: string) => {
    try {
      await deleteFile(fileID);
      setFiles((prev) => prev.filter((f) => f.id !== fileID));
    } catch {}
  };

  if (loading) return <ActivityIndicator style={styles.center} />;
  if (error) return (
    <View style={styles.center}>
      <Text style={styles.errorText}>{error}</Text>
      <TouchableOpacity onPress={load}><Text style={styles.retry}>Retry</Text></TouchableOpacity>
    </View>
  );

  return (
    <FlatList
      style={styles.list}
      data={files}
      keyExtractor={(f) => f.id}
      onRefresh={load}
      refreshing={loading}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <View style={styles.info}>
            <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.meta}>{item.mime_type} · {formatBytes(item.size_bytes)}</Text>
          </View>
          <TouchableOpacity onPress={() => handleFavorite(item.id)} style={styles.action}>
            <Text>★</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => handleDelete(item.id)} style={styles.action}>
            <Text style={styles.deleteText}>✕</Text>
          </TouchableOpacity>
        </View>
      )}
      ListEmptyComponent={<Text style={styles.empty}>No files yet.</Text>}
    />
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const styles = StyleSheet.create({
  list: { backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', marginHorizontal: 16, marginTop: 8, borderRadius: 8, padding: 12 },
  info: { flex: 1 },
  name: { fontWeight: '600', fontSize: 15 },
  meta: { color: '#6b7280', fontSize: 12, marginTop: 2 },
  action: { padding: 8 },
  deleteText: { color: '#ef4444' },
  empty: { textAlign: 'center', marginTop: 40, color: '#9ca3af' },
  errorText: { color: '#ef4444', marginBottom: 8 },
  retry: { color: '#1a56db' },
});
