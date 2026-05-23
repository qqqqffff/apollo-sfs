import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { Wifi } from 'lucide-react-native';
import { colors, radius, shadow, spacing } from '../theme';

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
          <View style={[styles.iconWrap, wifiOnly && styles.iconWrapActive]}>
            <Wifi size={18} color={wifiOnly ? colors.primary : colors.textMuted} strokeWidth={1.5} />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Wi-Fi only</Text>
            <Text style={styles.rowMeta}>Only sync when connected to Wi-Fi</Text>
          </View>
          <Switch
            value={wifiOnly}
            onValueChange={toggleWifi}
            trackColor={{ false: colors.border, true: colors.primaryLight }}
            thumbColor={wifiOnly ? colors.primary : colors.textMuted}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.md },
  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    ...shadow.sm,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.md,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.divider,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  iconWrapActive: { backgroundColor: colors.primaryLighter },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  rowMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
});
