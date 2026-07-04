import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ChevronDown, ChevronUp, CreditCard, HardDrive, Server, X, Zap } from 'lucide-react-native';
import {
  captureStorageOrder,
  captureHostedCardStorageOrder,
  captureHostedCardExpansionOrder,
  createApplePayStorageOrder,
  createGooglePayStorageOrder,
  createStorageOrder,
  captureExpansionOrder,
  createApplePayExpansionOrder,
  createGooglePayExpansionOrder,
  createExpansionOrder,
  type StorageType,
} from '../api/billing';
import { listServersWithPing, type ServerInfoWithPing } from '../api/storage';
import { canMakeApplePayments, requestApplePayment } from '../services/nativeApplePay';
import { canMakeGooglePayments, requestGooglePayment } from '../services/nativeGooglePay';
import { APPLE_PAY_MERCHANT_ID, PAYPAL_MERCHANT_ID } from '../config';
import { colors, radius, shadow, spacing } from '../theme';
import PayPalCardSheet from './PayPalCardSheet';

// ── Helpers ────────────────────────────────────────────────────────────────────

function apiError(e: any): string {
  const status: number | undefined = e?.response?.status;
  const body = e?.response?.data;
  const bodyMsg: string | undefined =
    typeof body === 'string' ? body :
    body?.error ?? body?.message ?? body?.detail ?? undefined;
  const label = status ? `[${status}] ` : '';
  const msg = bodyMsg ?? e?.message ?? 'Unknown error';
  return label + msg;
}

// ── Plans ──────────────────────────────────────────────────────────────────────

interface Plan {
  id: string;
  label: string;
  addBytes: number;
  price: Record<StorageType, string>;
  amount: Record<StorageType, string>;
}

const PLANS: Plan[] = [
  { id: '64gb',  label: '64 GB',  addBytes: 64   * 1024 ** 3, price: { nvme: '$30',  hdd: '$20'  }, amount: { nvme: '30.00',  hdd: '20.00'  } },
  { id: '128gb', label: '128 GB', addBytes: 128  * 1024 ** 3, price: { nvme: '$50',  hdd: '$30'  }, amount: { nvme: '50.00',  hdd: '30.00'  } },
  { id: '256gb', label: '256 GB', addBytes: 256  * 1024 ** 3, price: { nvme: '$80',  hdd: '$50'  }, amount: { nvme: '80.00',  hdd: '50.00'  } },
  { id: '512gb', label: '512 GB', addBytes: 512  * 1024 ** 3, price: { nvme: '$150', hdd: '$80'  }, amount: { nvme: '150.00', hdd: '80.00'  } },
  { id: '1tb',   label: '1 TB',   addBytes: 1024 * 1024 ** 3, price: { nvme: '$250', hdd: '$120' }, amount: { nvme: '250.00', hdd: '120.00' } },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(0)} MB`;
  if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(0)} GB`;
  return `${(b / 1024 ** 4).toFixed(1)} TB`;
}

// ── Types ──────────────────────────────────────────────────────────────────────

type PurchaseState = 'selecting' | 'card_form' | 'processing' | 'awaiting' | 'verifying' | 'expansion_success';

interface Props {
  visible: boolean;
  quotaBytes: number;
  usedBytes: number;
  onPurchased: (newQuotaBytes: number) => void;
  onExpansionRequested?: (requestId: string, expiresAt: string) => void;
  onClose: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function StorageUpgradeModal({
  visible, quotaBytes, usedBytes, onPurchased, onExpansionRequested, onClose,
}: Props) {
  const [storageType, setStorageType] = useState<StorageType>('nvme');
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [purchaseState, setPurchaseState] = useState<PurchaseState>('selecting');
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);

