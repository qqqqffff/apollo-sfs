import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Check, CheckCircle2, Minus, Rocket, X } from 'lucide-react-native';
import { formatCents, getBillingConfig, type BillingConfig } from '../api/billing';
import {
  confirmPremiumSubscription,
  createPremiumSubscription,
  type PremiumPlan,
} from '../api/payments';
import { card, colors, radius, spacing } from '../theme';

// Base vs Premium, grounded in what the API actually gates on is_premium —
// same comparison table as the web PremiumUpgradeModal.
const COMPARISON: { label: string; base: boolean; premium: boolean }[] = [
  { label: 'File browser, uploads & sharing', base: true, premium: true },
  { label: 'Purchase additional storage capacity', base: true, premium: true },
  { label: 'End-to-end file encryption', base: true, premium: true },
  { label: 'SFS S3-compatible API', base: false, premium: true },
  { label: 'Per-directory scoped API keys', base: false, premium: true },
  { label: 'Premium file-server (WebDAV) mounts', base: false, premium: true },
  { label: 'Priority support', base: false, premium: true },
];

const PLAN_LABELS: Record<PremiumPlan, string> = { monthly: 'Monthly', annual: 'Annual' };

type Phase = 'select' | 'processing' | 'awaiting' | 'confirming' | 'purchased';

interface Props {
  visible: boolean;
  onClose: () => void;
  // Called after a confirmed subscription so the caller can refresh `me`.
  onSubscribed: () => void;
}

