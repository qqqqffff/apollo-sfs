import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { listFavorites, unfavoriteFile } from '../api/files';

interface FavoriteFile {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
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

  if (loading) return <ActivityIndicator style={styles.center} />;

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
            <Text style={styles.meta}>{item.mime_type}</Text>
          </View>
          <TouchableOpacity onPress={() => handleUnfavorite(item.id)} style={styles.action}>
            <Text style={styles.unfav}>★</Text>
          </TouchableOpacity>
        </View>
      )}
      ListEmptyComponent={<Text style={styles.empty}>No favorites yet.</Text>}
    />
  );
}

const styles = StyleSheet.create({
  list: { backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', marginHorizontal: 16, marginTop: 8, borderRadius: 8, padding: 12 },
  info: { flex: 1 },
  name: { fontWeight: '600', fontSize: 15 },
  meta: { color: '#6b7280', fontSize: 12, marginTop: 2 },
  action: { padding: 8 },
  unfav: { color: '#f59e0b', fontSize: 18 },
  empty: { textAlign: 'center', marginTop: 40, color: '#9ca3af' },
});
