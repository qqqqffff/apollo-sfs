import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';

const WIFI_ONLY_KEY = 'apollo_wifi_only';

export default function SettingsScreen() {
  const [wifiOnly, setWifiOnly] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(WIFI_ONLY_KEY).then((v) => setWifiOnly(v === 'true'));
  }, []);

  const toggleWifi = async (value: boolean) => {
    setWifiOnly(value);
    await AsyncStorage.setItem(WIFI_ONLY_KEY, value ? 'true' : 'false');
  };

  return (
    <View style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Backup</Text>
        <View style={styles.row}>
          <View>
            <Text style={styles.rowLabel}>Wi-Fi only</Text>
            <Text style={styles.rowMeta}>Only sync when connected to Wi-Fi</Text>
          </View>
          <Switch value={wifiOnly} onValueChange={toggleWifi} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  section: { backgroundColor: '#fff', margin: 16, borderRadius: 12, padding: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rowLabel: { fontSize: 15 },
  rowMeta: { fontSize: 12, color: '#6b7280', marginTop: 2 },
});
