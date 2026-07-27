import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { ArrowLeft, Check, MailCheck, ShieldCheck, X } from 'lucide-react-native';
import { changePassword, requestPasswordChangeCode } from '../api/me';
import { card, colors, radius, spacing } from '../theme';
import { getPasswordChecks, PASSWORD_CHECK_LABELS } from '../utils/passwordPolicy';

function getChecks(newPassword: string, confirm: string) {
  return {
    ...getPasswordChecks(newPassword),
    match: newPassword.length > 0 && newPassword === confirm,
  };
}

function CheckItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <View style={styles.checkRow}>
      {ok ? <Check size={13} color={colors.success} /> : <X size={13} color={colors.error} />}
      <Text style={[styles.checkText, { color: ok ? colors.success : colors.error }]}>{label}</Text>
    </View>
  );
}

// Two-step flow, same as the web change-password page: request an emailed
// one-time code, then submit it with the current + new passwords.
export default function ChangePasswordScreen() {
  const navigation = useNavigation<any>();

  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [current, setCurrent] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  const checks = getChecks(newPw, confirm);
  const allValid = Object.values(checks).every(Boolean);

  const handleRequestCode = async () => {
    setPending(true);
    setError(null);
    try {
      await requestPasswordChangeCode();
      setCodeSent(true);
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Failed to send code');
    } finally {
      setPending(false);
    }
  };

  const handleSubmit = async () => {
    setPending(true);
    setError(null);
    try {
      await changePassword(current, newPw, code.trim());
      setDone(true);
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Failed to change password');
    } finally {
      setPending(false);
    }
  };

  if (done) {
    return (
      <View style={styles.container}>
        <View style={[card, styles.doneCard]}>
          <Check size={44} color={colors.success} />
          <Text style={styles.doneTitle}>Password changed</Text>
          <Text style={styles.doneBody}>Your password has been updated successfully.</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.primaryBtnText}>Back to profile</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <TouchableOpacity style={styles.backRow} onPress={() => navigation.goBack()}>
          <ArrowLeft size={16} color={colors.textSecondary} />
          <Text style={styles.backText}>Back to profile</Text>
        </TouchableOpacity>

        <Text style={styles.pageTitle}>Change password</Text>

        <View style={[card, styles.cardPad]}>
          <View style={styles.introRow}>
            <View style={styles.introIcon}>
              <ShieldCheck size={18} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.introTitle}>Two-factor verification</Text>
              <Text style={styles.introBody}>
                For your security, changing your password requires a one-time code sent to your
                account's email address.
              </Text>
            </View>
          </View>

          {!codeSent ? (
            <>
              <Text style={styles.bodyText}>
                We'll email a 6-digit code to verify it's you. The code expires in 10 minutes.
              </Text>
              {error && <Text style={styles.errorText}>{error}</Text>}
              <TouchableOpacity style={styles.primaryBtn} onPress={handleRequestCode} disabled={pending}>
                {pending
                  ? <ActivityIndicator color="#fff" size="small" />
                  : (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <MailCheck size={15} color="#fff" />
                      <Text style={styles.primaryBtnText}>Email me a code</Text>
                    </View>
                  )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <View style={styles.sentBanner}>
                <MailCheck size={15} color={colors.success} />
                <Text style={styles.sentBannerText}>A verification code was sent to your email.</Text>
                <TouchableOpacity onPress={handleRequestCode} disabled={pending}>
                  <Text style={styles.resendText}>{pending ? 'Resending…' : 'Resend'}</Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.inputLabel}>Verification code</Text>
              <TextInput
                style={styles.input}
                value={code}
                onChangeText={(t) => { setCode(t); setError(null); }}
                keyboardType="number-pad"
                placeholder="6-digit code"
                placeholderTextColor={colors.textMuted}
              />

              <Text style={styles.inputLabel}>Current password</Text>
              <TextInput
                style={styles.input}
                value={current}
                onChangeText={(t) => { setCurrent(t); setError(null); }}
                secureTextEntry
              />

              <Text style={styles.inputLabel}>New password</Text>
              <TextInput
                style={styles.input}
                value={newPw}
                onChangeText={setNewPw}
                onFocus={() => setTouched(true)}
                secureTextEntry
              />

              <Text style={styles.inputLabel}>Confirm new password</Text>
              <TextInput
                style={styles.input}
                value={confirm}
                onChangeText={setConfirm}
                onFocus={() => setTouched(true)}
                secureTextEntry
              />

              {touched && (
                <View style={{ gap: 3, marginBottom: spacing.sm }}>
                  {PASSWORD_CHECK_LABELS.map(([key, label]) => (
                    <CheckItem key={key} ok={checks[key]} label={label} />
                  ))}
                  <CheckItem ok={checks.match} label="Passwords match" />
                </View>
              )}

              {error && <Text style={styles.errorText}>{error}</Text>}

              <TouchableOpacity
                style={[styles.primaryBtn, (!code.trim() || !current || !allValid || pending) && styles.btnDisabled]}
                onPress={handleSubmit}
                disabled={!code.trim() || !current || !allValid || pending}
              >
                <Text style={styles.primaryBtnText}>{pending ? 'Saving…' : 'Update password'}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },

  backRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: spacing.sm },
  backText: { fontSize: 13, color: colors.textSecondary },
  pageTitle: { fontSize: 18, fontWeight: '600', color: colors.textPrimary, marginBottom: spacing.md },

  cardPad: { padding: spacing.md },
  introRow: {
    flexDirection: 'row', gap: spacing.sm,
    paddingBottom: spacing.md, marginBottom: spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.divider,
  },
  introIcon: {
    width: 36, height: 36, borderRadius: radius.md,
    backgroundColor: colors.infoBg, alignItems: 'center', justifyContent: 'center',
  },
  introTitle: { fontSize: 14, fontWeight: '600', color: colors.textPrimary },
  introBody: { fontSize: 12, color: colors.textSecondary, marginTop: 2, lineHeight: 17 },

  bodyText: { fontSize: 13, color: colors.textSecondary, marginBottom: spacing.md, lineHeight: 18 },
  errorText: { fontSize: 12, color: colors.error, marginBottom: spacing.sm },

  sentBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.successBg, borderWidth: 1, borderColor: '#bbf7d0',
    borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8,
    marginBottom: spacing.md,
  },
  sentBannerText: { flex: 1, fontSize: 12, color: '#15803d' },
  resendText: { fontSize: 12, fontWeight: '600', color: '#15803d' },

  inputLabel: { fontSize: 12, color: colors.textSecondary, marginBottom: 4 },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 9, fontSize: 15,
    color: colors.textPrimary, backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },

  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  checkText: { fontSize: 12 },

  primaryBtn: {
    backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: 11, alignItems: 'center', alignSelf: 'flex-start',
    paddingHorizontal: spacing.md, marginTop: spacing.xs,
  },
  primaryBtnText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  btnDisabled: { opacity: 0.5 },

  doneCard: { margin: spacing.md, padding: spacing.lg, alignItems: 'center', gap: spacing.sm },
  doneTitle: { fontSize: 17, fontWeight: '600', color: colors.textPrimary },
  doneBody: { fontSize: 13, color: colors.textSecondary, textAlign: 'center' },
});
