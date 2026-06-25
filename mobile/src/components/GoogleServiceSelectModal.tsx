import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Check, Cloud, HardDrive, Image as ImageIcon } from 'lucide-react-native';
import { colors, radius, spacing } from '../theme';

export interface GoogleServiceSelection {
  photos: boolean;
  drive: boolean;
}

interface Props {
  visible: boolean;
  onCancel: () => void;
  onContinue: (selection: GoogleServiceSelection) => void;
}

// Preliminary chooser shown before sign-in: lets the user pick which Google
// services to pull from. Skipping a service avoids its fetch entirely (no Photos
// picker if Photos is off, no Drive listing if Drive is off).
export default function GoogleServiceSelectModal({ visible, onCancel, onContinue }: Props) {
  const [photos, setPhotos] = useState(true);
  const [drive, setDrive]   = useState(true);

  // Reset to the default (both on) each time the chooser opens.
  useEffect(() => {
    if (visible) { setPhotos(true); setDrive(true); }
  }, [visible]);

  const canContinue = photos || drive;

  const rows: { key: 'photos' | 'drive'; label: string; desc: string; Icon: typeof Cloud; on: boolean; toggle: () => void }[] = [
    { key: 'photos', label: 'Google Photos', desc: 'Pick photos and videos to back up', Icon: ImageIcon, on: photos, toggle: () => setPhotos((v) => !v) },
    { key: 'drive',  label: 'Google Drive',  desc: 'Back up files from your Drive',      Icon: HardDrive, on: drive,  toggle: () => setDrive((v) => !v) },
  ];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.overlay} onPress={onCancel}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.titleRow}>
            <Cloud size={20} color={colors.primary} strokeWidth={1.5} style={{ marginRight: spacing.sm }} />
            <Text style={styles.title}>What do you want to back up?</Text>
          </View>

          {rows.map((row) => (
            <TouchableOpacity key={row.key} style={styles.row} onPress={row.toggle} activeOpacity={0.7}>
              <View style={styles.rowIconWrap}>
                <row.Icon size={20} color={colors.primary} strokeWidth={1.5} />
              </View>
              <View style={styles.rowInfo}>
                <Text style={styles.rowLabel}>{row.label}</Text>
                <Text style={styles.rowDesc}>{row.desc}</Text>
              </View>
              <View style={[styles.checkbox, row.on && styles.checkboxOn]}>
                {row.on && <Check size={13} color={colors.surface} strokeWidth={3} />}
              </View>
            </TouchableOpacity>
          ))}

          {!canContinue && (
            <Text style={styles.hint}>Select at least one service to continue.</Text>
          )}

          <View style={styles.actions}>
            <TouchableOpacity style={[styles.btn, styles.cancelBtn]} onPress={onCancel}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.continueBtn, !canContinue && styles.btnDisabled]}
              onPress={() => canContinue && onContinue({ photos, drive })}
              disabled={!canContinue}
            >
              <Text style={styles.continueBtnText}>Continue</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl + spacing.md,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md },
  title: { fontSize: 17, fontWeight: '600', color: colors.textPrimary, flex: 1 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  rowIconWrap: {
    width: 40, height: 40, borderRadius: radius.md,
    backgroundColor: colors.primaryLighter,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.sm,
  },
  rowInfo: { flex: 1 },
  rowLabel: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  rowDesc: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  checkbox: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },

  hint: { fontSize: 12, color: colors.error, marginTop: spacing.sm },

  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  btn: { flex: 1, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  cancelBtn: { backgroundColor: colors.divider },
  cancelBtnText: { fontSize: 15, fontWeight: '600', color: colors.textSecondary },
  continueBtn: { backgroundColor: colors.primary },
  continueBtnText: { fontSize: 15, fontWeight: '600', color: colors.surface },
  btnDisabled: { opacity: 0.5 },
});