  const [servers, setServers] = useState<ServerInfoWithPing[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [serverListOpen, setServerListOpen] = useState(false);
  const [serversLoading, setServersLoading] = useState(false);
  const [serversError, setServersError] = useState<string | null>(null);

  const [canApplePay, setCanApplePay] = useState(false);
  const [canGooglePay, setCanGooglePay] = useState(false);

  const [, setExpansionRequestId] = useState<string | null>(null);
  const [expansionExpiresAt, setExpansionExpiresAt] = useState<string | null>(null);


  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    if (!visible) return;
    setStorageType('nvme');
    setSelectedPlanId(null);
    setPurchaseState('selecting');
    setPendingOrderId(null);
    setExpansionRequestId(null);
    setExpansionExpiresAt(null);
    setServerListOpen(false);

    if (Platform.OS === 'ios') {
      canMakeApplePayments().then(setCanApplePay).catch(() => setCanApplePay(false));
    } else if (Platform.OS === 'android') {
      canMakeGooglePayments(PAYPAL_MERCHANT_ID).then(setCanGooglePay).catch(() => setCanGooglePay(false));
    }

    setServersLoading(true);
    setServersError(null);
    listServersWithPing()
      .then((list) => {
        setServers(list);
        setSelectedServerId((prev) => {
          if (list.length === 0) return null;
          const stillPresent = list.some((s) => s.id === prev);
          return stillPresent ? prev : list[0].id;
        });
      })
      .catch((e: any) => {
        setServersError(e?.response?.data?.error ?? e?.message ?? 'Could not load servers.');
      })
      .finally(() => setServersLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (purchaseState !== 'awaiting') return;
    const sub = AppState.addEventListener('change', (next) => {
      if (appStateRef.current.match(/inactive|background/) && next === 'active') {
        handleVerifyPayPal();
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchaseState, pendingOrderId]);

  const selectedPlan = PLANS.find((p) => p.id === selectedPlanId);
  const selectedServer = servers.find((s) => s.id === selectedServerId);
  // Expansion if: the server's drive type doesn't match the selected storage type,
  // OR the plan exceeds the server's available capacity.
  const serverTypeMismatch = !!(selectedServer && (
    (storageType === 'nvme' && selectedServer.drive_type !== 'nvme') ||
    (storageType === 'hdd'  && selectedServer.drive_type !== 'hdd')
  ));
  const isExpansion = !!(selectedPlan && selectedServer && (
    serverTypeMismatch || selectedPlan.addBytes > selectedServer.available_bytes
  ));

  // Aggregate fast (NVMe) and standard (HDD) available bytes across all servers.
  const fastAvailable  = servers.filter((s) => s.drive_type === 'nvme').reduce((sum, s) => sum + s.available_bytes, 0);
  const slowAvailable  = servers.filter((s) => s.drive_type === 'hdd').reduce((sum, s) => sum + s.available_bytes, 0);

  const depositDisplay = selectedPlan
    ? `$${(Math.round(parseFloat(selectedPlan.amount[storageType]) * 100 / 2) / 100).toFixed(2)}`
    : '';

  const cardLabel = selectedPlan
    ? isExpansion
      ? `${selectedPlan.label} Expansion Deposit — ${depositDisplay}`
      : `${selectedPlan.label} — ${selectedPlan.price[storageType]}`
    : '';

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleApplePay = async () => {
    if (!selectedPlanId || !selectedPlan) return;
    setPurchaseState('processing');
    const amount = isExpansion
      ? (Math.round(parseFloat(selectedPlan.amount[storageType]) * 100 / 2) / 100).toFixed(2)
      : selectedPlan.amount[storageType];
    try {
      const token = await requestApplePayment(
        amount, 'USD', APPLE_PAY_MERCHANT_ID,
        isExpansion ? `Apollo SFS ${selectedPlan.label} Expansion Deposit` : `Apollo SFS ${selectedPlan.label} Storage`,
      );
      if (isExpansion && selectedServerId) {
        const { expansion_request_id, expires_at } = await createApplePayExpansionOrder(selectedPlanId, storageType, selectedServerId, token);
        setExpansionRequestId(expansion_request_id);
        setExpansionExpiresAt(expires_at);
        setPurchaseState('expansion_success');
        onExpansionRequested?.(expansion_request_id, expires_at);
      } else {
        const { new_quota_bytes } = await createApplePayStorageOrder(selectedPlanId, storageType, token);
        onPurchased(new_quota_bytes);
      }
    } catch (e: any) {
      if ((e as any).code !== 'CANCELLED') Alert.alert('Apple Pay failed', apiError(e));
      setPurchaseState('selecting');
    }
  };

  const handleGooglePay = async () => {
    if (!selectedPlanId || !selectedPlan) return;
    setPurchaseState('processing');
    const amount = isExpansion
      ? (Math.round(parseFloat(selectedPlan.amount[storageType]) * 100 / 2) / 100).toFixed(2)
      : selectedPlan.amount[storageType];
    try {
      const token = await requestGooglePayment(amount, 'USD', 'Apollo SFS', PAYPAL_MERCHANT_ID);
      if (isExpansion && selectedServerId) {
        const { expansion_request_id, expires_at } = await createGooglePayExpansionOrder(selectedPlanId, storageType, selectedServerId, token);
        setExpansionRequestId(expansion_request_id);
        setExpansionExpiresAt(expires_at);
        setPurchaseState('expansion_success');
        onExpansionRequested?.(expansion_request_id, expires_at);
      } else {
        const { new_quota_bytes } = await createGooglePayStorageOrder(selectedPlanId, storageType, token);
        onPurchased(new_quota_bytes);
      }
    } catch (e: any) {
      if ((e as any).code !== 'CANCELLED') Alert.alert('Google Pay failed', apiError(e));
      setPurchaseState('selecting');
    }
  };

  const handleCardPay = () => {
    if (!selectedPlanId) return;
    setPurchaseState('card_form');
  };

  const handleCardSuccess = async (orderId: string) => {
    if (!selectedPlanId) return;
    setPurchaseState('verifying');
    try {
      if (isExpansion && selectedServerId) {
        const { expansion_request_id, expires_at } = await captureHostedCardExpansionOrder(orderId, selectedPlanId, storageType, selectedServerId);
        setExpansionRequestId(expansion_request_id);
        setExpansionExpiresAt(expires_at);
        setPurchaseState('expansion_success');
        onExpansionRequested?.(expansion_request_id, expires_at);
      } else {
        const { new_quota_bytes } = await captureHostedCardStorageOrder(orderId, selectedPlanId, storageType);
        onPurchased(new_quota_bytes);
      }
    } catch (e: any) {
      console.error('[handleCardSuccess] capture failed:', apiError(e));
      setPurchaseState('selecting');
      Alert.alert('Payment capture failed', apiError(e));
    }
  };

  const handlePayPal = async () => {
    if (!selectedPlanId) return;
    setPurchaseState('processing');
    try {
      const res = isExpansion && selectedServerId
        ? await createExpansionOrder(selectedPlanId, storageType, selectedServerId)
        : await createStorageOrder(selectedPlanId, storageType);
      setPendingOrderId(res.order_id);
      if (!(await Linking.canOpenURL(res.approval_url))) throw new Error('Cannot open PayPal URL');
      await Linking.openURL(res.approval_url);
      setPurchaseState('awaiting');
    } catch (e: any) {
      console.error('[handlePayPal] order creation failed:', apiError(e));
      setPurchaseState('selecting');
      Alert.alert('Could not start PayPal checkout', apiError(e));
    }
  };

  const handleVerifyPayPal = async () => {
    const orderId = pendingOrderId;
    if (!orderId) return;
    setPurchaseState('verifying');
    try {
      if (isExpansion) {
        const { expansion_request_id, expires_at } = await captureExpansionOrder(orderId);
        setExpansionRequestId(expansion_request_id);
        setExpansionExpiresAt(expires_at);
        setPurchaseState('expansion_success');
        onExpansionRequested?.(expansion_request_id, expires_at);
      } else {
        const { new_quota_bytes } = await captureStorageOrder(orderId);
        onPurchased(new_quota_bytes);
      }
    } catch (e: any) {
      console.error('[handleVerifyPayPal] capture failed:', apiError(e));
      setPurchaseState('awaiting');
      Alert.alert('Payment not found', apiError(e));
    }
  };

  const handleClose = () => {
    if (purchaseState === 'processing' || purchaseState === 'verifying') return;
    if (purchaseState === 'awaiting') {
      Alert.alert('Cancel purchase?', 'You have an active PayPal checkout. Cancel it?', [
        { text: 'Keep open', style: 'cancel' },
        { text: 'Cancel', style: 'destructive', onPress: onClose },
      ]);
      return;
    }
    onClose();
  };

  const usedPct = quotaBytes > 0 ? Math.min((usedBytes / quotaBytes) * 100, 100) : 0;
  const isBusy = purchaseState === 'processing' || purchaseState === 'verifying';
  const isSelecting = purchaseState === 'selecting';
  const isExpansionSuccess = purchaseState === 'expansion_success';

  // ── Render ──────────────────────────────────────────────────────────────────

  const cardAmount = selectedPlan
    ? isExpansion
      ? (Math.round(parseFloat(selectedPlan.amount[storageType]) * 100 / 2) / 100).toFixed(2)
      : selectedPlan.amount[storageType]
    : '0.00';

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={styles.root}>

        {/* Card form — rendered inline to avoid iOS double-modal constraint */}
        {purchaseState === 'card_form' && (
          <PayPalCardSheet
            amount={cardAmount}
            currency="USD"
            label={cardLabel}
            onSuccess={handleCardSuccess}
            onError={(msg) => {
              setPurchaseState('selecting');
              Alert.alert('Card payment failed', msg);
            }}
            onCancel={() => setPurchaseState('selecting')}
          />
        )}

        {purchaseState !== 'card_form' && (
          <>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={handleClose} style={styles.closeBtn} hitSlop={12} disabled={isBusy}>
              <X size={20} color={isBusy ? colors.textMuted : colors.textPrimary} strokeWidth={2} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Upgrade Storage</Text>
            <View style={{ width: 36 }} />
          </View>

          <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

            {/* Server selector */}
            <Text style={styles.sectionLabel}>Server location</Text>

            {/* Dropdown trigger */}
            {serversLoading ? (
              <View style={styles.serverTrigger}>
                <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 8 }} />
                <Text style={[styles.serverTriggerName, { color: colors.textMuted }]}>Finding servers…</Text>
              </View>
            ) : serversError ? (
              <View style={[styles.serverTrigger, { borderColor: colors.error }]}>
                <Server size={16} color={colors.error} strokeWidth={1.5} style={{ marginRight: 8 }} />
                <Text style={[styles.serverTriggerName, { color: colors.error, flex: 1 }]}>{serversError}</Text>
              </View>
            ) : (
              <>
                <TouchableOpacity
                  style={[styles.serverTrigger, serverListOpen && styles.serverTriggerOpen]}
                  onPress={() => isSelecting && setServerListOpen((o) => !o)}
                  activeOpacity={0.8}
                  disabled={!isSelecting || servers.length === 0}
                >
                  <Server size={16} color={colors.primary} strokeWidth={1.5} style={{ marginRight: 8 }} />
                  <View style={{ flex: 1 }}>
                    {(() => {
                      const sel = servers.find((s) => s.id === selectedServerId);
                      return sel ? (
                        <>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Text style={styles.serverTriggerName}>{sel.name}</Text>
                            <View style={sel.drive_type === 'nvme' ? styles.driveBadgeFast : styles.driveBadgeSlow}>
                              <Text style={styles.driveBadgeText}>{sel.drive_type === 'nvme' ? 'Fast' : 'Standard'}</Text>
                            </View>
                          </View>
                          <Text style={styles.serverTriggerMeta}>
                            {sel.ping_ms !== null ? `${sel.ping_ms} ms  ·  ` : ''}{formatBytes(sel.available_bytes)} available
                          </Text>
                          <View style={styles.capacityRow}>
                            <Zap size={11} color="#16a34a" strokeWidth={2} />
                            <Text style={styles.capacityLabel}>Fast</Text>
                            <Text style={styles.capacityValue}>{formatBytes(fastAvailable)}</Text>
                            <View style={styles.capacityDot} />
                            <HardDrive size={11} color="#6b7280" strokeWidth={2} />
                            <Text style={styles.capacityLabel}>Standard</Text>
                            <Text style={styles.capacityValue}>{formatBytes(slowAvailable)}</Text>
                          </View>
                        </>
                      ) : (
                        <Text style={styles.serverTriggerName}>No servers available</Text>
                      );
                    })()}
                  </View>
                  {serverListOpen
                    ? <ChevronUp size={16} color={colors.textMuted} />
                    : <ChevronDown size={16} color={colors.textMuted} />
                  }
                </TouchableOpacity>

                {/* Expanded server list */}
                {serverListOpen && (
                  <View style={styles.serverDropdown}>
                    {servers.map((s, idx) => {
                      const sel = s.id === selectedServerId;
                      return (
                        <TouchableOpacity
                          key={s.id}
                          style={[
                            styles.serverDropdownRow,
                            sel && styles.serverDropdownRowActive,
                            idx < servers.length - 1 && styles.serverDropdownRowBorder,
                          ]}
                          onPress={() => { setSelectedServerId(s.id); setServerListOpen(false); }}
                          activeOpacity={0.75}
                        >
                          <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <Text style={[styles.serverDropdownName, sel && styles.serverDropdownNameActive]}>{s.name}</Text>
                              <View style={s.drive_type === 'nvme' ? styles.driveBadgeFast : styles.driveBadgeSlow}>
                                <Text style={styles.driveBadgeText}>{s.drive_type === 'nvme' ? 'Fast' : 'Standard'}</Text>
                              </View>
                            </View>
                            <Text style={styles.serverDropdownMeta}>
                              {s.ping_ms !== null ? `${s.ping_ms} ms  ·  ` : ''}{formatBytes(s.available_bytes)} available
                            </Text>
                          </View>
                          {sel && <View style={styles.serverCheck} />}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                )}
              </>
            )}

            <View style={styles.quotaCard}>
              <Text style={styles.quotaLabel}>Current storage</Text>
              <Text style={styles.quotaValue}>{formatBytes(quotaBytes)}</Text>
              <Text style={styles.quotaSub}>{formatBytes(usedBytes)} used · {usedPct.toFixed(0)}%</Text>
              {quotaBytes > 0 && (
                <View style={styles.miniBar}>
                  <View style={[styles.miniBarFill, { width: `${usedPct}%` as any }]} />
                </View>
              )}
            </View>

            <Text style={styles.sectionLabel}>Storage type</Text>
            <View style={styles.typeToggle}>
              {(['nvme', 'hdd'] as StorageType[]).map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[styles.typeBtn, storageType === t && styles.typeBtnActive]}
                  onPress={() => setStorageType(t)}
                  activeOpacity={0.8}
                  disabled={!isSelecting}
                >
                  {t === 'nvme'
                    ? <Zap size={15} color={storageType === t ? colors.surface : colors.textSecondary} strokeWidth={2} style={{ marginRight: 6 }} />
                    : <HardDrive size={15} color={storageType === t ? colors.surface : colors.textSecondary} strokeWidth={2} style={{ marginRight: 6 }} />
                  }
                  <View>
                    <Text style={[styles.typeBtnLabel, storageType === t && styles.typeBtnLabelActive]}>
                      {t === 'nvme' ? 'Fast' : 'Standard'}
                    </Text>
                    <Text style={[styles.typeBtnSub, storageType === t && styles.typeBtnSubActive]}>
                      {t === 'nvme' ? 'NVMe SSD' : 'HDD'}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.sectionLabel}>Select capacity</Text>
            {PLANS.map((plan) => {
              const sel = selectedPlanId === plan.id;
              const unavailable = !!(selectedServer && (serverTypeMismatch || plan.addBytes > selectedServer.available_bytes));
              return (
                <TouchableOpacity
                  key={plan.id}
                  style={[styles.planCard, sel && styles.planCardSelected, unavailable && !sel && styles.planCardUnavailable]}
                  onPress={() => setSelectedPlanId(plan.id)}
                  activeOpacity={0.8}
                  disabled={!isSelecting}
                >
                  <View style={styles.planLeft}>
                    <Text style={[styles.planLabel, sel && styles.planLabelSelected]}>{plan.label}</Text>
                    {unavailable ? (
                      <Text style={styles.planUnavailableNote}>Server expansion required</Text>
                    ) : (
                      <Text style={styles.planNewTotal}>New total: {formatBytes(quotaBytes + plan.addBytes)}</Text>
                    )}
                  </View>
                  <View style={styles.planRight}>
                    <Text style={[styles.planPrice, sel && styles.planPriceSelected]}>
                      {unavailable ? `${plan.price[storageType]}*` : plan.price[storageType]}
                    </Text>
                    <View style={[styles.radio, sel && styles.radioSelected]}>
                      {sel && <View style={styles.radioInner} />}
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* ── Footer ── */}
          <View style={styles.footer}>

            {isSelecting && (
              <>
                {servers.length === 0 && !serversLoading && (
                  <View style={styles.noServersNotice}>
                    <Text style={styles.noServersNoticeText}>
                      No servers are currently available. Storage upgrades are disabled until one is available.
                    </Text>
                  </View>
                )}

                {isExpansion && selectedPlan && (
                  <View style={styles.expansionNotice}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text style={styles.expansionNoticeTitle}>Capacity Expansion Request</Text>
                      {selectedServer && (
                        <View style={selectedServer.drive_type === 'nvme' ? styles.driveBadgeFast : styles.driveBadgeSlow}>
                          <Text style={styles.driveBadgeText}>{selectedServer.drive_type === 'nvme' ? 'Fast' : 'Standard'} Storage</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.expansionNoticeBody}>
                      This server doesn't have enough free space for {selectedPlan.label}{' '}
                      {selectedServer ? `(${selectedServer.drive_type === 'nvme' ? 'fast' : 'standard'} storage)` : ''} right now.
                      You can pay a <Text style={{ fontWeight: '700' }}>50% deposit ({depositDisplay})</Text> to
                      increase server capacity for you. Your request is reviewed within{' '}
                      <Text style={{ fontWeight: '700' }}>7 business days</Text> and, once approved, capacity is
                      expanded within <Text style={{ fontWeight: '700' }}>14 business days</Text>.
                      If either deadline is missed, your deposit is automatically refunded.
                      The remaining amount will be charged when your additional capacity is provisioned.
                    </Text>
                  </View>
                )}

                {Platform.OS === 'ios' && canApplePay && (
                  <TouchableOpacity
                    style={[styles.applePayBtn, (!selectedPlanId || servers.length === 0) && styles.btnDisabled]}
                    onPress={handleApplePay}
                    disabled={!selectedPlanId || servers.length === 0}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.applePayText}>{''} Pay</Text>
                  </TouchableOpacity>
                )}

                {Platform.OS === 'android' && canGooglePay && (
                  <TouchableOpacity
                    style={[styles.googlePayBtn, (!selectedPlanId || servers.length === 0) && styles.btnDisabled]}
                    onPress={handleGooglePay}
                    disabled={!selectedPlanId || servers.length === 0}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.googlePayText}>G Pay</Text>
                  </TouchableOpacity>
                )}

                

                <TouchableOpacity
                  style={[styles.cardBtn, (!selectedPlanId || servers.length === 0) && styles.btnDisabled]}
                  onPress={handleCardPay}
                  disabled={!selectedPlanId || servers.length === 0}
                  activeOpacity={0.85}
                >
                  <CreditCard size={16} color={(selectedPlanId && servers.length > 0) ? colors.textPrimary : colors.textMuted} strokeWidth={2} style={{ marginRight: 6 }} />
                  <Text style={[styles.cardBtnText, (!selectedPlanId || servers.length === 0) && styles.disabledText]}>
                    Pay by Card
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.paypalBtn, (!selectedPlanId || servers.length === 0) && styles.btnDisabled]}
                  onPress={handlePayPal}
                  disabled={!selectedPlanId || servers.length === 0}
                  activeOpacity={0.85}
                >
                  <Text style={styles.paypalPay}>Pay</Text>
                  <Text style={styles.paypalPal}>Pal</Text>
                </TouchableOpacity>
              </>
            )}

            {/* Processing spinner */}
            {purchaseState === 'processing' && (
              <View style={[styles.paypalBtn, styles.btnDisabled]}>
                <ActivityIndicator color={colors.surface} style={{ marginRight: 8 }} />
                <Text style={styles.paypalPay}>Processing…</Text>
              </View>
            )}

            {/* Awaiting PayPal */}
            {purchaseState === 'awaiting' && (
              <>
                <View style={styles.awaitingBanner}>
                  <Text style={styles.awaitingText}>
                    PayPal opened in your browser. Complete the payment there, then return here.
                  </Text>
                </View>
                <TouchableOpacity style={styles.verifyBtn} onPress={handleVerifyPayPal} activeOpacity={0.85}>
                  <Text style={styles.verifyBtnText}>I've completed payment</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.cancelBtn} onPress={handleClose}>
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
              </>
            )}

            {/* Verifying */}
            {purchaseState === 'verifying' && (
              <View style={[styles.paypalBtn, styles.btnDisabled]}>
                <ActivityIndicator color={colors.surface} style={{ marginRight: 8 }} />
                <Text style={styles.paypalPay}>Verifying payment…</Text>
              </View>
            )}

            {/* Expansion success */}
            {isExpansionSuccess && (
              <>
                <View style={styles.expansionSuccessBanner}>
                  <Text style={styles.expansionSuccessTitle}>Expansion Request Submitted</Text>
                  <Text style={styles.expansionSuccessBody}>
                    Your deposit was received. Your request is reviewed within 7 business days and,
                    once approved, capacity is expanded within 14 business days. You'll be notified
                    by email once it's ready. If either deadline is missed, your deposit is refunded.
                    {expansionExpiresAt ? `\n\nReview due: ${new Date(expansionExpiresAt).toLocaleDateString()}` : ''}
                  </Text>
                </View>
                <TouchableOpacity style={styles.primaryBtn} onPress={onClose} activeOpacity={0.85}>
                  <Text style={styles.primaryBtnText}>Done</Text>
                </TouchableOpacity>
              </>
            )}

          </View>
          </>
        )}
      </View>
    </Modal>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 14,
    backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  closeBtn: { width: 36, alignItems: 'flex-start' },
  headerTitle: { fontSize: 17, fontWeight: '600', color: colors.textPrimary },

  scrollContent: { padding: spacing.md, paddingBottom: 300 },

  // Server dropdown trigger
  serverTrigger: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.xs,
    borderWidth: 1.5, borderColor: colors.border, ...shadow.sm,
  },
  serverTriggerOpen: {
    borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
    borderBottomColor: colors.divider,
  },
  serverTriggerName: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  serverTriggerMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  capacityRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  capacityLabel: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
  capacityValue: { fontSize: 11, fontWeight: '700', color: colors.textPrimary },
  capacityDot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: colors.border, marginHorizontal: 2 },

  // Expanded dropdown list
  serverDropdown: {
    backgroundColor: colors.surface,
    borderWidth: 1.5, borderTopWidth: 0, borderColor: colors.border,
    borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg,
    marginBottom: spacing.md, overflow: 'hidden', ...shadow.sm,
  },
  serverDropdownRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: spacing.md,
  },
  serverDropdownRowActive: { backgroundColor: colors.primaryLighter },
  serverDropdownRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  serverDropdownName: { fontSize: 14, fontWeight: '500', color: colors.textPrimary },
  serverDropdownNameActive: { color: colors.primary, fontWeight: '600' },
  serverDropdownMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  serverCheck: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary, marginLeft: spacing.sm },

