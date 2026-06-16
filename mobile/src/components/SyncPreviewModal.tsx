import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Image as RNImage,
  Modal,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { AlertTriangle, Check, X, Zap } from 'lucide-react-native';
import { type PreviewItem } from '../services/SyncService';
import { colors, radius, shadow, spacing } from '../theme';
import StorageUpgradeModal from './StorageUpgradeModal';

// ── Constants ──────────────────────────────────────────────────────────────────

const ASSUMED_BYTES_PER_SEC = (5 * 1_000_000) / 8;
const SOFT_CAP = 0.75;
// Track is divided: 90.9% = quota zone, 9.1% = overflow zone
const QUOTA_PCT = 100 / (1 + 0.10); // ≈ 90.909
const OVERFLOW_ZONE_PCT = 100 - QUOTA_PCT;

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatUploadEta(bytes: number): string {
  const secs = Math.ceil(bytes / ASSUMED_BYTES_PER_SEC);
  if (secs < 60) return `~${secs}s`;
  const m = Math.round(secs / 60);
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `~${h}h ${rem}m` : `~${h}h`;
}

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

// ── Types ──────────────────────────────────────────────────────────────────────

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
  onStoragePurchased?: (newQuotaBytes: number) => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function SyncPreviewModal({
  visible, items, quotaBytes, usedBytes, onConfirm, onCancel, onStoragePurchased,
}: Props) {
  const [upgradeVisible, setUpgradeVisible] = useState(false);
  const [sort, setSort] = useState<'date' | 'size'>('date');
  const [selectedUris, setSelectedUris] = useState<Set<string>>(new Set());
  const [activeNavKey, setActiveNavKey] = useState<string | null>(null);
  const [limitBytes, setLimitBytes] = useState(0);
  const [overrideQuota, setOverrideQuota] = useState(false);

  const sectionListRef = useRef<SectionList<PreviewItem>>(null);
  const lastTapRef = useRef<Record<string, number>>({});
  const sliderRef = useRef<View>(null);
  const sliderLayout = useRef<{ pageX: number; width: number }>({ pageX: 0, width: 1 });
  // Refs avoid stale closures in the responder callbacks
  const overrideRef = useRef(false);
  const quotaBytesRef = useRef(quotaBytes);

  useEffect(() => { overrideRef.current = overrideQuota; }, [overrideQuota]);
  useEffect(() => { quotaBytesRef.current = quotaBytes; }, [quotaBytes]);

  // ── Init on open ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!visible) return;
    setSelectedUris(new Set(items.map((i) => i.uri)));
    setOverrideQuota(false);
    setUpgradeVisible(false);
    setActiveNavKey(null);
  }, [visible, items]);

  useEffect(() => {
    if (quotaBytes <= 0) return;
    setLimitBytes(overrideQuota ? quotaBytes : Math.max(quotaBytes * SOFT_CAP, usedBytes));
  }, [quotaBytes, usedBytes, overrideQuota]);

  // ── Derived values ────────────────────────────────────────────────────────

  const selectedItems = useMemo(() => items.filter((i) => selectedUris.has(i.uri)), [items, selectedUris]);
  const selectedSize = selectedItems.reduce((s, i) => s + i.sizeBytes, 0);
  const projectedUsed = usedBytes + selectedSize;

  const isOverLimit = quotaBytes > 0 && projectedUsed > limitBytes;
  const isOverQuota = quotaBytes > 0 && projectedUsed > quotaBytes;
  const canProceed = !isOverLimit && selectedItems.length > 0;

  // Convert a quota ratio (0-1) to a track % (quota zone = 0–QUOTA_PCT of track)
  const qToTrack = (r: number) => Math.min(r, 1) * QUOTA_PCT;

  const usedRatio    = quotaBytes > 0 ? usedBytes / quotaBytes : 0;
  const pendingRatio = quotaBytes > 0 ? selectedSize / quotaBytes : 0;
  const limitRatio   = quotaBytes > 0 ? Math.min(limitBytes / quotaBytes, 1) : SOFT_CAP;
  const overflowRatio = isOverQuota
    ? Math.min((projectedUsed - quotaBytes) / quotaBytes, 0.10)
    : 0;

  const usedTrackPct    = qToTrack(usedRatio);
  const pendingTrackPct = isOverQuota
    ? qToTrack(1 - usedRatio)          // fills to quota boundary
    : qToTrack(Math.min(pendingRatio, 1 - usedRatio));
  const overflowTrackPct = overflowRatio * QUOTA_PCT; // overflow portion inside overflow zone
  const limitTrackPct    = qToTrack(limitRatio);
  const capTrackPct      = qToTrack(SOFT_CAP);

  // ── Slider interaction ────────────────────────────────────────────────────

  const measureSlider = useCallback(() => {
    sliderRef.current?.measure((_, __, width, ___, pageX) => {
      sliderLayout.current = { pageX, width: width || 1 };
    });
  }, []);

  const handleSliderMove = useCallback((pageX: number) => {
    const { pageX: sx, width: sw } = sliderLayout.current;
    // Map pageX → container ratio (0-1), then to quota ratio (divides by QUOTA_PCT/100)
    const containerRatio = Math.max(0, Math.min(1, (pageX - sx) / sw));
    const quotaRatio = Math.min(containerRatio / (QUOTA_PCT / 100), 1);

    if (quotaRatio > SOFT_CAP && !overrideRef.current) {
      Alert.alert(
        'Override 75% cap?',
        'Your backup limit is set to 75% of your quota to keep storage headroom. Allow up to 100%?',
        [
          { text: 'Keep cap', style: 'cancel' },
          {
            text: 'Override',
            onPress: () => {
              setOverrideQuota(true);
              overrideRef.current = true;
              setLimitBytes(Math.round(quotaRatio * quotaBytesRef.current));
            },
          },
        ],
      );
      return;
    }
    setLimitBytes(Math.round(Math.min(quotaRatio, 1) * quotaBytesRef.current));
  }, []);

  // ── Selection helpers ─────────────────────────────────────────────────────

  const toggle = (uri: string) =>
    setSelectedUris((prev) => {
      const next = new Set(prev);
      next.has(uri) ? next.delete(uri) : next.add(uri);
      return next;
    });

  const selectGroup = (groupItems: PreviewItem[], select: boolean) =>
    setSelectedUris((prev) => {
      const next = new Set(prev);
      for (const item of groupItems) select ? next.add(item.uri) : next.delete(item.uri);
      return next;
    });

  const handleSectionHeaderPress = (sectionKey: string, sectionData: PreviewItem[]) => {
    const now = Date.now();
    const last = lastTapRef.current[sectionKey] ?? 0;
    lastTapRef.current[sectionKey] = now;
    if (now - last < 350) {
      const allSelected = sectionData.every((i) => selectedUris.has(i.uri));
      selectGroup(sectionData, !allSelected);
    }
  };

  // ── Data sections ─────────────────────────────────────────────────────────

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

  const sizeSorted = useMemo(() => [...items].sort((a, b) => b.sizeBytes - a.sizeBytes), [items]);
  const allSelected = selectedUris.size === items.length;

  // ── Row renderer ──────────────────────────────────────────────────────────

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

  // ── Preview view ──────────────────────────────────────────────────────────

  return (
    <>
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <View style={styles.root}>

        {/* Header */}
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

        {/* Summary + Quota Slider */}
        <View style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryCount}>
              {selectedItems.length} of {items.length} photo{items.length !== 1 ? 's' : ''}
            </Text>
            <View style={styles.summaryRight}>
              <Text style={styles.summarySize}>{formatBytes(selectedSize)}</Text>
              {selectedSize > 0 && (
                <Text style={styles.summaryEta}>{formatUploadEta(selectedSize)}</Text>
              )}
            </View>
          </View>

          {quotaBytes > 0 && (
            <>
              {/* Quota slider — full touch area */}
              <View
                ref={sliderRef}
                style={styles.sliderContainer}
                onLayout={measureSlider}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderGrant={(e) => handleSliderMove(e.nativeEvent.pageX)}
                onResponderMove={(e) => handleSliderMove(e.nativeEvent.pageX)}
              >
                {/* Track strip (overflow:hidden clips fills) */}
                <View style={styles.sliderTrack}>
                  {/* Overflow zone red tint (always visible on right) */}
                  <View style={[styles.sliderFill, {
                    left: `${QUOTA_PCT}%` as any, right: 0,
                    backgroundColor: 'rgba(239,68,68,0.08)',
                  }]} />
                  {/* Already-used segment */}
                  <View style={[styles.sliderFill, {
                    left: 0, width: `${usedTrackPct}%` as any,
                    backgroundColor: colors.primary, opacity: 0.35,
                  }]} />
                  {/* Selected/pending segment */}
                  <View style={[styles.sliderFill, {
                    left: `${usedTrackPct}%` as any,
                    width: `${pendingTrackPct}%` as any,
                    backgroundColor: isOverLimit ? colors.error : colors.primary,
                  }]} />
                  {/* Overflow segment (extends into overflow zone) */}
                  {isOverQuota && overflowTrackPct > 0 && (
                    <View style={[styles.sliderFill, {
                      left: `${QUOTA_PCT}%` as any,
                      width: `${Math.min(overflowTrackPct, OVERFLOW_ZONE_PCT)}%` as any,
                      backgroundColor: colors.error,
                    }]} />
                  )}
                </View>

                {/* Quota boundary line — appears when overflow to mark where quota ends */}
                {isOverQuota && (
                  <View style={[styles.sliderMarker, {
                    left: `${QUOTA_PCT}%` as any,
                    backgroundColor: colors.error,
                    opacity: 0.7,
                  }]} />
                )}

                {/* 75% cap marker */}
                {!overrideQuota && (
                  <View style={[styles.sliderMarker, {
                    left: `${capTrackPct}%` as any,
                    backgroundColor: colors.warning,
                  }]} />
                )}

                {/* Draggable limit handle */}
                <View style={[styles.sliderHandle, { left: `${limitTrackPct}%` as any }]} />
              </View>

              {/* Labels */}
              <View style={styles.quotaLabels}>
                <Text style={[styles.quotaLabelText, isOverQuota && { color: colors.error }]}>
                  {formatBytes(projectedUsed)} projected
                </Text>
                <Text style={styles.quotaLabelText}>
                  {formatBytes(limitBytes)} limit · {formatBytes(quotaBytes)} quota
                </Text>
              </View>

              {/* Cap toggle row */}
              <TouchableOpacity
                style={styles.capRow}
                onPress={() => setOverrideQuota((v) => !v)}
                activeOpacity={0.7}
              >
                <View style={[styles.capDot, { backgroundColor: overrideQuota ? colors.success : colors.warning }]} />
                <Text style={styles.capText}>
                  {overrideQuota ? 'Cap overridden — full quota available' : '75% cap active'}
                </Text>
                <Text style={styles.capToggleText}>{overrideQuota ? 'Restore' : 'Override'}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* Upgrade strip — tappable, opens StorageUpgradeModal */}
        {isOverQuota && (
          <TouchableOpacity style={styles.upgradeStrip} onPress={() => setUpgradeVisible(true)} activeOpacity={0.85}>
            <Zap size={14} color={colors.surface} strokeWidth={2.5} style={{ marginRight: 6 }} />
            <Text style={styles.upgradeText}>
              {formatBytes(projectedUsed - quotaBytes)} over quota
            </Text>
            <Text style={styles.upgradeAction}>Get more storage →</Text>
          </TouchableOpacity>
        )}

        {/* Over-limit warning (within quota, but past slider cap) */}
        {isOverLimit && !isOverQuota && (
          <View style={styles.warningStrip}>
            <AlertTriangle size={14} color={colors.warning} strokeWidth={2} style={{ marginRight: 6 }} />
            <Text style={styles.warningText}>
              Selection exceeds your {overrideQuota ? 'quota' : '75% cap'}.{' '}
              Reduce selection or drag the slider right.
            </Text>
          </View>
        )}

        {/* Sort bar */}
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

        {/* Date nav pills */}
        {sort === 'date' && dateSections.length > 1 && (
          <ScrollView
            horizontal showsHorizontalScrollIndicator={false}
            style={styles.dateNav} contentContainerStyle={styles.dateNavContent}
          >
            {dateSections.map((section, index) => {
              const isActive = (activeNavKey ?? dateSections[0]?.key) === section.key;
              return (
                <TouchableOpacity
                  key={section.key}
                  style={[styles.datePill, isActive && styles.datePillActive]}
                  onPress={() => {
                    setActiveNavKey(section.key);
                    sectionListRef.current?.scrollToLocation({ sectionIndex: index, itemIndex: 0, animated: true, viewOffset: 0 });
                  }}
                >
                  <Text style={[styles.datePillText, isActive && styles.datePillTextActive]}>
                    {section.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {/* List */}
        {sort === 'date' ? (
          <SectionList
            ref={sectionListRef}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            sections={dateSections}
            keyExtractor={(item) => item.uri}
            stickySectionHeadersEnabled={false}
            onViewableItemsChanged={({ viewableItems }) => {
              const first = viewableItems.find((v) => v.section);
              if (first?.section) setActiveNavKey((first.section as Section).key);
            }}
            viewabilityConfig={{ itemVisiblePercentThreshold: 10 }}
            renderSectionHeader={({ section }) => {
              const selectedInGroup = section.data.filter((i) => selectedUris.has(i.uri)).length;
              const allGroupSelected = selectedInGroup === section.data.length;
              return (
                <Pressable
                  style={styles.sectionHeader}
                  onPress={() => handleSectionHeaderPress(section.key, section.data)}
                >
                  <Text style={styles.sectionTitle}>{section.label}</Text>
                  <Text style={styles.sectionCount}>
                    {selectedInGroup}/{section.data.length}
                    {allGroupSelected ? '' : '  double-tap to select all'}
                  </Text>
                </Pressable>
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

        {/* Footer */}
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.startBtn, !canProceed && styles.startBtnDisabled]}
            onPress={() => { if (canProceed) onConfirm(selectedItems); }}
            disabled={!canProceed}
            activeOpacity={0.85}
          >
            <Text style={styles.startBtnText}>
              {isOverLimit
                ? isOverQuota
                  ? 'Over quota — upgrade or reduce selection'
                  : 'Over limit — adjust slider or reduce selection'
                : selectedItems.length === 0
                  ? 'No photos selected'
                  : `Start Sync · ${selectedItems.length} photo${selectedItems.length !== 1 ? 's' : ''}`}
            </Text>
          </TouchableOpacity>
        </View>

      </View>
    </Modal>

    <StorageUpgradeModal
      visible={upgradeVisible}
      quotaBytes={quotaBytes}
      usedBytes={usedBytes}
      onPurchased={(newQuota) => {
        setUpgradeVisible(false);
        onStoragePurchased?.(newQuota);
      }}
      onClose={() => setUpgradeVisible(false)}
    />
    </>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

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
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: spacing.sm },
  summaryCount: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  summaryRight: { alignItems: 'flex-end' },
  summarySize: { fontSize: 15, color: colors.textSecondary },
  summaryEta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  // ── Quota slider ──
  sliderContainer: {
    height: 44,
    justifyContent: 'center',
    position: 'relative',
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  sliderTrack: {
    height: 8,
    backgroundColor: colors.border,
    borderRadius: 4,
    overflow: 'hidden',
    position: 'relative',
  },
  sliderFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
  },
  sliderHandle: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 2.5,
    borderColor: colors.primary,
    marginLeft: -12,
    top: '50%' as any,
    marginTop: -12,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  sliderMarker: {
    position: 'absolute',
    width: 2,
    height: 20,
    borderRadius: 1,
    top: '50%' as any,
    marginTop: -10,
    marginLeft: -1,
  },

  quotaLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
    marginBottom: spacing.xs,
  },
  quotaLabelText: { fontSize: 11, color: colors.textMuted },

  capRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    marginTop: spacing.xs,
  },
  capDot: { width: 7, height: 7, borderRadius: 4, marginRight: 7 },
  capText: { flex: 1, fontSize: 12, color: colors.textSecondary },
  capToggleText: { fontSize: 12, fontWeight: '600', color: colors.primary },

  // ── Strips ──
  upgradeStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.error,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 10,
  },
  upgradeText: { flex: 1, fontSize: 13, color: colors.surface, fontWeight: '500' },
  upgradeAction: { fontSize: 13, fontWeight: '700', color: colors.surface },

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

  // ── Sort ──
  sortBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  sortLabel: { fontSize: 13, color: colors.textMuted, marginRight: spacing.xs },
  sortPill: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.xl, backgroundColor: colors.divider },
  sortPillActive: { backgroundColor: colors.primary },
  sortPillText: { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  sortPillTextActive: { color: colors.surface },

  // ── Date nav ──
  dateNav: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.border },
  dateNavContent: { flexDirection: 'row', paddingHorizontal: spacing.md, paddingVertical: 8, gap: spacing.xs },
  datePill: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.xl, backgroundColor: colors.divider },
  datePillActive: { backgroundColor: colors.primary },
  datePillText: { fontSize: 12, fontWeight: '500', color: colors.textSecondary },
  datePillTextActive: { color: colors.surface },

  // ── Section list ──
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionCount: { fontSize: 12, color: colors.textMuted },

  list: { flex: 1 },
  listContent: { paddingHorizontal: spacing.md, paddingBottom: 100 },

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
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },

  // ── Footer ──
  footer: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
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
