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
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { ChevronDown, CreditCard, HardDrive, Server, X, Zap } from 'lucide-react-native';
import {
  captureStorageOrder,
  createApplePayStorageOrder,
  createCardStorageOrder,
  createGooglePayStorageOrder,
  createStorageOrder,
  captureExpansionOrder,
  createApplePayExpansionOrder,
  createCardExpansionOrder,
  createGooglePayExpansionOrder,
  createExpansionOrder,
  type CardPaymentData,
  type StorageType,
} from '../api/billing';
import { listServersWithPing, type ServerInfoWithPing } from '../api/storage';
import { canMakeApplePayments, requestApplePayment } from '../services/nativeApplePay';
import { canMakeGooglePayments, requestGooglePayment } from '../services/nativeGooglePay';
import { APPLE_PAY_MERCHANT_ID, PAYPAL_MERCHANT_ID } from '../config';
import { colors, radius, shadow, spacing } from '../theme';

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
  { id: '256gb', label: '256 GB', addBytes: 256  * 1024 ** 3, price: { nvme: '$100', hdd: '$50'  }, amount: { nvme: '100.00', hdd: '50.00'  } },
  { id: '512gb', label: '512 GB', addBytes: 512  * 1024 ** 3, price: { nvme: '$200', hdd: '$80'  }, amount: { nvme: '200.00', hdd: '80.00'  } },
  { id: '1tb',   label: '1 TB',   addBytes: 1024 * 1024 ** 3, price: { nvme: '$400', hdd: '$120' }, amount: { nvme: '400.00', hdd: '120.00' } },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(0)} MB`;
  if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(0)} GB`;
  return `${(b / 1024 ** 4).toFixed(1)} TB`;
}

function formatCardNumber(text: string): string {
  const clean = text.replace(/\D/g, '').slice(0, 16);
  return clean.replace(/(.{4})/g, '$1 ').trim();
}

function formatExpiry(text: string): string {
  const clean = text.replace(/\D/g, '').slice(0, 4);
  return clean.length > 2 ? `${clean.slice(0, 2)}/${clean.slice(2)}` : clean;
}

// ── Types ──────────────────────────────────────────────────────────────────────