  // Quota card
  quotaCard: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.md, ...shadow.sm,
  },
  quotaLabel: {
    fontSize: 12, fontWeight: '600', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4,
  },
  quotaValue: { fontSize: 26, fontWeight: '700', color: colors.textPrimary },
  quotaSub: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  miniBar: { height: 6, backgroundColor: colors.border, borderRadius: 3, overflow: 'hidden', marginTop: spacing.sm },
  miniBarFill: { height: '100%', backgroundColor: colors.primary, borderRadius: 3 },

  sectionLabel: {
    fontSize: 12, fontWeight: '600', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8,
    marginBottom: spacing.sm, marginTop: spacing.xs,
  },

  // Storage type toggle
  typeToggle: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  typeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: spacing.sm,
    borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  typeBtnActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  typeBtnLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  typeBtnLabelActive: { color: colors.surface },
  typeBtnSub: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  typeBtnSubActive: { color: 'rgba(255,255,255,0.75)' },

  // Plan cards
  planCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.sm,
    borderWidth: 1.5, borderColor: colors.border, ...shadow.sm,
  },
  planCardSelected: { borderColor: colors.primary, backgroundColor: colors.primaryLighter },
  planLeft: { flex: 1 },
  planLabel: { fontSize: 17, fontWeight: '700', color: colors.textPrimary },
  planLabelSelected: { color: colors.primary },
  planNewTotal: { fontSize: 12, color: colors.textMuted, marginTop: 3 },
  planRight: { alignItems: 'flex-end', gap: spacing.sm },
  planPrice: { fontSize: 15, fontWeight: '600', color: colors.textSecondary },
  planPriceSelected: { color: colors.primary },
  radio: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  radioSelected: { borderColor: colors.primary },
  radioInner: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary },

  // Footer
  footer: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    padding: spacing.md, paddingBottom: spacing.lg,
    backgroundColor: colors.surface,
    borderTopWidth: 1, borderTopColor: colors.border,
  },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: 14, marginBottom: spacing.sm,
  },
  primaryBtnText: { fontSize: 16, fontWeight: '600', color: colors.surface },

  applePayBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#000', borderRadius: radius.md,
    paddingVertical: 14, marginBottom: spacing.sm,
  },
  applePayText: { fontSize: 17, fontWeight: '600', color: '#fff', letterSpacing: 0.3 },

  googlePayBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#1a1a1a', borderRadius: radius.md,
    paddingVertical: 14, marginBottom: spacing.sm,
  },
  googlePayText: { fontSize: 16, fontWeight: '600', color: '#fff', letterSpacing: 0.3 },

  cardBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderRadius: radius.md,
    paddingVertical: 13, marginBottom: spacing.sm,
    borderWidth: 1.5, borderColor: colors.border,
  },
  cardBtnText: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },

  paypalBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#003087', borderRadius: radius.md,
    paddingVertical: 14, marginBottom: spacing.sm,
  },
  paypalPay: { fontSize: 16, fontWeight: '400', color: '#009cde', letterSpacing: 0.2 },
  paypalPal: { fontSize: 16, fontWeight: '800', color: '#009cde', letterSpacing: 0.2 },
  paypalPrice: { fontSize: 16, fontWeight: '600', color: 'rgba(255,255,255,0.9)' },

  btnDisabled: { opacity: 0.45 },
  disabledText: { color: colors.textMuted },

  awaitingBanner: {
    backgroundColor: colors.infoBg, borderRadius: radius.md,
    padding: spacing.sm, marginBottom: spacing.sm,
  },
  awaitingText: { fontSize: 13, color: colors.info, lineHeight: 18, textAlign: 'center' },

  verifyBtn: {
    backgroundColor: colors.success, borderRadius: radius.md,
    paddingVertical: 14, alignItems: 'center', marginBottom: spacing.sm,
  },
  verifyBtnText: { fontSize: 16, fontWeight: '600', color: colors.surface },

  cancelBtn: { paddingVertical: 12, alignItems: 'center' },
  cancelBtnText: { fontSize: 15, color: colors.textSecondary, fontWeight: '500' },

  // Drive speed badges
  driveBadgeFast: { backgroundColor: '#dcfce7', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  driveBadgeSlow: { backgroundColor: '#f3f4f6', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  driveBadgeText: { fontSize: 10, fontWeight: '700', color: '#374151', textTransform: 'uppercase', letterSpacing: 0.3 },

  noServersNotice: {
    backgroundColor: '#fef2f2', borderRadius: radius.md,
    padding: spacing.sm, marginBottom: spacing.sm,
    borderWidth: 1, borderColor: '#fecaca',
  },
  noServersNoticeText: { fontSize: 13, color: '#b91c1c', textAlign: 'center' },

  planCardUnavailable: { borderStyle: 'dashed', opacity: 0.75 },
  planUnavailableNote: { fontSize: 11, color: colors.warning ?? '#d97706', marginTop: 3 },

  expansionNotice: {
    backgroundColor: '#fffbeb', borderRadius: radius.lg,
    padding: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm,
    borderWidth: 1, borderColor: '#fde68a',
  },
  expansionNoticeTitle: { fontSize: 13, fontWeight: '700', color: '#92400e', marginBottom: 4 },
  expansionNoticeBody: { fontSize: 13, color: '#78350f', lineHeight: 19 },

  expansionSuccessBanner: {
    backgroundColor: '#ecfdf5', borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.md,
    borderWidth: 1, borderColor: '#a7f3d0',
  },
  expansionSuccessTitle: { fontSize: 15, fontWeight: '700', color: '#065f46', marginBottom: 6 },
  expansionSuccessBody: { fontSize: 13, color: '#064e3b', lineHeight: 19 },
});