// Mobile counterpart of the web PremiumUpgradeModal: pick a plan, approve the
// recurring PayPal subscription in the system browser, then confirm it on
// return (the ACTIVATED webhook is the durable fallback if confirm is missed).
export default function PremiumUpgradeModal({ visible, onClose, onSubscribed }: Props) {
  const [config, setConfig] = useState<BillingConfig | null>(null);
  const [phase, setPhase] = useState<Phase>('select');
  const [plan, setPlan] = useState<PremiumPlan>('monthly');
  const [pendingSubscriptionId, setPendingSubscriptionId] = useState<string | null>(null);
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    if (!visible) return;
    setPhase('select');
    setPlan('monthly');
    setPendingSubscriptionId(null);
    getBillingConfig().then(setConfig).catch(() => setConfig(null));
  }, [visible]);

  useEffect(() => {
    if (phase !== 'awaiting') return;
    const sub = AppState.addEventListener('change', (next) => {
      if (appStateRef.current.match(/inactive|background/) && next === 'active') {
        handleConfirm();
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, pendingSubscriptionId]);

  const plans = config?.premium_plans ?? [];
  const selectedPrice = plans.find((p) => p.plan === plan)?.price_cents ?? 0;

  const handleSubscribe = async () => {
    setPhase('processing');
    try {
      const { subscription_id, approve_url } = await createPremiumSubscription(plan);
      setPendingSubscriptionId(subscription_id);
      await Linking.openURL(approve_url);
      setPhase('awaiting');
    } catch (e: any) {
      setPhase('select');
      Alert.alert('Could not start checkout', e?.response?.data?.error ?? e?.message ?? 'Unknown error');
    }
  };

  const handleConfirm = async () => {
    if (!pendingSubscriptionId) return;
    setPhase('confirming');
    try {
      await confirmPremiumSubscription(pendingSubscriptionId);
      setPhase('purchased');
      onSubscribed();
    } catch (e: any) {
      setPhase('awaiting');
      Alert.alert('Subscription not confirmed', e?.response?.data?.error ?? e?.message ?? 'Please try again.');
    }
  };

  const busy = phase === 'processing' || phase === 'confirming';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => !busy && onClose()}>
      <View style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} disabled={busy} style={styles.closeBtn} hitSlop={12}>
            <X size={20} color={busy ? colors.textMuted : colors.textPrimary} strokeWidth={2} />
          </TouchableOpacity>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Rocket size={18} color={colors.warning} />
            <Text style={styles.headerTitle}>Upgrade to Premium</Text>
          </View>
          <View style={{ width: 36 }} />
        </View>

        {config?.environment === 'sandbox' && (
          <View style={styles.sandboxBanner}>
            <Text style={styles.sandboxBannerText}>SANDBOX PAYMENT</Text>
          </View>
        )}

        <ScrollView contentContainerStyle={styles.scrollContent}>
          {phase === 'purchased' ? (
            <View style={styles.purchasedWrap}>
              <CheckCircle2 size={52} color={colors.success} />
              <Text style={styles.purchasedTitle}>Premium activated</Text>
              <Text style={styles.purchasedBody}>
                You now have access to the SFS API with per-directory API keys and file-server
                mounts, the automated Google account backup, and photo collections with automated
                photo organization.
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={onClose}>
                <Text style={styles.primaryBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {/* Base vs Premium comparison */}
              <Text style={styles.sectionLabel}>PREMIUM VS BASE</Text>
              <View style={[card, { overflow: 'hidden', marginBottom: spacing.md }]}>
                <View style={[styles.compareRow, styles.compareHeader]}>
                  <Text style={[styles.compareHeaderText, { flex: 1 }]}>FEATURE</Text>
                  <Text style={[styles.compareHeaderText, styles.compareCol]}>BASE</Text>
                  <Text style={[styles.compareHeaderText, styles.compareCol]}>PREMIUM</Text>
                </View>
                {COMPARISON.map((row, i) => (
                  <View key={row.label} style={[styles.compareRow, i > 0 && styles.rowBorder]}>
                    <Text style={styles.compareLabel}>{row.label}</Text>
                    <View style={styles.compareCol}>
                      {row.base
                        ? <Check size={15} color={colors.success} />
                        : <Minus size={15} color={colors.border} />}
                    </View>
                    <View style={styles.compareCol}>
                      {row.premium
                        ? <Check size={15} color={colors.warning} />
                        : <Minus size={15} color={colors.border} />}
                    </View>
                  </View>
                ))}
              </View>

              {/* Plan selector */}
              <Text style={styles.sectionLabel}>CHOOSE A PLAN</Text>
              {plans.length === 0 ? (
                <Text style={styles.mutedText}>
                  {config ? 'Payments are not configured.' : 'Loading payment options…'}
                </Text>
              ) : (
                <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md }}>
                  {plans.map((p) => {
                    const sel = plan === p.plan;
                    return (
                      <TouchableOpacity
                        key={p.plan}
                        style={[styles.planBtn, sel && styles.planBtnActive]}
                        onPress={() => setPlan(p.plan)}
                        disabled={busy || phase === 'awaiting'}
                        activeOpacity={0.8}
                      >
                        <Text style={[styles.planBtnLabel, sel && { color: colors.primaryHover }]}>
                          {PLAN_LABELS[p.plan]}
                        </Text>
                        <Text style={[styles.planBtnPrice, sel && { color: colors.primary }]}>
                          {formatCents(p.price_cents)}{p.plan === 'monthly' ? '/mo' : '/yr'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}

              {phase === 'select' && plans.length > 0 && (
                <TouchableOpacity style={styles.paypalBtn} onPress={handleSubscribe} activeOpacity={0.85}>
                  <Text style={styles.paypalPay}>Subscribe with Pay</Text>
                  <Text style={styles.paypalPal}>Pal</Text>
                  <Text style={styles.paypalPrice}>
                    {selectedPrice ? ` — ${formatCents(selectedPrice)}` : ''}
                  </Text>
                </TouchableOpacity>
              )}

              {busy && (
                <View style={[styles.paypalBtn, { opacity: 0.5 }]}>
                  <ActivityIndicator color="#009cde" style={{ marginRight: 8 }} />
                  <Text style={styles.paypalPay}>
                    {phase === 'processing' ? 'Starting checkout…' : 'Confirming subscription…'}
                  </Text>
                </View>
              )}

              {phase === 'awaiting' && (
                <>
                  <View style={styles.awaitingBanner}>
                    <Text style={styles.awaitingText}>
                      PayPal opened in your browser. Approve the subscription there, then return here.
                    </Text>
                  </View>
                  <TouchableOpacity style={styles.verifyBtn} onPress={handleConfirm}>
                    <Text style={styles.verifyBtnText}>I've approved the subscription</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.cancelBtn} onPress={() => setPhase('select')}>
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </TouchableOpacity>
                </>
              )}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

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

  sandboxBanner: { backgroundColor: colors.sandboxBg, paddingVertical: 4, alignItems: 'center' },
  sandboxBannerText: { fontSize: 10, fontWeight: '700', color: colors.sandbox, letterSpacing: 0.8 },

  scrollContent: { padding: spacing.md, paddingBottom: spacing.xl },
  sectionLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.8, marginBottom: spacing.xs },
  mutedText: { fontSize: 13, color: colors.textMuted },

  compareRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: 9 },
  compareHeader: { backgroundColor: colors.background },
  compareHeaderText: { fontSize: 10, fontWeight: '700', color: colors.textMuted, letterSpacing: 0.6 },
  compareCol: { width: 64, alignItems: 'center', textAlign: 'center' } as any,
  compareLabel: { flex: 1, fontSize: 13, color: colors.textPrimary },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.divider },

  planBtn: {
    flex: 1, borderWidth: 2, borderColor: colors.border, borderRadius: radius.lg,
    backgroundColor: colors.surface, padding: spacing.md, alignItems: 'center', gap: 2,
  },
  planBtnActive: { borderColor: colors.primary, backgroundColor: colors.primaryLighter },
  planBtnLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  planBtnPrice: { fontSize: 13, color: colors.textSecondary },

  paypalBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#003087', borderRadius: radius.md,
    paddingVertical: 14, marginBottom: spacing.sm,
  },
  paypalPay: { fontSize: 15, fontWeight: '400', color: '#009cde', letterSpacing: 0.2 },
  paypalPal: { fontSize: 15, fontWeight: '800', color: '#009cde', letterSpacing: 0.2 },
  paypalPrice: { fontSize: 15, fontWeight: '600', color: 'rgba(255,255,255,0.9)' },

  awaitingBanner: { backgroundColor: colors.infoBg, borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.sm },
  awaitingText: { fontSize: 13, color: colors.info, lineHeight: 18, textAlign: 'center' },
  verifyBtn: { backgroundColor: colors.success, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', marginBottom: spacing.sm },
  verifyBtnText: { fontSize: 15, fontWeight: '600', color: '#fff' },
  cancelBtn: { paddingVertical: 10, alignItems: 'center' },
  cancelBtnText: { fontSize: 14, color: colors.textSecondary },

  purchasedWrap: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.sm },
  purchasedTitle: { fontSize: 18, fontWeight: '600', color: colors.textPrimary },
  purchasedBody: { fontSize: 13, color: colors.textSecondary, lineHeight: 19, textAlign: 'center', paddingHorizontal: spacing.md },
  primaryBtn: {
    backgroundColor: colors.primary, borderRadius: radius.md,
    paddingHorizontal: spacing.xl, paddingVertical: 12, marginTop: spacing.md,
  },
  primaryBtnText: { fontSize: 15, fontWeight: '600', color: '#fff' },
});
