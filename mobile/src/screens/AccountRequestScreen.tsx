import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { ArrowLeft, Check, CreditCard, HardDrive, Zap } from 'lucide-react-native';
import {
  captureInterestDepositOrder,
  createInterestDepositOrder,
  getPublicConfig,
  submitMobileInterestForm,
  type PublicConfig,
} from '../api/interest';
import type { StorageType } from '../api/billing';
import PayPalCardSheet from '../components/PayPalCardSheet';
import { card, colors, radius, spacing } from '../theme';

// Fixed plans mirror the web /interest page (and the storage upgrade modal).
interface Plan {
  id: string;
  label: string;
  storageGB: number;
  price: Record<StorageType, string>;
  amount: Record<StorageType, string>;
}

const PLANS: Plan[] = [
  { id: '64gb',  label: '64 GB',  storageGB: 64,   price: { nvme: '$30',  hdd: '$20'  }, amount: { nvme: '30.00',  hdd: '20.00'  } },
  { id: '128gb', label: '128 GB', storageGB: 128,  price: { nvme: '$50',  hdd: '$30'  }, amount: { nvme: '50.00',  hdd: '30.00'  } },
  { id: '256gb', label: '256 GB', storageGB: 256,  price: { nvme: '$80',  hdd: '$50'  }, amount: { nvme: '80.00',  hdd: '50.00'  } },
  { id: '512gb', label: '512 GB', storageGB: 512,  price: { nvme: '$150', hdd: '$80'  }, amount: { nvme: '150.00', hdd: '80.00'  } },
  { id: '1tb',   label: '1 TB',   storageGB: 1024, price: { nvme: '$250', hdd: '$120' }, amount: { nvme: '250.00', hdd: '120.00' } },
];

function depositAmt(plan: Plan, storageType: StorageType): string {
  return (Math.round(parseFloat(plan.amount[storageType]) * 100 / 2) / 100).toFixed(2);
}

type Step = 'form' | 'card_form' | 'processing' | 'awaiting' | 'submitted';

