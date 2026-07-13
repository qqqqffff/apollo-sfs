import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { HardDrive, Receipt, Rocket, Zap } from 'lucide-react-native';
import {
  capturePayRemainingWalletOrder,
  createPayRemainingWalletOrder,
  formatCents,
  listMyExpansionRequests,
  listMyOrders,
  payRemainingByApplePay,
  type ExpansionRequest,
  type UserOrder,
} from '../api/billing';
import { listMySubscriptions, type PremiumSubscriptionOrder } from '../api/payments';
import { revertAdminOrderAllocation } from '../api/admin';
import { canMakeApplePayments, requestApplePayment } from '../services/nativeApplePay';
import { APPLE_PAY_MERCHANT_ID, API_BASE_URL } from '../config';
import { useAuth } from '../context/AuthContext';
import { card, colors, radius, spacing } from '../theme';

type Tab = 'storage' | 'requests' | 'premium';

const TIB = 1024 ** 4;
const DAY_MS = 24 * 60 * 60 * 1000;
// Mirrors allocationRevertDays in api/routes/orders/handler.go — captured
// sandbox orders' grants auto-revert 7 calendar days after capture (legacy
// one-time flow only, not subscriptions).
const ALLOCATION_REVERT_DAYS = 7;

function cleanupDueAt(capturedAt: string): Date {
  return new Date(new Date(capturedAt).getTime() + ALLOCATION_REVERT_DAYS * DAY_MS);
}

