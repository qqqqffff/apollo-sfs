import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ChevronRight, Clock, Moon, Wifi } from 'lucide-react-native';
import {
  NIGHTSYNC_DEFAULT_HOUR,
  NIGHTSYNC_HOUR_KEY,
  NIGHTSYNC_KEY,
} from '../tasks/backgroundSync';
import { colors, radius, shadow, spacing } from '../theme';

const WIFI_ONLY_KEY = 'apollo_wifi_only';

function formatHour(h: number): string {
  if (h === 0) return '12:00 AM';
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return '12:00 PM';
  return `${h - 12}:00 PM`;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export default function SettingsScreen() {
  const [wifiOnly, setWifiOnly] = useState(false);
  const [nightSync, setNightSync] = useState(false);
  const [nightSyncHour, setNightSyncHour] = useState(NIGHTSYNC_DEFAULT_HOUR);
  const [hourPickerVisible, setHourPickerVisible] = useState(false);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(WIFI_ONLY_KEY),
      AsyncStorage.getItem(NIGHTSYNC_KEY),
      AsyncStorage.getItem(NIGHTSYNC_HOUR_KEY),
    ]).then(([wifi, night, hour]) => {
      setWifiOnly(wifi === 'true');
      setNightSync(night === 'true');
      if (hour !== null) setNightSyncHour(parseInt(hour, 10));
    });
  }, []);

  const toggleWifi = async (value: boolean) => {
    setWifiOnly(value);
    await AsyncStorage.setItem(WIFI_ONLY_KEY, value ? 'true' : 'false');
  };

  const toggleNightSync = async (value: boolean) => {
    setNightSync(value);
    await AsyncStorage.setItem(NIGHTSYNC_KEY, value ? 'true' : 'false');
  };

  const selectHour = async (h: number) => {
    setNightSyncHour(h);
    setHourPickerVisible(false);
    await AsyncStorage.setItem(NIGHTSYNC_HOUR_KEY, String(h));
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Backup</Text>

        {/* Wi-Fi only */}
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

        <View style={styles.separator} />

        {/* Night backup */}
        <View style={styles.row}>
          <View style={[styles.iconWrap, nightSync && styles.iconWrapNight]}>
            <Moon size={18} color={nightSync ? colors.mediaAccent : colors.textMuted} strokeWidth={1.5} />
          </View>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>Night backup</Text>
            <Text style={styles.rowMeta}>
              Auto-sync once daily when storage is below 75% full
            </Text>
          </View>
          <Switch
            value={nightSync}
            onValueChange={toggleNightSync}
            trackColor={{ false: colors.border, true: colors.mediaAccentLighter }}
            thumbColor={nightSync ? colors.mediaAccent : colors.textMuted}
          />
        </View>

        {/* Sync time — only visible when night backup is on */}
        {nightSync && (
          <>
            <View style={styles.separator} />
            <TouchableOpacity style={styles.row} onPress={() => setHourPickerVisible(true)}>
              <View style={[styles.iconWrap, styles.iconWrapNight]}>
                <Clock size={18} color={colors.mediaAccent} strokeWidth={1.5} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>Sync time</Text>
                <Text style={styles.rowMeta}>Runs within a 2-hour window of this time</Text>
              </View>
              <View style={styles.hourChip}>
                <Text style={styles.hourChipText}>{formatHour(nightSyncHour)}</Text>
                <ChevronRight size={14} color={colors.mediaAccent} style={{ marginLeft: 2 }} />
              </View>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* Hour picker modal */}
      <Modal
        visible={hourPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setHourPickerVisible(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setHourPickerVisible(false)}>
          <Pressable style={styles.pickerSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.pickerTitle}>Sync Time</Text>
            <ScrollView style={styles.pickerList} showsVerticalScrollIndicator={false}>
              {HOURS.map((h) => (
                <TouchableOpacity
                  key={h}
                  style={[styles.pickerRow, nightSyncHour === h && styles.pickerRowActive]}
                  onPress={() => selectHour(h)}
                >
                  <Text style={[styles.pickerRowText, nightSyncHour === h && styles.pickerRowTextActive]}>
                    {formatHour(h)}
                  </Text>
                  {nightSyncHour === h && (
                    <View style={styles.pickerCheck} />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md },

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
  separator: {
    height: 1,
    backgroundColor: colors.divider,
    marginVertical: spacing.sm,
    marginLeft: 46,
  },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2 },
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
  iconWrapNight: { backgroundColor: colors.mediaAccentLighter },
  rowText: { flex: 1 },
  rowLabel: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  rowMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },

  hourChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.md,
    backgroundColor: colors.mediaAccentLighter,
  },
  hourChipText: { fontSize: 13, fontWeight: '600', color: colors.mediaAccent },

  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    maxHeight: '60%',
  },
  pickerTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  pickerList: { paddingHorizontal: spacing.md },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  pickerRowActive: { },
  pickerRowText: { fontSize: 16, color: colors.textPrimary },
  pickerRowTextActive: { color: colors.mediaAccent, fontWeight: '600' },
  pickerCheck: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.mediaAccent,
  },
});
