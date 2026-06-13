import React, { useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Image as RNImage,
  Modal,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { AlertTriangle, Check, X } from 'lucide-react-native';
import { type PreviewItem } from '../services/SyncService';
import { colors, radius, shadow, spacing } from '../theme';

function formatBytes(b: number): string {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function dayLabel(d: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const itemDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (itemDay === today) return 'Today';
  if (itemDay === yesterday) return 'Yesterday';
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

interface Section {
  key: string;
  label: string;
  data: PreviewItem[];
}

interface Props {
  visible: boolean;
  items: PreviewItem[];
  quotaBytes: number;
  usedBytes: number;
  onConfirm: (selected: PreviewItem[]) => void;
  onCancel: () => void;
}

export default function SyncPreviewModal({ visible, items, quotaBytes, usedBytes, onConfirm, onCancel }: Props) {
  const [sort, setSort] = useState<'date' | 'size'>('date');
  const [selectedUris, setSelectedUris] = useState<Set<string>>(new Set());
  const [overrideQuota, setOverrideQuota] = useState(false);

  useEffect(() => {
    setSelectedUris(new Set(items.map((i) => i.uri)));
    setOverrideQuota(false);
  }, [items]);

  const selectedItems = useMemo(
    () => items.filter((i) => selectedUris.has(i.uri)),
    [items, selectedUris],
  );
  const selectedSize = selectedItems.reduce((s, i) => s + i.sizeBytes, 0);
  const projectedUsed = usedBytes + selectedSize;
  const softCapPct = 0.75;
  const cap = overrideQuota ? quotaBytes : quotaBytes * softCapPct;
  const isOverCap = quotaBytes > 0 && projectedUsed > cap;
  const canProceed = !isOverCap && selectedItems.length > 0;

  const currentPct = quotaBytes > 0 ? Math.min((usedBytes / quotaBytes) * 100, 100) : 0;
  const pendingPct = quotaBytes > 0
    ? Math.min((selectedSize / quotaBytes) * 100, 100 - currentPct)
    : 0;

  const toggle = (uri: string) => {
    setSelectedUris((prev) => {
      const next = new Set(prev);
      if (next.has(uri)) next.delete(uri);
      else next.add(uri);
      return next;
    });
  };

  const selectGroup = (groupItems: PreviewItem[], select: boolean) => {
    setSelectedUris((prev) => {
      const next = new Set(prev);
      for (const item of groupItems) {
        if (select) next.add(item.uri);
        else next.delete(item.uri);
      }
      return next;
    });
  };

  const dateSections: Section[] = useMemo(() => {
    const sorted = [...items].sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
    const map = new Map<string, Section>();
    for (const item of sorted) {
      const key = item.takenAt.toDateString();
      if (!map.has(key)) map.set(key, { key, label: dayLabel(item.takenAt), data: [] });
      map.get(key)!.data.push(item);
    }
    return Array.from(map.values());
  }, [items]);

  const sizeSorted = useMemo(
    () => [...items].sort((a, b) => b.sizeBytes - a.sizeBytes),
    [items],
  );

  const allSelected = selectedUris.size === items.length;

  const renderRow = (item: PreviewItem) => {
    const checked = selectedUris.has(item.uri);
    return (
      <TouchableOpacity style={styles.itemRow} onPress={() => toggle(item.uri)} activeOpacity={0.7}>
        <RNImage source={{ uri: item.uri }} style={styles.thumb} resizeMode="cover" />
        <View style={styles.itemInfo}>
          <Text style={styles.itemName} numberOfLines={1}>{item.filename}</Text>
          <Text style={styles.itemMeta}>{formatBytes(item.sizeBytes)}</Text>
        </View>
        <View style={[styles.checkbox, checked && styles.checkboxOn]}>
          {checked && <Check size={11} color={colors.surface} strokeWidth={3} />}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <View style={styles.root}>

        {/* ── Header ── */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onCancel} style={styles.closeBtn} hitSlop={12}>
            <X size={20} color={colors.textPrimary} strokeWidth={2} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Sync Preview</Text>
          <TouchableOpacity
            style={styles.allBtn}
            onPress={() => setSelectedUris(allSelected ? new Set() : new Set(items.map((i) => i.uri)))}
          >
            <Text style={styles.allBtnText}>{allSelected ? 'None' : 'All'}</Text>
          </TouchableOpacity>
        </View>

        {/* ── Summary + quota bar ── */}
        <View style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryCount}>
              {selectedItems.length} of {items.length} photo{items.length !== 1 ? 's' : ''}
            </Text>
            <Text style={styles.summarySize}>{formatBytes(selectedSize)}</Text>
          </View>

          {quotaBytes > 0 && (
            <>
              <View style={{ position: 'relative' }}>
                <View style={styles.barWrap}>
                  {/* existing used */}
                  <View style={[styles.barSegment, {
                    left: 0,
                    width: `${currentPct}%` as any,
                    backgroundColor: colors.primary,
                    opacity: 0.4,
                  }]} />
                  {/* pending */}
                  <View style={[styles.barSegment, {
                    left: `${currentPct}%` as any,
                    width: `${pendingPct}%` as any,
                    backgroundColor: isOverCap ? colors.error : colors.primary,
                  }]} />
                </View>
                {/* 75% cap marker sits outside overflow:hidden clip */}
                {!overrideQuota && (
                  <View
                    pointerEvents="none"
                    style={{ position: 'absolute', left: '75%' as any, top: -2, bottom: -2, width: 2, backgroundColor: colors.warning, borderRadius: 1 }}
                  />
                )}
              </View>
              <View style={styles.quotaLabels}>
                <Text style={styles.quotaLabelText}>
                  {formatBytes(projectedUsed)} projected
                </Text>
                <Text style={styles.quotaLabelText}>{formatBytes(quotaBytes)} quota</Text>
              </View>
            </>
          )}
        </View>

        {/* ── Warning strip ── */}
        {isOverCap && (
          <View style={styles.warningStrip}>
            <AlertTriangle size={14} color={colors.warning} strokeWidth={2} style={{ marginRight: 6 }} />
            <Text style={styles.warningText}>
              {overrideQuota
                ? 'Selection exceeds your full quota. Remove more photos.'
                : 'Selection would exceed 75% of your quota.'}
            </Text>
            {!overrideQuota && (
              <TouchableOpacity style={styles.overrideBtn} onPress={() => setOverrideQuota(true)}>
                <Text style={styles.overrideBtnText}>Override</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── Sort controls ── */}
        <View style={styles.sortBar}>
          <Text style={styles.sortLabel}>Sort by</Text>
          {(['date', 'size'] as const).map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.sortPill, sort === s && styles.sortPillActive]}
              onPress={() => setSort(s)}
            >
              <Text style={[styles.sortPillText, sort === s && styles.sortPillTextActive]}>
                {s === 'date' ? 'Date' : 'Size'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── List ── */}
        {sort === 'date' ? (
          <SectionList
            style={styles.list}
            contentContainerStyle={styles.listContent}
            sections={dateSections}
            keyExtractor={(item) => item.uri}
            stickySectionHeadersEnabled={false}
            renderSectionHeader={({ section }) => {
              const allGroupSelected = section.data.every((i) => selectedUris.has(i.uri));
              return (
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>{section.label}</Text>
                  <TouchableOpacity onPress={() => selectGroup(section.data, !allGroupSelected)}>
                    <Text style={styles.sectionToggle}>
                      {allGroupSelected ? 'Deselect' : 'Select'}
                    </Text>
                  </TouchableOpacity>
                </View>
              );
            }}
            renderItem={({ item }) => renderRow(item)}
          />
        ) : (
          <FlatList
            style={styles.list}
            contentContainerStyle={styles.listContent}
            data={sizeSorted}
            keyExtractor={(item) => item.uri}
            renderItem={({ item }) => renderRow(item)}
          />
        )}

        {/* ── Footer ── */}
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.startBtn, !canProceed && styles.startBtnDisabled]}
            onPress={() => { if (canProceed) onConfirm(selectedItems); }}
            disabled={!canProceed}
            activeOpacity={0.85}
          >
            <Text style={styles.startBtnText}>
              {isOverCap
                ? 'Over quota — reduce selection'
                : selectedItems.length === 0
                  ? 'No photos selected'
                  : `Start Sync · ${selectedItems.length} photo${selectedItems.length !== 1 ? 's' : ''}`}
            </Text>
          </TouchableOpacity>
        </View>

      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  closeBtn: { width: 36, alignItems: 'flex-start' },
  headerTitle: { fontSize: 17, fontWeight: '600', color: colors.textPrimary },
  allBtn: { width: 36, alignItems: 'flex-end' },
  allBtnText: { fontSize: 14, fontWeight: '600', color: colors.primary },

  summaryCard: {
    backgroundColor: colors.surface,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    borderRadius: radius.lg,
    padding: spacing.md,
    ...shadow.sm,
  },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm },
  summaryCount: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  summarySize: { fontSize: 15, color: colors.textSecondary },

  barWrap: {
    height: 8,
    backgroundColor: colors.border,
    borderRadius: radius.xl,
    overflow: 'hidden',
    position: 'relative',
  },
  barSegment: { position: 'absolute', top: 0, bottom: 0 },
  quotaLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
  quotaLabelText: { fontSize: 11, color: colors.textMuted },

  warningStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.warningBg,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 9,
  },
  warningText: { flex: 1, fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  overrideBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.warning,
    marginLeft: spacing.sm,
  },
  overrideBtnText: { fontSize: 12, fontWeight: '700', color: colors.surface },

  sortBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  sortLabel: { fontSize: 13, color: colors.textMuted, marginRight: spacing.xs },
  sortPill: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radius.xl,
    backgroundColor: colors.divider,
  },
  sortPillActive: { backgroundColor: colors.primary },
  sortPillText: { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  sortPillTextActive: { color: colors.surface },

  list: { flex: 1 },
  listContent: { paddingHorizontal: spacing.md, paddingBottom: 100 },

  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionToggle: { fontSize: 13, fontWeight: '600', color: colors.primary },

  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  thumb: { width: 52, height: 52, borderRadius: radius.sm, backgroundColor: colors.border },
  itemInfo: { flex: 1, marginLeft: spacing.sm },
  itemName: { fontSize: 14, fontWeight: '500', color: colors.textPrimary },
  itemMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },

  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.md,
    paddingBottom: spacing.lg,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  startBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  startBtnDisabled: { opacity: 0.5 },
  startBtnText: { fontSize: 16, fontWeight: '600', color: colors.surface },
});