// The web /interest "Request access" form, ported for the sign-in screen.
// Same refundable 50%-deposit flow — the deposit (a real payment) plus the
// server-side caps stand in for the Cloudflare Turnstile the app can't render.
export default function AccountRequestScreen({ navigation }: { navigation: any }) {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [storageType, setStorageType] = useState<StorageType>('nvme');
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [useCase, setUseCase] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [error, setError] = useState<string | null>(null);
  const [cardOrderId, setCardOrderId] = useState<string | null>(null);
  const [pendingOrderId, setPendingOrderId] = useState<string | null>(null);
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    getPublicConfig().then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    if (step !== 'awaiting') return;
    const sub = AppState.addEventListener('change', (next) => {
      if (appStateRef.current.match(/inactive|background/) && next === 'active') {
        handleVerifyPayPal();
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, pendingOrderId]);

  const selectedPlan = PLANS.find((p) => p.id === selectedPlanId) ?? null;

  function validateForm(): boolean {
    if (!name.trim()) { setError('Please enter your full name.'); return false; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError('Please enter a valid email address.'); return false; }
    if (!selectedPlanId) { setError('Please select a storage plan.'); return false; }
    if (!useCase.trim()) { setError('Please describe your use case.'); return false; }
    return true;
  }

  async function submitForm(depositOrderId: string) {
    const plan = PLANS.find((p) => p.id === selectedPlanId)!;
    try {
      await submitMobileInterestForm({
        name: name.trim(),
        email: email.trim(),
        plan_id: plan.id,
        storage_type: storageType,
        use_case: useCase.trim(),
        deposit_order_id: depositOrderId,
      });
      setStep('submitted');
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Something went wrong — please try again.');
      setStep('form');
    }
  }

  async function handleDepositCaptured(orderId: string) {
    setStep('processing');
    try {
      await captureInterestDepositOrder(orderId);
      await submitForm(orderId);
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Payment could not be completed — please try again.');
      setStep('form');
    }
  }

  // ── PayPal wallet: server order → browser approval → capture → submit ──────
  const handlePayPal = async () => {
    setError(null);
    if (!validateForm()) return;
    setStep('processing');
    try {
      const { order_id, approve_url } = await createInterestDepositOrder(selectedPlanId!, storageType, 'paypal');
      setPendingOrderId(order_id);
      await Linking.openURL(approve_url);
      setStep('awaiting');
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Could not start checkout');
      setStep('form');
    }
  };

  const handleVerifyPayPal = async () => {
    if (!pendingOrderId) return;
    await handleDepositCaptured(pendingOrderId);
  };

  // ── Card: server order (payment_method=card) → hosted fields → capture ─────
  const handleChooseCard = async () => {
    setError(null);
    if (!validateForm()) return;
    setStep('processing');
    try {
      const { order_id } = await createInterestDepositOrder(selectedPlanId!, storageType, 'card');
      setCardOrderId(order_id);
      setStep('card_form');
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Could not start checkout');
      setStep('form');
    }
  };

  if (step === 'submitted') {
    return (
      <View style={[styles.container, styles.center]}>
        <View style={[card, styles.submittedCard]}>
          <View style={styles.submittedIcon}>
            <Check size={26} color={colors.success} strokeWidth={2.5} />
          </View>
          <Text style={styles.submittedTitle}>Request received</Text>
          <Text style={styles.submittedBody}>
            Thanks for your interest in Apollo SFS. Your deposit has been received and will be
            refunded in full if your request is denied or expires. We'll be in touch if there's a
            spot available.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.primaryBtnText}>Back to sign in</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (step === 'card_form' && cardOrderId && selectedPlan) {
    return (
      <PayPalCardSheet
        amount={depositAmt(selectedPlan, storageType)}
        currency={config?.paypal_currency || 'USD'}
        label={`${selectedPlan.label} deposit — $${depositAmt(selectedPlan, storageType)}`}
        orderId={cardOrderId}
        onSuccess={(orderId) => handleDepositCaptured(orderId)}
        onError={(msg) => {
          setStep('form');
          setCardOrderId(null);
          Alert.alert('Card payment failed', msg);
        }}
        onCancel={() => {
          setStep('form');
          setCardOrderId(null);
        }}
      />
    );
  }

  const isBusy = step === 'processing';

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <TouchableOpacity style={styles.backRow} onPress={() => navigation.goBack()} disabled={isBusy}>
          <ArrowLeft size={16} color={colors.textSecondary} />
          <Text style={styles.backText}>Back to sign in</Text>
        </TouchableOpacity>

        <Text style={styles.pageTitle}>Request access</Text>
        <Text style={styles.pageSubtitle}>
          Apollo SFS is currently invite-only. Fill out this form and pay a refundable 50% deposit
          to reserve your spot.
        </Text>

        <Text style={styles.inputLabel}>Full name *</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="Jane Smith"
          placeholderTextColor={colors.textMuted}
          maxLength={120}
          editable={!isBusy}
        />

        <Text style={styles.inputLabel}>Email address *</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="jane@example.com"
          placeholderTextColor={colors.textMuted}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={254}
          editable={!isBusy}
        />

        <Text style={styles.inputLabel}>Storage type</Text>
        <View style={styles.typeRow}>
          {(['nvme', 'hdd'] as StorageType[]).map((t) => {
            const sel = storageType === t;
            return (
              <TouchableOpacity
                key={t}
                style={[styles.typeBtn, sel && styles.typeBtnActive]}
                onPress={() => setStorageType(t)}
                disabled={isBusy}
                activeOpacity={0.8}
              >
                {t === 'nvme'
                  ? <Zap size={15} color={sel ? colors.primaryHover : colors.textSecondary} />
                  : <HardDrive size={15} color={sel ? colors.primaryHover : colors.textSecondary} />}
                <View>
                  <Text style={[styles.typeBtnLabel, sel && { color: colors.primaryHover }]}>
                    {t === 'nvme' ? 'Fast' : 'Standard'}
                  </Text>
                  <Text style={[styles.typeBtnSub, sel && { color: colors.primary }]}>
                    {t === 'nvme' ? 'NVMe SSD' : 'HDD'}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={styles.inputLabel}>Storage plan *</Text>
        {PLANS.map((plan) => {
          const sel = selectedPlanId === plan.id;
          return (
            <TouchableOpacity
              key={plan.id}
              style={[styles.planCard, sel && styles.planCardActive]}
              onPress={() => setSelectedPlanId(plan.id)}
              disabled={isBusy}
              activeOpacity={0.8}
            >
              <Text style={[styles.planLabel, sel && { color: colors.primaryHover }]}>{plan.label}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Text style={[styles.planPrice, sel && { color: colors.primary }]}>{plan.price[storageType]}</Text>
                <View style={[styles.radio, sel && { borderColor: colors.primary }]}>
                  {sel && <View style={styles.radioInner} />}
                </View>
              </View>
            </TouchableOpacity>
          );
        })}
        <Text style={styles.helpText}>
          Not sure how much you'll need? Additional capacity can be purchased once your account is
          provisioned.
        </Text>

        {selectedPlan && (
          <View style={styles.depositNotice}>
            <Text style={styles.depositNoticeText}>
              A <Text style={{ fontWeight: '700' }}>${depositAmt(selectedPlan, storageType)} refundable deposit (50%)</Text> is
              required to reserve your spot. It will be returned automatically if your request is
              denied or expires.
            </Text>
          </View>
        )}

        <Text style={styles.inputLabel}>Reason / use case *</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          value={useCase}
          onChangeText={setUseCase}
          placeholder="Briefly describe how you'd use Apollo SFS…"
          placeholderTextColor={colors.textMuted}
          multiline
          numberOfLines={4}
          maxLength={2000}
          editable={!isBusy}
        />

        {error && <Text style={styles.errorText}>{error}</Text>}

        {step === 'awaiting' ? (
          <>
            <View style={styles.awaitingBanner}>
              <Text style={styles.awaitingText}>
                PayPal opened in your browser. Complete the payment there, then return here.
              </Text>
            </View>
            <TouchableOpacity style={styles.verifyBtn} onPress={handleVerifyPayPal}>
              <Text style={styles.verifyBtnText}>I've completed payment</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setStep('form')}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </>
        ) : isBusy ? (
          <View style={[styles.paypalBtn, { opacity: 0.5 }]}>
            <ActivityIndicator color="#009cde" style={{ marginRight: 8 }} />
            <Text style={styles.paypalPay}>Processing…</Text>
          </View>
        ) : (
          <>
            <TouchableOpacity
              style={[styles.paypalBtn, !selectedPlanId && styles.btnDisabled]}
              onPress={handlePayPal}
              disabled={!selectedPlanId}
              activeOpacity={0.85}
            >
              <Text style={styles.paypalPay}>Pay</Text>
              <Text style={styles.paypalPal}>Pal</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.cardBtn, !selectedPlanId && styles.btnDisabled]}
              onPress={handleChooseCard}
              disabled={!selectedPlanId}
              activeOpacity={0.85}
            >
              <CreditCard size={16} color={selectedPlanId ? colors.textPrimary : colors.textMuted} style={{ marginRight: 6 }} />
              <Text style={styles.cardBtnText}>
                Pay by Card{selectedPlan ? ` — $${depositAmt(selectedPlan, storageType)}` : ''}
              </Text>
            </TouchableOpacity>
            {!selectedPlanId && (
              <Text style={styles.helpTextCenter}>Select a plan to enable payment.</Text>
            )}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl * 2 },
  center: { justifyContent: 'center', padding: spacing.md },

  backRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: spacing.md, marginTop: spacing.lg },
  backText: { fontSize: 13, color: colors.textSecondary },

  pageTitle: { fontSize: 20, fontWeight: '600', color: colors.textPrimary, marginBottom: 4 },
  pageSubtitle: { fontSize: 13, color: colors.textSecondary, lineHeight: 19, marginBottom: spacing.lg },

  inputLabel: { fontSize: 13, fontWeight: '500', color: colors.textPrimary, marginBottom: 5 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
    color: colors.textPrimary, backgroundColor: colors.surface,
    marginBottom: spacing.md,
  },
  textArea: { minHeight: 90, textAlignVertical: 'top' },

  typeRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  typeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 2, borderColor: colors.border, borderRadius: radius.lg,
    backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingVertical: 10,
  },
  typeBtnActive: { borderColor: colors.primary, backgroundColor: colors.primaryLighter },
  typeBtnLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  typeBtnSub: { fontSize: 11, color: colors.textMuted },

  planCard: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 2, borderColor: colors.border, borderRadius: radius.lg,
    backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingVertical: 12,
    marginBottom: spacing.sm,
  },
  planCardActive: { borderColor: colors.primary, backgroundColor: colors.primaryLighter },
  planLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  planPrice: { fontSize: 14, fontWeight: '600', color: colors.textSecondary },
  radio: {
    width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  radioInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },

  helpText: { fontSize: 11, color: colors.textMuted, marginBottom: spacing.md, lineHeight: 16 },
  helpTextCenter: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: spacing.xs },

  depositNotice: {
    backgroundColor: colors.warningBg, borderWidth: 1, borderColor: '#fde68a',
    borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md,
  },
  depositNoticeText: { fontSize: 13, color: '#92400e', lineHeight: 19 },

  errorText: { fontSize: 13, color: colors.error, marginBottom: spacing.sm },

  paypalBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#003087', borderRadius: radius.md,
    paddingVertical: 14, marginBottom: spacing.sm,
  },
  paypalPay: { fontSize: 16, fontWeight: '400', color: '#009cde', letterSpacing: 0.2 },
  paypalPal: { fontSize: 16, fontWeight: '800', color: '#009cde', letterSpacing: 0.2 },

  cardBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface, borderRadius: radius.md,
    paddingVertical: 13, borderWidth: 1.5, borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  cardBtnText: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  btnDisabled: { opacity: 0.45 },

  awaitingBanner: { backgroundColor: colors.infoBg, borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.sm },
  awaitingText: { fontSize: 13, color: colors.info, lineHeight: 18, textAlign: 'center' },
  verifyBtn: { backgroundColor: colors.success, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', marginBottom: spacing.sm },
  verifyBtnText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  cancelBtn: { paddingVertical: 12, alignItems: 'center' },
  cancelBtnText: { fontSize: 15, color: colors.textSecondary, fontWeight: '500' },

  primaryBtn: {
    backgroundColor: colors.primary, borderRadius: radius.md,
    paddingHorizontal: spacing.lg, paddingVertical: 11, marginTop: spacing.md,
  },
  primaryBtnText: { fontSize: 14, fontWeight: '600', color: '#fff' },

  submittedCard: { padding: spacing.lg, alignItems: 'center' },
  submittedIcon: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: '#dcfce7',
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md,
  },
  submittedTitle: { fontSize: 17, fontWeight: '600', color: colors.textPrimary, marginBottom: spacing.sm },
  submittedBody: { fontSize: 13, color: colors.textSecondary, lineHeight: 19, textAlign: 'center' },
});
