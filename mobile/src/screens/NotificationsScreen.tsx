import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import {
  BellRing,
  ChevronDown,
  ChevronRight,
  Clock,
  Cloud,
  CreditCard,
  FolderInput,
  HardDrive,
  Mail,
  Receipt,
  UserPlus,
  X,
  XCircle,
} from 'lucide-react-native';
import {
  dismissNotificationCategory,
  dismissNotifications,
  listNotifications,
  type AppNotification,
  type NotificationKind,
  type StorageAllocationChangeDetails,
} from '../api/me';
import { card, colors, radius, spacing } from '../theme';

const GB = 1024 ** 3;

interface KindMeta {
  Icon: React.ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  color: string;
  bg: string;
  category: string;
}

// Kinds are grouped into labelled categories: storage/billing/shares for every
// user, plus the admin-only activity kinds — mirrors the web NotificationBell.
const KIND_META: Record<NotificationKind, KindMeta> = {
  capacity_provisioned:   { Icon: Cloud,       color: colors.success,  bg: colors.successBg, category: 'Storage' },
  payment_required:       { Icon: CreditCard,  color: colors.error,    bg: colors.errorBg,   category: 'Billing' },
  action_pending:         { Icon: Clock,       color: colors.warning,  bg: colors.warningBg, category: 'Billing' },
  share_received:         { Icon: FolderInput, color: colors.primary,  bg: colors.infoBg,    category: 'Shares' },
  subscription_cancelled: { Icon: XCircle,     color: '#ea580c',       bg: '#fff7ed',        category: 'Billing' },
  quota_changed:          { Icon: HardDrive,   color: '#0284c7',       bg: '#f0f9ff',        category: 'Storage' },
  invitation_accepted:    { Icon: UserPlus,    color: colors.success,  bg: colors.successBg, category: 'Invitations' },
  order_received:         { Icon: Receipt,     color: colors.primary,  bg: colors.infoBg,    category: 'Orders' },
  email_received:         { Icon: Mail,        color: '#0284c7',       bg: '#f0f9ff',        category: 'Emails' },
  alarm_triggered:        { Icon: BellRing,    color: colors.error,    bg: colors.errorBg,   category: 'Alarms' },
};

const FALLBACK_META = KIND_META.action_pending;

// Category display order: actionable user notifications first, then admin
// activity, most urgent (alarms) at the top of the admin block.
const CATEGORY_ORDER = ['Billing', 'Storage', 'Shares', 'Alarms', 'Orders', 'Invitations', 'Emails'];

// Emails can get noisy (one entry per inbound message) — collapsed by default.
const DEFAULT_COLLAPSED = new Set(['Emails']);