function fmtCountdown(dueAt: Date): string {
  const msLeft = dueAt.getTime() - Date.now();
  if (msLeft <= 0) return 'cleanup pending';
  const days = Math.floor(msLeft / DAY_MS);
  const hours = Math.floor((msLeft % DAY_MS) / (60 * 60 * 1000));
  const minutes = Math.floor((msLeft % (60 * 60 * 1000)) / (60 * 1000));
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatCapacity(bytes: number): string {
  if (bytes >= 1024 * TIB) return `${(bytes / (1024 * TIB)).toFixed(1).replace(/\.0$/, '')} PB`;
  if (bytes >= TIB) return `${(bytes / TIB).toFixed(1).replace(/\.0$/, '')} TB`;
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}

const METHOD_LABELS: Record<string, string> = {
  paypal: 'PayPal',
  card: 'Card',
  hosted_card: 'Card',
  apple_pay: 'Apple Pay',
  google_pay: 'Google Pay',
  invoice: 'Invoice',
};

const PLAN_LABELS: Record<string, string> = { monthly: 'Monthly', annual: 'Annual' };

const SUBSCRIPTION_STATUS_META: Record<string, { label: string; color: string }> = {
  approval_pending: { label: 'awaiting approval', color: colors.warning },
  active: { label: 'active', color: colors.success },
  suspended: { label: 'suspended', color: colors.warning },
  cancelled: { label: 'cancelled', color: colors.textMuted },
  expired: { label: 'expired', color: colors.textMuted },
};

type Group = 'action' | 'pending' | 'progress' | 'completed' | 'closed';

const GROUP_META: Record<Group, { title: string; hint: string }> = {
  action:    { title: 'Pending your action', hint: 'These need something from you to move forward.' },
  pending:   { title: 'Pending approval',    hint: 'Waiting on our team to review or approve.' },
  progress:  { title: 'In progress',         hint: 'Approved — capacity expansion under way.' },
  completed: { title: 'Completed',           hint: '' },
  closed:    { title: 'Closed',              hint: 'Expired, refunded or rejected requests.' },
};

function requestGroup(r: ExpansionRequest): Group {
  switch (r.status) {
    case 'invoice_sent':
    case 'expanded':
      return 'action';
    case 'opened':
    case 'accepted':
      return 'pending';
    case 'approved':
      return 'progress';
    case 'completed':
      return 'completed';
    default:
      return 'closed';
  }
}

const REQUEST_STATUS_META: Record<ExpansionRequest['status'], { label: string; color: string; bg: string }> = {
  opened:       { label: 'Awaiting review',  color: colors.amberDeep, bg: colors.warningBg },
  invoice_sent: { label: 'Invoice sent',     color: colors.primary,   bg: colors.infoBg },
  accepted:     { label: 'Invoice accepted', color: colors.primary,   bg: colors.infoBg },
  approved:     { label: 'Approved',         color: colors.primary,   bg: colors.infoBg },
  expanded:     { label: 'Balance due',      color: colors.sandbox,   bg: colors.sandboxBg },
  completed:    { label: 'Completed',        color: colors.success,   bg: colors.successBg },
  expired:      { label: 'Expired',          color: colors.textMuted, bg: colors.divider },
  refunded:     { label: 'Refunded',         color: colors.textMuted, bg: colors.divider },
  rejected:     { label: 'Rejected',         color: colors.error,     bg: colors.errorBg },
};

// PremiumRow normalizes legacy one-time premium orders and the newer
// premium_subscriptions rows into one shape — same as the web orders page.
interface PremiumRow {
  key: string;
  title: string;
  dateMs: number;
  dateLabel: string;
  paymentMethod: string;
  reference: string;
  amountCents: number;
  environment: 'sandbox' | 'live';
  statusLabel: string;
  statusColor: string;
  premiumUntilLabel: string;
  nextPaymentLabel: string;
  legacyOrder?: UserOrder;
}

function buildPremiumRows(orderList: UserOrder[], subscriptions: PremiumSubscriptionOrder[]): PremiumRow[] {
  const legacyRows: PremiumRow[] = orderList
    .filter((o) => o.type === 'premium')
    .map((o) => {
      const dateMs = new Date(o.captured_at ?? o.created_at).getTime();
      return {
        key: `legacy-${o.id}`,
        title: 'Premium (lifetime purchase)',
        dateMs,
        dateLabel: new Date(dateMs).toLocaleDateString(),
        paymentMethod: METHOD_LABELS[o.payment_method] ?? o.payment_method,
        reference: o.invoice_number,
        amountCents: o.amount_cents,
        environment: o.environment,
        statusLabel: o.status,
        statusColor: o.status === 'captured' ? colors.success : o.status === 'refunded' ? colors.textMuted : colors.warning,
        premiumUntilLabel: 'Lifetime',
        nextPaymentLabel: '—',
        legacyOrder: o,
      };
    });

  const subscriptionRows: PremiumRow[] = subscriptions.map((s) => {
    const dateMs = new Date(s.created_at).getTime();
    const periodEndLabel = s.current_period_end ? new Date(s.current_period_end).toLocaleDateString() : '—';
    const meta = SUBSCRIPTION_STATUS_META[s.status] ?? { label: s.status, color: colors.textMuted };
    return {
      key: `sub-${s.id}`,
      title: `${PLAN_LABELS[s.plan] ?? s.plan} Premium subscription`,
      dateMs,
      dateLabel: new Date(dateMs).toLocaleDateString(),
      paymentMethod: METHOD_LABELS[s.payment_method] ?? s.payment_method,
      reference: s.reference,
      amountCents: s.amount_cents,
      environment: s.environment,
      statusLabel: meta.label,
      statusColor: meta.color,
      premiumUntilLabel: periodEndLabel,
      nextPaymentLabel: s.status === 'active' ? periodEndLabel : '—',
    };
  });

  return [...legacyRows, ...subscriptionRows].sort((a, b) => b.dateMs - a.dateMs);
}

export default function OrdersScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { profile } = useAuth();
  const admin = !!profile?.is_admin;

  const initialTab: Tab =
    route.params?.tab === 'premium' ? 'premium'
    : route.params?.tab === 'requests' ? 'requests'
    : 'storage';
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  const [requests, setRequests] = useState<ExpansionRequest[]>([]);
  const [orders, setOrders] = useState<UserOrder[]>([]);
  const [subscriptions, setSubscriptions] = useState<PremiumSubscriptionOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [payTarget, setPayTarget] = useState<ExpansionRequest | null>(null);
  const [autoOpened, setAutoOpened] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [reqs, ords, subs] = await Promise.all([
        listMyExpansionRequests().catch(() => [] as ExpansionRequest[]),
        listMyOrders().catch(() => [] as UserOrder[]),
        listMySubscriptions().catch(() => [] as PremiumSubscriptionOrder[]),
      ]);
      setRequests(reqs);
      setOrders(ords);
      setSubscriptions(subs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Deep link: ?pay=<request id> opens the balance form once data arrives —
  // mirrors the payment-required notification on the web.
  useEffect(() => {
    const pay = route.params?.pay;
    if (pay && !autoOpened && requests.length > 0) {
      const target = requests.find((r) => r.id === pay && r.status === 'expanded');
      if (target) {
        setPayTarget(target);
        setAutoOpened(true);
      }
    }
  }, [route.params?.pay, requests, autoOpened]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  // Admin-only: undoes a sandbox test order's local quota/premium grant, no
  // PayPal call. Only admins can create sandbox orders, so this only ever
  // shows on an admin's own orders.
  const handleRevert = async (o: UserOrder) => {
    setReverting(o.id);
    try {
      await revertAdminOrderAllocation(o.type, o.id);
      Alert.alert('Allocation reverted');
      load();
    } catch (e: any) {
      Alert.alert('Revert failed', e?.response?.data?.error ?? e?.message ?? 'Unknown error');
    } finally {
      setReverting(null);
    }
  };

  const groups: Group[] = ['action', 'pending', 'progress', 'completed', 'closed'];
  const grouped = new Map<Group, ExpansionRequest[]>();
  for (const r of requests) {
    const g = requestGroup(r);
    grouped.set(g, [...(grouped.get(g) ?? []), r]);
  }

  const storageOrders = orders.filter((o) => o.type === 'storage');
  const premiumRows = buildPremiumRows(orders, subscriptions);

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={styles.headerRow}>
          <Text style={styles.pageTitle}>My orders</Text>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <Text style={styles.backLink}>Back to profile</Text>
          </TouchableOpacity>
        </View>

        {/* Sub tabs — Storage / Requests / Premium, same as the web */}
        <View style={styles.tabRow}>
          {([
            { key: 'storage', label: 'Storage' },
            { key: 'requests', label: 'Requests' },
            { key: 'premium', label: 'Premium' },
          ] as { key: Tab; label: string }[]).map(({ key, label }) => (
            <TouchableOpacity
              key={key}
              style={[styles.tabBtn, activeTab === key && styles.tabBtnActive]}
              onPress={() => setActiveTab(key)}
            >
              <Text style={[styles.tabText, activeTab === key && styles.tabTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading && <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />}

        {/* ── Requests tab ── */}
        {!loading && activeTab === 'requests' && (
          <>
            {requests.length === 0 && (
              <Text style={styles.emptyText}>
                No expansion or custom capacity requests yet. Requests you submit from the Add
                storage modal will appear here.
              </Text>
            )}
            {groups.map((g) => {
              const items = grouped.get(g);
              if (!items || items.length === 0) return null;
              const meta = GROUP_META[g];
              return (
                <View key={g} style={{ marginBottom: spacing.md }}>
                  <Text style={styles.groupTitle}>{meta.title.toUpperCase()}</Text>
                  {!!meta.hint && <Text style={styles.groupHint}>{meta.hint}</Text>}
                  <View style={card}>
                    {items.map((r, i) => {
                      const statusMeta = REQUEST_STATUS_META[r.status] ?? { label: r.status, color: colors.textMuted, bg: colors.divider };
                      return (
                        <View key={r.id} style={[styles.orderRow, i > 0 && styles.rowBorder]}>
                          <View style={[styles.rowIcon, { backgroundColor: r.storage_type === 'nvme' ? colors.infoBg : colors.warningBg }]}>
                            {r.storage_type === 'nvme'
                              ? <Zap size={14} color={colors.primary} />
                              : <HardDrive size={14} color={colors.warning} />}
                          </View>
                          <View style={{ flex: 1 }}>
                            <View style={styles.titleWrap}>
                              <Text style={styles.rowTitle}>
                                {formatCapacity(r.bytes_requested)} {r.storage_type === 'nvme' ? 'Fast' : 'Standard'} expansion
                                {r.is_custom ? ' (custom)' : ''} — {r.server_name}
                              </Text>
                              <View style={[styles.badge, { backgroundColor: statusMeta.bg }]}>
                                <Text style={[styles.badgeText, { color: statusMeta.color }]}>{statusMeta.label}</Text>
                              </View>
                            </View>
                            <Text style={styles.rowMeta}>
                              requested {new Date(r.created_at).toLocaleDateString()}
                              {r.status === 'expanded' && ` · balance ${formatCents(r.full_price_cents - r.deposit_amount_cents)}`}
                            </Text>
                            <View style={styles.rowActions}>
                              {r.status === 'expanded' && r.full_price_cents > r.deposit_amount_cents && (
                                <TouchableOpacity style={styles.payBtn} onPress={() => setPayTarget(r)}>
                                  <Text style={styles.payBtnText}>Pay balance</Text>
                                </TouchableOpacity>
                              )}
                              {r.status === 'invoice_sent' && (
                                r.invoice_review_token ? (
                                  <TouchableOpacity
                                    style={styles.payBtn}
                                    onPress={() => Linking.openURL(`${API_BASE_URL}/invoice/${r.invoice_review_token}`)}
                                  >
                                    <Text style={styles.payBtnText}>Review invoice</Text>
                                  </TouchableOpacity>
                                ) : (
                                  <Text style={[styles.rowMeta, { color: colors.warning }]}>
                                    Check your email for the invoice
                                  </Text>
                                )
                              )}
                              {r.invoice_review_token && r.status !== 'invoice_sent' && (
                                <TouchableOpacity onPress={() => Linking.openURL(`${API_BASE_URL}/invoice/${r.invoice_review_token}`)}>
                                  <Text style={styles.linkText}>View invoice</Text>
                                </TouchableOpacity>
                              )}
                            </View>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </>
        )}

        {/* ── Storage tab ── */}
        {!loading && activeTab === 'storage' && (
          <>
            {storageOrders.length === 0 && (
              <Text style={styles.emptyText}>
                No storage purchases yet. Add storage from your profile page to see it here.
              </Text>
            )}
            {storageOrders.length > 0 && (
              <>
                <Text style={styles.groupTitle}>PAYMENTS</Text>
                <View style={card}>
                  {storageOrders.map((o, i) => (
                    <View key={`${o.type}-${o.id}`} style={[styles.orderRow, i > 0 && styles.rowBorder]}>
                      <View style={[styles.rowIcon, { backgroundColor: colors.divider }]}>
                        <Receipt size={14} color={colors.textSecondary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.rowTitle}>
                          {formatCapacity(o.bytes_added ?? 0)} {o.storage_type === 'nvme' ? 'Fast' : 'Standard'} storage
                          {o.server_name ? ` — ${o.server_name}` : ''}
                        </Text>
                        <Text style={styles.rowMeta}>
                          {new Date(o.captured_at ?? o.created_at).toLocaleDateString()} · {METHOD_LABELS[o.payment_method] ?? o.payment_method} · {o.invoice_number}
                        </Text>
                      </View>
                      <OrderAmountColumn
                        order={o}
                        admin={admin}
                        reverting={reverting === o.id}
                        onRevert={() => handleRevert(o)}
                      />
                    </View>
                  ))}
                </View>
              </>
            )}
          </>
        )}

        {/* ── Premium tab ── */}
        {!loading && activeTab === 'premium' && (
          <>
            {premiumRows.length === 0 && (
              <Text style={styles.emptyText}>
                No premium purchases yet. Subscribe from your profile page to see it here.
              </Text>
            )}
            {premiumRows.length > 0 && (
              <>
                <Text style={styles.groupTitle}>PREMIUM SUBSCRIPTIONS</Text>
                <View style={card}>
                  {premiumRows.map((row, i) => (
                    <View key={row.key} style={[styles.orderRow, i > 0 && styles.rowBorder]}>
                      <View style={[styles.rowIcon, { backgroundColor: colors.warningBg }]}>
                        <Rocket size={14} color={colors.warning} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.rowTitle}>{row.title}</Text>
                        <Text style={styles.rowMeta}>
                          {row.dateLabel} · {row.paymentMethod} · {row.reference}
                        </Text>
                        <Text style={styles.rowMeta}>
                          Premium until: {row.premiumUntilLabel} · Next payment: {row.nextPaymentLabel}
                        </Text>
                      </View>
                      <View style={styles.amountCol}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Text style={styles.amountText}>{formatCents(row.amountCents)}</Text>
                          {row.environment === 'sandbox' && <SandboxBadge />}
                        </View>
                        <Text style={[styles.statusText, { color: row.statusColor }]}>{row.statusLabel.toUpperCase()}</Text>
                        {row.legacyOrder && row.environment === 'sandbox' && row.legacyOrder.status === 'captured' && !row.legacyOrder.allocation_reverted_at && row.legacyOrder.captured_at && (
                          <Text style={styles.revertCountdown}>
                            Auto-reverts in {fmtCountdown(cleanupDueAt(row.legacyOrder.captured_at))}
                          </Text>
                        )}
                        {admin && row.legacyOrder && row.environment === 'sandbox' && row.legacyOrder.status === 'captured' && (
                          row.legacyOrder.allocation_reverted_at ? (
                            <Text style={styles.rowMeta}>Allocation reverted</Text>
                          ) : (
                            <TouchableOpacity
                              style={styles.revertBtn}
                              disabled={reverting === row.legacyOrder.id}
                              onPress={() => handleRevert(row.legacyOrder!)}
                            >
                              <Text style={styles.revertBtnText}>
                                {reverting === row.legacyOrder.id ? 'Reverting…' : 'Revert allocation'}
                              </Text>
                            </TouchableOpacity>
                          )
                        )}
                      </View>
                    </View>
                  ))}
                </View>
              </>
            )}
          </>
        )}
      </ScrollView>

      {payTarget && (
        <PayRemainingSheet
          request={payTarget}
          onClose={() => setPayTarget(null)}
          onPaid={() => {
            setPayTarget(null);
            load();
          }}
        />
      )}
    </>
  );
}

function SandboxBadge() {
  return (
    <View style={styles.sandboxBadge}>
      <Text style={styles.sandboxBadgeText}>SANDBOX</Text>
    </View>
  );
}

function OrderAmountColumn({ order: o, admin, reverting, onRevert }: {
  order: UserOrder;
  admin: boolean;
  reverting: boolean;
  onRevert: () => void;
}) {
  return (
    <View style={styles.amountCol}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Text style={styles.amountText}>{formatCents(o.amount_cents)}</Text>
        {o.environment === 'sandbox' && <SandboxBadge />}
      </View>
      <Text style={[
        styles.statusText,
        { color: o.status === 'captured' ? colors.success : o.status === 'refunded' ? colors.textMuted : colors.warning },
      ]}>
        {o.status.toUpperCase()}
      </Text>
      {o.environment === 'sandbox' && o.status === 'captured' && !o.allocation_reverted_at && o.captured_at && (
        <Text style={styles.revertCountdown}>
          Auto-reverts in {fmtCountdown(cleanupDueAt(o.captured_at))}
        </Text>
      )}
      {admin && o.environment === 'sandbox' && o.status === 'captured' && (
        o.allocation_reverted_at ? (
          <Text style={styles.rowMeta}>Allocation reverted</Text>
        ) : (
          <TouchableOpacity style={styles.revertBtn} disabled={reverting} onPress={onRevert}>
            <Text style={styles.revertBtnText}>{reverting ? 'Reverting…' : 'Revert allocation'}</Text>
          </TouchableOpacity>
        )
      )}
    </View>
  );
}

// PayRemainingSheet is the mobile counterpart of the web's PayRemainingModal:
// pays the (full − deposit) balance after an admin marks the capacity
// expanded, via PayPal (browser approval, same verify pattern as the storage
// modal) or Apple Pay.
function PayRemainingSheet({ request, onClose, onPaid }: {
  request: ExpansionRequest;
  onClose: () => void;
  onPaid: () => void;
}) {
  const remainingCents = request.full_price_cents - request.deposit_amount_cents;
  type State = 'selecting' | 'processing' | 'awaiting' | 'verifying';
  const [state, setState] = useState<State>('selecting');
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);
  const [canApplePay, setCanApplePay] = useState(false);
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      canMakeApplePayments().then(setCanApplePay).catch(() => setCanApplePay(false));
    }
  }, []);

  useEffect(() => {
    if (state !== 'awaiting') return;
    const sub = AppState.addEventListener('change', (next) => {
      if (appStateRef.current.match(/inactive|background/) && next === 'active') {
        handleVerify();
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, pendingOrderId]);

  const handlePayPal = async () => {
    setState('processing');
    try {
      const res = await createPayRemainingWalletOrder(request.id);
      setPendingOrderId(res.order_id);
      await Linking.openURL(res.approval_url);
      setState('awaiting');
    } catch (e: any) {
      setState('selecting');
      Alert.alert('Could not start PayPal checkout', e?.response?.data?.error ?? e?.message ?? 'Unknown error');
    }
  };

  const handleVerify = async () => {
    if (!pendingOrderId) return;
    setState('verifying');
    try {
      await capturePayRemainingWalletOrder(request.id, pendingOrderId);
      Alert.alert('Payment received', 'Your remaining balance is paid — the capacity is yours.');
      onPaid();
    } catch (e: any) {
      setState('awaiting');
      Alert.alert('Payment not found', e?.response?.data?.error ?? e?.message ?? 'Unknown error');
    }
  };

  const handleApplePay = async () => {
    setState('processing');
    try {
      const token = await requestApplePayment(
        (remainingCents / 100).toFixed(2),
        'USD',
        APPLE_PAY_MERCHANT_ID,
        `Apollo SFS expansion balance`,
      );
      await payRemainingByApplePay(request.id, token);
      Alert.alert('Payment received', 'Your remaining balance is paid — the capacity is yours.');
      onPaid();
    } catch (e: any) {
      setState('selecting');
      if ((e as any).code !== 'CANCELLED') {
        Alert.alert('Apple Pay failed', e?.response?.data?.error ?? e?.message ?? 'Unknown error');
      }
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={() => state === 'selecting' && onClose()}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.sheetTitle}>Pay remaining balance</Text>
          <Text style={styles.sheetBody}>
            {formatCapacity(request.bytes_requested)} {request.storage_type === 'nvme' ? 'Fast' : 'Standard'} expansion — {request.server_name}
          </Text>
          <View style={styles.balanceBox}>
            <Text style={styles.balanceLabel}>Balance due</Text>
            <Text style={styles.balanceValue}>{formatCents(remainingCents)}</Text>
          </View>

          {state === 'selecting' && (
            <>
              {Platform.OS === 'ios' && canApplePay && (
                <TouchableOpacity style={styles.applePayBtn} onPress={handleApplePay}>
                  <Text style={styles.applePayText}> Pay</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.paypalBtn} onPress={handlePayPal}>
                <Text style={styles.paypalPay}>Pay</Text>
                <Text style={styles.paypalPal}>Pal</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}

          {state === 'processing' && <ActivityIndicator color={colors.primary} style={{ marginVertical: spacing.md }} />}

          {state === 'awaiting' && (
            <>
              <View style={styles.awaitingBanner}>
                <Text style={styles.awaitingText}>
                  PayPal opened in your browser. Complete the payment there, then return here.
                </Text>
              </View>
              <TouchableOpacity style={styles.verifyBtn} onPress={handleVerify}>
                <Text style={styles.verifyBtnText}>I've completed payment</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}

          {state === 'verifying' && (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginVertical: spacing.md }}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.sheetBody}>Verifying payment…</Text>
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },

  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  pageTitle: { fontSize: 18, fontWeight: '600', color: colors.textPrimary },
  backLink: { fontSize: 12, color: colors.primary },

  tabRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: spacing.md },
  tabBtn: { paddingHorizontal: spacing.md, paddingVertical: 10, marginBottom: -1 },
  tabBtnActive: { borderBottomWidth: 2, borderBottomColor: colors.primary },
  tabText: { fontSize: 14, fontWeight: '500', color: colors.textSecondary },
  tabTextActive: { color: colors.primary },

  emptyText: { fontSize: 13, color: colors.textMuted, lineHeight: 19 },

  groupTitle: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.8, marginBottom: 2 },
  groupHint: { fontSize: 11, color: colors.textMuted, marginBottom: spacing.xs },

  orderRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: 12 },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.divider },
  rowIcon: {
    width: 28, height: 28, borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  rowTitle: { fontSize: 13, fontWeight: '500', color: colors.textPrimary, flexShrink: 1 },
  rowMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 6, flexWrap: 'wrap' },

  badge: { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },

  payBtn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 6 },
  payBtnText: { fontSize: 12, fontWeight: '600', color: '#fff' },
  linkText: { fontSize: 12, color: colors.primary },

  amountCol: { alignItems: 'flex-end', gap: 2, maxWidth: 150 },
  amountText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  statusText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },

  sandboxBadge: { backgroundColor: colors.sandboxBg, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  sandboxBadgeText: { fontSize: 8, fontWeight: '700', color: colors.sandbox, letterSpacing: 0.4 },

  revertCountdown: { fontSize: 10, color: colors.sandbox },
  revertBtn: {
    borderWidth: 1, borderColor: '#e9d5ff', borderRadius: radius.sm,
    paddingHorizontal: 6, paddingVertical: 3, marginTop: 2,
  },
  revertBtnText: { fontSize: 10, color: colors.sandbox },

  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: spacing.md },
  sheet: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: spacing.lg, width: '100%', maxWidth: 420,
  },
  sheetTitle: { fontSize: 16, fontWeight: '600', color: colors.textPrimary, marginBottom: 4 },
  sheetBody: { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },
  balanceBox: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.infoBg, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: 10, marginVertical: spacing.md,
  },
  balanceLabel: { fontSize: 13, fontWeight: '500', color: colors.primaryHover },
  balanceValue: { fontSize: 16, fontWeight: '700', color: colors.primaryHover },

  applePayBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#000', borderRadius: radius.md,
    paddingVertical: 13, marginBottom: spacing.sm,
  },
  applePayText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  paypalBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#003087', borderRadius: radius.md,
    paddingVertical: 13, marginBottom: spacing.sm,
  },
  paypalPay: { fontSize: 15, fontWeight: '400', color: '#009cde' },
  paypalPal: { fontSize: 15, fontWeight: '800', color: '#009cde' },
  cancelBtn: { paddingVertical: 10, alignItems: 'center' },
  cancelBtnText: { fontSize: 14, color: colors.textSecondary },

  awaitingBanner: { backgroundColor: colors.infoBg, borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.sm },
  awaitingText: { fontSize: 13, color: colors.info, lineHeight: 18, textAlign: 'center' },
  verifyBtn: { backgroundColor: colors.success, borderRadius: radius.md, paddingVertical: 13, alignItems: 'center', marginBottom: spacing.sm },
  verifyBtnText: { fontSize: 15, fontWeight: '600', color: '#fff' },
});