type PurchaseState = 'selecting' | 'card' | 'processing' | 'awaiting' | 'verifying' | 'expansion_success';

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
  const [serverPickerVisible, setServerPickerVisible] = useState(false);
  const [serversLoading, setServersLoading] = useState(false);
  const [serversError, setServersError] = useState<string | null>(null);

  const [canApplePay, setCanApplePay] = useState(false);
  const [canGooglePay, setCanGooglePay] = useState(false);

  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvv, setCardCvv] = useState('');
  const [cardName, setCardName] = useState('');
  const [cardError, setCardError] = useState<string | null>(null);

  const [expansionRequestId, setExpansionRequestId] = useState<string | null>(null);
  const [expansionExpiresAt, setExpansionExpiresAt] = useState<string | null>(null);

  const expiryRef = useRef<TextInput>(null);
  const cvvRef = useRef<TextInput>(null);
  const nameRef = useRef<TextInput>(null);
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    if (!visible) return;
    setStorageType('nvme');
    setSelectedPlanId(null);
    setPurchaseState('selecting');
    setPendingOrderId(null);
    setCardNumber(''); setCardExpiry(''); setCardCvv(''); setCardName(''); setCardError(null);
    setExpansionRequestId(null); setExpansionExpiresAt(null);
    setServerPickerVisible(false);

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
  // Expansion mode: tier requires more space than the server currently has available.
  const isExpansion = !!(selectedPlan && selectedServer && selectedPlan.addBytes > selectedServer.available_bytes);

  // ── Card validation ─────────────────────────────────────────────────────────

  const isCardValid = (): boolean => {
    const num = cardNumber.replace(/\s/g, '');
    if (num.length !== 16) return false;
    const parts = cardExpiry.split('/');
    if (parts.length !== 2 || parts[0].length !== 2 || parts[1].length !== 2) return false;
    const month = parseInt(parts[0], 10);
    const year = parseInt(`20${parts[1]}`, 10);
    const now = new Date();
    if (month < 1 || month > 12) return false;
    if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) return false;
    if (cardCvv.length < 3) return false;
    return cardName.trim().length > 0;
  };

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleCardPay = async () => {
    if (!selectedPlanId || !isCardValid()) return;
    setCardError(null);
    setPurchaseState('processing');
    const num = cardNumber.replace(/\s/g, '');
    const [month, year] = cardExpiry.split('/');
    const payload: CardPaymentData = {
      number: num,
      expiry_month: month,
      expiry_year: `20${year}`,
      cvv: cardCvv,
      name: cardName.trim(),
    };
    try {
      if (isExpansion && selectedServerId) {
        const { expansion_request_id, expires_at } = await createCardExpansionOrder(selectedPlanId, storageType, selectedServerId, payload);
        setExpansionRequestId(expansion_request_id);
        setExpansionExpiresAt(expires_at);
        setPurchaseState('expansion_success');
        onExpansionRequested?.(expansion_request_id, expires_at);
      } else {
        const { new_quota_bytes } = await createCardStorageOrder(selectedPlanId, storageType, payload);
        onPurchased(new_quota_bytes);
      }
    } catch (e: any) {
      setPurchaseState('card');
      setCardError(e.response?.data?.message ?? e.message ?? 'Card payment failed. Please try again.');
    }
  };

  const handleApplePay = async () => {
    if (!selectedPlanId || !selectedPlan) return;
    setPurchaseState('processing');
    // Deposit is 50% of plan price for expansion requests.
    const applePayAmount = isExpansion
      ? (Math.round(parseFloat(selectedPlan.amount[storageType]) * 100 / 2) / 100).toFixed(2)
      : selectedPlan.amount[storageType];
    try {
      const token = await requestApplePayment(
        applePayAmount,
        'USD',
        APPLE_PAY_MERCHANT_ID,
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
      if ((e as any).code !== 'CANCELLED') {
        Alert.alert('Apple Pay failed', e.message ?? 'Please try again.');
      }
      setPurchaseState('selecting');
    }
  };

  const handleGooglePay = async () => {
    if (!selectedPlanId || !selectedPlan) return;
    setPurchaseState('processing');
    const googlePayAmount = isExpansion
      ? (Math.round(parseFloat(selectedPlan.amount[storageType]) * 100 / 2) / 100).toFixed(2)
      : selectedPlan.amount[storageType];
    try {
      const token = await requestGooglePayment(
        googlePayAmount,
        'USD',
        'Apollo SFS',
        PAYPAL_MERCHANT_ID,
      );
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
      if ((e as any).code !== 'CANCELLED') {
        Alert.alert('Google Pay failed', e.message ?? 'Please try again.');
      }
      setPurchaseState('selecting');
    }
  };

  const handlePayPal = async () => {
    if (!selectedPlanId) return;
    setPurchaseState('processing');
    try {
      let order_id: string;
      let approval_url: string;
      if (isExpansion && selectedServerId) {
        const res = await createExpansionOrder(selectedPlanId, storageType, selectedServerId);
        order_id = res.order_id;
        approval_url = res.approval_url;
      } else {
        const res = await createStorageOrder(selectedPlanId, storageType);
        order_id = res.order_id;
        approval_url = res.approval_url;
      }
      setPendingOrderId(order_id);
      if (!(await Linking.canOpenURL(approval_url))) throw new Error('Cannot open PayPal URL');
      await Linking.openURL(approval_url);
      setPurchaseState('awaiting');
    } catch (e: any) {
      setPurchaseState('selecting');
      Alert.alert('Could not start PayPal checkout', e.message ?? 'Please try again.');
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
      setPurchaseState('awaiting');
      Alert.alert('Payment not found', 'We could not verify your payment. If you completed checkout, please try again.');
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
  const isCard = purchaseState === 'card';
  const isExpansionSuccess = purchaseState === 'expansion_success';

  // Deposit is 50% of the plan price, displayed as a string like "$50.00".
  const depositDisplay = selectedPlan
    ? `$${(Math.round(parseFloat(selectedPlan.amount[storageType]) * 100 / 2) / 100).toFixed(2)}`
    : '';

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={styles.root}>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn} hitSlop={12} disabled={isBusy}>
            <X size={20} color={isBusy ? colors.textMuted : colors.textPrimary} strokeWidth={2} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>
            {isCard
              ? (isExpansion ? 'Expansion Deposit' : 'Card Payment')
              : isExpansionSuccess
              ? 'Request Submitted'
              : (isExpansion && selectedPlanId) ? 'Request Expansion' : 'Upgrade Storage'}
          </Text>
          <View style={{ width: 36 }} />
        </View>

        {/* ── Card form ── */}
        {isCard ? (
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {selectedPlan && (
              <View style={styles.planSummary}>
                <Text style={styles.planSummaryLabel}>
                  {selectedPlan.label} · {storageType === 'nvme' ? 'NVMe SSD' : 'HDD'}
                </Text>
                <Text style={styles.planSummaryPrice}>{selectedPlan.price[storageType]}</Text>
              </View>
            )}

            <Text style={styles.fieldLabel}>Card Number</Text>
            <TextInput
              style={styles.input}
              value={cardNumber}
              onChangeText={(t) => {
                const f = formatCardNumber(t);
                setCardNumber(f);
                if (f.replace(/\s/g, '').length === 16) expiryRef.current?.focus();
              }}
              placeholder="1234 5678 9012 3456"
              placeholderTextColor={colors.textMuted}
              keyboardType="numeric"
              maxLength={19}
              returnKeyType="next"
              onSubmitEditing={() => expiryRef.current?.focus()}
            />

            <View style={styles.row}>
              <View style={{ flex: 1.1 }}>
                <Text style={styles.fieldLabel}>Expiry</Text>
                <TextInput
                  ref={expiryRef}
                  style={styles.input}
                  value={cardExpiry}
                  onChangeText={(t) => {
                    const f = formatExpiry(t);
                    setCardExpiry(f);
                    if (f.length === 5) cvvRef.current?.focus();
                  }}
                  placeholder="MM/YY"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="numeric"
                  maxLength={5}
                  returnKeyType="next"
                  onSubmitEditing={() => cvvRef.current?.focus()}
                />
              </View>
              <View style={{ flex: 1, marginLeft: spacing.sm }}>
                <Text style={styles.fieldLabel}>CVV</Text>
                <TextInput
                  ref={cvvRef}
                  style={styles.input}
                  value={cardCvv}
                  onChangeText={(t) => {
                    const c = t.replace(/\D/g, '').slice(0, 4);
                    setCardCvv(c);
                    if (c.length >= 3) nameRef.current?.focus();
                  }}
                  placeholder="•••"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="numeric"
                  maxLength={4}
                  secureTextEntry
                  returnKeyType="next"
                  onSubmitEditing={() => nameRef.current?.focus()}
                />
              </View>
            </View>

            <Text style={styles.fieldLabel}>Name on Card</Text>
            <TextInput
              ref={nameRef}
              style={styles.input}
              value={cardName}
              onChangeText={setCardName}
              placeholder="Full name"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={handleCardPay}
            />

            {cardError != null && (
              <Text style={styles.cardError}>{cardError}</Text>
            )}
          </ScrollView>

        ) : (
          /* ── Plan selection ── */
          <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

            {/* Server selector */}
            <Text style={styles.sectionLabel}>Server location</Text>
            <TouchableOpacity
              style={styles.serverSelector}
              onPress={() => setServerPickerVisible(true)}
              activeOpacity={0.8}
              disabled={!isSelecting || serversLoading}
            >
              <View style={styles.serverSelectorLeft}>
                {serversLoading ? (
                  <ActivityIndicator size="small" color={colors.primary} style={{ marginRight: 8 }} />
                ) : (
                  <Server size={16} color={colors.primary} strokeWidth={1.5} style={{ marginRight: 8 }} />
                )}
                <View>
                  {(() => {
                    const sel = servers.find((s) => s.id === selectedServerId);
                    return sel ? (
                      <>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={styles.serverSelectorName}>{sel.name}</Text>
                          <View style={sel.drive_type === 'nvme' ? styles.driveBadgeFast : styles.driveBadgeSlow}>
                            <Text style={styles.driveBadgeText}>
                              {sel.drive_type === 'nvme' ? 'Fast' : 'Slow'}
                            </Text>
                          </View>
                        </View>
                        <Text style={styles.serverSelectorMeta}>
                          {sel.ping_ms !== null ? `${sel.ping_ms} ms  ·  ` : ''}
                          {formatBytes(sel.available_bytes)} available
                        </Text>
                      </>
                    ) : (
                      <Text style={[styles.serverSelectorName, serversError ? styles.serverSelectorError : null]}>
                        {serversLoading ? 'Finding best server…' : serversError ? serversError : 'No servers available'}
                      </Text>
                    );
                  })()}
                </View>
              </View>
              <ChevronDown size={16} color={colors.textMuted} />
            </TouchableOpacity>

            <View style={styles.quotaCard}>
              <Text style={styles.quotaLabel}>Current storage</Text>
              <Text style={styles.quotaValue}>{formatBytes(quotaBytes)}</Text>
              <Text style={styles.quotaSub}>
                {formatBytes(usedBytes)} used · {usedPct.toFixed(0)}%
              </Text>
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
              const unavailable = !!(selectedServer && plan.addBytes > selectedServer.available_bytes);
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
                      <Text style={styles.planUnavailableNote}>Expansion request · 14-day SLA</Text>
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

            {/* Expansion notice shown when selected plan is unavailable */}
            {isExpansion && selectedPlan && (
              <View style={styles.expansionNotice}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Text style={styles.expansionNoticeTitle}>Capacity Expansion Request</Text>
                  {selectedServer && (
                    <View style={selectedServer.drive_type === 'nvme' ? styles.driveBadgeFast : styles.driveBadgeSlow}>
                      <Text style={styles.driveBadgeText}>
                        {selectedServer.drive_type === 'nvme' ? 'Fast' : 'Slow'}
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={styles.expansionNoticeBody}>
                  This server doesn't have enough free space for {selectedPlan.label}{' '}
                  {selectedServer ? `(${selectedServer.drive_type === 'nvme' ? 'fast NVMe' : 'slow HDD'} storage)` : ''} right now.
                  Pay a <Text style={{ fontWeight: '700' }}>{depositDisplay} deposit (50%)</Text> to
                  reserve your slot. Our team will expand capacity within{' '}
                  <Text style={{ fontWeight: '700' }}>14 days</Text>. If we can't fulfil the request
                  in time, your deposit is automatically refunded.
                </Text>
              </View>
            )}

          </ScrollView>
        )}

        {/* ── Footer ── */}
        <View style={styles.footer}>

          {/* Card form footer */}
          {isCard && (
            <>
              <TouchableOpacity
                style={[styles.primaryBtn, !isCardValid() && styles.btnDisabled]}
                onPress={handleCardPay}
                disabled={!isCardValid()}
                activeOpacity={0.85}
              >
                <CreditCard size={18} color={colors.surface} strokeWidth={2} style={{ marginRight: 8 }} />
                <Text style={styles.primaryBtnText}>
                  {isExpansion
                    ? `Pay deposit ${depositDisplay}`
                    : `Pay ${selectedPlan?.price[storageType] ?? ''}`}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => { setPurchaseState('selecting'); setCardError(null); }}>
                <Text style={styles.cancelBtnText}>Back</Text>
              </TouchableOpacity>
            </>
          )}

          {/* Plan selection footer */}
          {isSelecting && (
            <>
              {servers.length === 0 && !serversLoading && (
                <View style={styles.noServersNotice}>
                  <Text style={styles.noServersNoticeText}>
                    <Text>No servers are currently available.</Text>
                    <Text>Storage upgrade requests are disabled until one is available</Text>
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
                  <Text style={styles.applePayText}>{''} Pay</Text>
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
                onPress={() => setPurchaseState('card')}
                disabled={!selectedPlanId || servers.length === 0}
                activeOpacity={0.85}
              >
                <CreditCard
                  size={16}
                  color={(selectedPlanId && servers.length > 0) ? colors.textPrimary : colors.textMuted}
                  strokeWidth={2}
                  style={{ marginRight: 6 }}
                />
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
                {selectedPlan && (
                  <Text style={styles.paypalPrice}>
                    {isExpansion ? ` · deposit ${depositDisplay}` : ` · ${selectedPlan.price[storageType]}`}
                  </Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
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

          {/* Verifying PayPal */}
          {purchaseState === 'verifying' && (
            <View style={[styles.paypalBtn, styles.btnDisabled]}>
              <ActivityIndicator color={colors.surface} style={{ marginRight: 8 }} />
              <Text style={styles.paypalPay}>Verifying payment…</Text>
            </View>
          )}

          {/* Expansion request submitted */}
          {isExpansionSuccess && (
            <>
              <View style={styles.expansionSuccessBanner}>
                <Text style={styles.expansionSuccessTitle}>Expansion Request Submitted</Text>
                <Text style={styles.expansionSuccessBody}>
                  Your deposit was received. Our team will expand server capacity and apply your
                  storage within 14 days. You'll be notified by email once it's ready.
                  {expansionExpiresAt ? `\n\nExpires: ${new Date(expansionExpiresAt).toLocaleDateString()}` : ''}
                </Text>
              </View>
              <TouchableOpacity style={styles.primaryBtn} onPress={onClose} activeOpacity={0.85}>
                <Text style={styles.primaryBtnText}>Done</Text>
              </TouchableOpacity>
            </>
          )}

        </View>
      </View>

      {/* Server picker sheet */}
      <Modal
        visible={serverPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setServerPickerVisible(false)}
      >
        <TouchableOpacity
          style={styles.serverPickerOverlay}
          activeOpacity={1}
          onPress={() => setServerPickerVisible(false)}
        >
          <TouchableOpacity style={styles.serverPickerSheet} activeOpacity={1} onPress={() => {}}>
            <Text style={styles.serverPickerTitle}>Select Server</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              {servers.map((s) => {
                const sel = s.id === selectedServerId;
                return (
                  <TouchableOpacity
                    key={s.id}
                    style={[styles.serverPickerRow, sel && styles.serverPickerRowActive]}
                    onPress={() => { setSelectedServerId(s.id); setServerPickerVisible(false); }}
                    activeOpacity={0.75}
                  >
                    <View style={styles.serverPickerRowLeft}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={[styles.serverPickerName, sel && styles.serverPickerNameActive]}>
                          {s.name}
                        </Text>
                        <View style={s.drive_type === 'nvme' ? styles.driveBadgeFast : styles.driveBadgeSlow}>
                          <Text style={styles.driveBadgeText}>
                            {s.drive_type === 'nvme' ? 'Fast' : 'Slow'}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.serverPickerMeta}>
                        {s.ping_ms !== null ? `${s.ping_ms} ms  ·  ` : ''}
                        {formatBytes(s.available_bytes)} free of {formatBytes(s.total_capacity_bytes)}
                      </Text>
                    </View>
                    {sel && <View style={styles.serverPickerCheck} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
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

  // Card form
  planSummary: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.lg,
    borderWidth: 1.5, borderColor: colors.primary, ...shadow.sm,
  },
  planSummaryLabel: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  planSummaryPrice: { fontSize: 18, fontWeight: '700', color: colors.primary },

  fieldLabel: {
    fontSize: 12, fontWeight: '600', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border,
    paddingHorizontal: spacing.md, paddingVertical: 13,
    fontSize: 16, color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  row: { flexDirection: 'row' },
  cardError: { fontSize: 13, color: colors.error, marginTop: -spacing.sm, marginBottom: spacing.sm },

  // Footer
  footer: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    padding: spacing.md, paddingBottom: spacing.lg,
    backgroundColor: colors.surface,
    borderTopWidth: 1, borderTopColor: colors.border,
  },

  // Primary (card pay) button
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: 14, marginBottom: spacing.sm,
  },
  primaryBtnText: { fontSize: 16, fontWeight: '600', color: colors.surface },

  // Apple Pay
  applePayBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#000', borderRadius: radius.md,
    paddingVertical: 14, marginBottom: spacing.sm,
  },
  applePayText: { fontSize: 17, fontWeight: '600', color: '#fff', letterSpacing: 0.3 },

  // Google Pay
  googlePayBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#1a1a1a', borderRadius: radius.md,
    paddingVertical: 14, marginBottom: spacing.sm,
  },
  googlePayText: { fontSize: 16, fontWeight: '600', color: '#fff', letterSpacing: 0.3 },

  // Card (outlined)
  cardBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderRadius: radius.md,
    paddingVertical: 13, marginBottom: spacing.sm,
    borderWidth: 1.5, borderColor: colors.border,
  },
  cardBtnText: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },

  // PayPal
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

  // Server selector
  serverSelector: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.md,
    borderWidth: 1.5, borderColor: colors.border, ...shadow.sm,
  },
  serverSelectorLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  serverSelectorName: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  serverSelectorMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  serverSelectorError: { color: '#b91c1c', fontWeight: '500' },

  // Server picker modal
  serverPickerOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end',
  },
  serverPickerSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    paddingTop: spacing.md, paddingBottom: spacing.xl,
    maxHeight: '60%',
  },
  serverPickerTitle: {
    fontSize: 14, fontWeight: '600', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.8,
    paddingHorizontal: spacing.md, marginBottom: spacing.sm,
  },
  serverPickerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13, paddingHorizontal: spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.divider,
  },
  serverPickerRowActive: {},
  serverPickerRowLeft: { flex: 1 },
  serverPickerName: { fontSize: 15, fontWeight: '500', color: colors.textPrimary },
  serverPickerNameActive: { color: colors.primary, fontWeight: '600' },
  serverPickerMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  serverPickerCheck: {
    width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary, marginLeft: spacing.sm,
  },

  // Drive speed badges
  driveBadgeFast: {
    backgroundColor: '#dcfce7', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1,
  },
  driveBadgeSlow: {
    backgroundColor: '#f3f4f6', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1,
  },
  driveBadgeText: { fontSize: 10, fontWeight: '700', color: '#374151', textTransform: 'uppercase', letterSpacing: 0.3 },

  // No servers notice
  noServersNotice: {
    backgroundColor: '#fef2f2', borderRadius: radius.md,
    padding: spacing.sm, marginBottom: spacing.sm,
    borderWidth: 1, borderColor: '#fecaca',
  },
  noServersNoticeText: { fontSize: 13, color: '#b91c1c', textAlign: 'center' },

  // Unavailable plan card variant
  planCardUnavailable: { borderStyle: 'dashed', opacity: 0.75 },
  planUnavailableNote: { fontSize: 11, color: colors.warning ?? '#d97706', marginTop: 3 },

  // Expansion notice banner (shown in plan selection when tier is unavailable)
  expansionNotice: {
    backgroundColor: '#fffbeb', borderRadius: radius.lg,
    padding: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm,
    borderWidth: 1, borderColor: '#fde68a',
  },
  expansionNoticeTitle: {
    fontSize: 13, fontWeight: '700', color: '#92400e', marginBottom: 4,
  },
  expansionNoticeBody: {
    fontSize: 13, color: '#78350f', lineHeight: 19,
  },

  // Expansion success banner (shown after deposit captured)
  expansionSuccessBanner: {
    backgroundColor: '#ecfdf5', borderRadius: radius.lg,
    padding: spacing.md, marginBottom: spacing.md,
    borderWidth: 1, borderColor: '#a7f3d0',
  },
  expansionSuccessTitle: {
    fontSize: 15, fontWeight: '700', color: '#065f46', marginBottom: 6,
  },
  expansionSuccessBody: {
    fontSize: 13, color: '#064e3b', lineHeight: 19,
  },
});