export default function NotificationsScreen() {
  const navigation = useNavigation<any>();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(DEFAULT_COLLAPSED);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setItems(await listNotifications());
    } catch {
      // keep whatever we have
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const dismiss = async (ids: string[]) => {
    const prev = items;
    setItems((cur) => cur.filter((n) => !ids.includes(n.id)));
    try {
      await dismissNotifications(ids);
    } catch {
      setItems(prev);
    }
  };

  const dismissCategory = async (category: string) => {
    const prev = items;
    setItems((cur) => cur.filter((n) => (KIND_META[n.kind] ?? FALLBACK_META).category !== category));
    try {
      await dismissNotificationCategory(category);
    } catch {
      setItems(prev);
    }
  };

  // Each item deep-links to the page it concerns; the web uses SPA paths, so
  // map the ones that exist in the app to their native screens.
  const openItem = (n: AppNotification) => {
    const [pathname, search] = n.link.split('?');
    const params: Record<string, string> = {};
    for (const kv of (search ?? '').split('&')) {
      const [k, v] = kv.split('=');
      if (k && v !== undefined) params[decodeURIComponent(k)] = decodeURIComponent(v);
    }
    if (pathname.startsWith('/client/orders')) {
      navigation.navigate('Orders', { tab: params.tab, pay: params.pay });
    } else if (pathname.startsWith('/client/shared')) {
      navigation.navigate('Shared');
    } else if (pathname.startsWith('/client/profile')) {
      navigation.navigate('Main', { screen: 'Profile' });
    } else if (pathname.startsWith('/admin/metrics')) {
      navigation.navigate('Main', { screen: 'Metrics' });
    }
    // Other admin links (users, emails…) have no mobile page — leave in place.
  };

  const toggleCategory = (category: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const toggleBreakdown = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Group by category, preserving the server's newest-first order within each.
  const groups = new Map<string, AppNotification[]>();
  for (const n of items) {
    const category = (KIND_META[n.kind] ?? FALLBACK_META).category;
    const list = groups.get(category) ?? [];
    list.push(n);
    groups.set(category, list);
  }
  const orderedCategories = [
    ...CATEGORY_ORDER.filter((c) => groups.has(c)),
    ...[...groups.keys()].filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.pageTitle}>Notifications</Text>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : items.length === 0 ? (
        <View style={[card, styles.emptyCard]}>
          <Text style={styles.emptyText}>You're all caught up.</Text>
        </View>
      ) : (
        <View style={[card, { overflow: 'hidden' }]}>
          {orderedCategories.map((category) => {
            const categoryItems = groups.get(category)!;
            const isCollapsed = collapsed.has(category);
            return (
              <View key={category}>
                <View style={styles.categoryHeader}>
                  <TouchableOpacity style={styles.categoryToggle} onPress={() => toggleCategory(category)}>
                    {isCollapsed
                      ? <ChevronRight size={14} color={colors.textMuted} />
                      : <ChevronDown size={14} color={colors.textMuted} />}
                    <Text style={styles.categoryTitle}>
                      {category.toUpperCase()} ({categoryItems.length})
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => dismissCategory(category)}>
                    <Text style={styles.dismissAll}>Dismiss all</Text>
                  </TouchableOpacity>
                </View>
                {!isCollapsed &&
                  categoryItems.map((n) => {
                    const meta = KIND_META[n.kind] ?? FALLBACK_META;
                    const Icon = meta.Icon;
                    return (
                      <View key={n.id} style={styles.itemWrap}>
                        <TouchableOpacity style={styles.itemBody} onPress={() => openItem(n)} activeOpacity={0.7}>
                          <View style={[styles.itemIcon, { backgroundColor: meta.bg }]}>
                            <Icon size={15} color={meta.color} strokeWidth={2} />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.itemTitle}>{n.title}</Text>
                            <Text style={styles.itemText}>{n.body}</Text>
                            <Text style={styles.itemDate}>{new Date(n.created_at).toLocaleDateString()}</Text>
                            {n.details && (
                              <>
                                <TouchableOpacity onPress={() => toggleBreakdown(n.id)}>
                                  <Text style={styles.breakdownToggle}>
                                    {expandedIds.has(n.id) ? 'Hide breakdown' : 'Show breakdown'}
                                  </Text>
                                </TouchableOpacity>
                                {expandedIds.has(n.id) && <AllocationBreakdown details={n.details} />}
                              </>
                            )}
                          </View>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.itemDismiss} onPress={() => dismiss([n.id])} hitSlop={8}>
                          <X size={16} color={colors.textMuted} />
                        </TouchableOpacity>
                      </View>
                    );
                  })}
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

// AllocationBreakdown renders the structured before/after per-drive quota
// change carried by quota_changed notifications.
function AllocationBreakdown({ details }: { details: StorageAllocationChangeDetails }) {
  const fmt = (bytes: number) => {
    const gb = bytes / GB;
    return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(0)} GB`;
  };
  const byDrive = new Map<string, { name: string; type: string; before: number; after: number }>();
  for (const b of details.before) {
    byDrive.set(b.drive_id, { name: b.server_name, type: b.drive_type, before: b.quota_bytes, after: 0 });
  }
  for (const a of details.after) {
    const cur = byDrive.get(a.drive_id);
    if (cur) cur.after = a.quota_bytes;
    else byDrive.set(a.drive_id, { name: a.server_name, type: a.drive_type, before: 0, after: a.quota_bytes });
  }
  return (
    <View style={styles.breakdownBox}>
      {details.reason ? <Text style={styles.breakdownReason}>{details.reason}</Text> : null}
      {[...byDrive.values()].map((d, i) => (
        <Text key={i} style={styles.breakdownLine}>
          {d.name} ({d.type === 'nvme' ? 'Fast' : 'Standard'}): {fmt(d.before)} → {fmt(d.after)}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  pageTitle: { fontSize: 18, fontWeight: '600', color: colors.textPrimary, marginBottom: spacing.md },

  emptyCard: { padding: spacing.lg, alignItems: 'center' },
  emptyText: { fontSize: 14, color: colors.textMuted },

  categoryHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.background, paddingHorizontal: spacing.sm, paddingVertical: 8,
  },
  categoryToggle: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  categoryTitle: { fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.8 },
  dismissAll: { fontSize: 10, fontWeight: '500', color: colors.textMuted },

  itemWrap: { flexDirection: 'row', alignItems: 'stretch', borderTopWidth: 1, borderTopColor: colors.divider },
  itemBody: { flex: 1, flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: 10 },
  itemIcon: {
    width: 30, height: 30, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  itemTitle: { fontSize: 14, fontWeight: '500', color: colors.textPrimary },
  itemText: { fontSize: 12, color: colors.textSecondary, marginTop: 1, lineHeight: 17 },
  itemDate: { fontSize: 10, color: colors.textMuted, marginTop: 2 },
  itemDismiss: { justifyContent: 'center', paddingHorizontal: spacing.sm },

  breakdownToggle: { fontSize: 11, fontWeight: '500', color: colors.primary, marginTop: 4 },
  breakdownBox: {
    backgroundColor: colors.background, borderRadius: radius.sm,
    padding: spacing.sm, marginTop: 4,
  },
  breakdownReason: { fontSize: 11, color: colors.textSecondary, fontStyle: 'italic', marginBottom: 2 },
  breakdownLine: { fontSize: 11, color: colors.textSecondary, lineHeight: 16 },
});
