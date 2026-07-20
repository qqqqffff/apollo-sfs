import React, { useState } from 'react';
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { AppleButton } from '@invertase/react-native-apple-authentication';
import Svg, { Path } from 'react-native-svg';
import { login, loginWithIdp } from '../api/auth';
import { useAuth } from '../context/AuthContext';
import { colors, radius, spacing } from '../theme';

export default function LoginScreen({ navigation }: { navigation: any }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { refreshProfile } = useAuth();

  const handleLogin = async () => {
    if (!email.trim() || !password) return;
    setLoading(true);
    try {
      await login(email.trim(), password);
      await refreshProfile();
    } catch {
      Alert.alert('Login failed', 'Invalid email or password.');
    } finally {
      setLoading(false);
    }
  };

  const handleApple = async () => {
    try {
      // Keycloak identity-provider brokering (kc_idp_hint=apple), same as Google.
      // Native Apple Sign-In can't mint Keycloak tokens on this server, so the
      // browser flow is used instead.
      await loginWithIdp('apple');
      await refreshProfile();
    } catch (e: any) {
      const cancelled = String(e?.message ?? '').toLowerCase().includes('cancel');
      if (cancelled) return;
      if (e?.response?.status === 403) {
        Alert.alert('No account yet', 'Sign up with your invitation code first, then sign in with Apple.');
        return;
      }
      Alert.alert('Apple sign-in failed', e?.message ?? 'Could not sign in with Apple.');
    }
  };

  const handleGoogle = async () => {
    try {
      // Keycloak identity-provider brokering: opens the system browser, lets the
      // user sign in with Google, and returns realm tokens. No native Google
      // Sign-In and no backend token exchange.
      await loginWithIdp('google');
      await refreshProfile();
    } catch (e: any) {
      // react-native-app-auth throws when the user dismisses the browser.
      const cancelled = String(e?.message ?? '').toLowerCase().includes('cancel');
      if (cancelled) return;
      if (e?.response?.status === 403) {
        Alert.alert('No account yet', 'Sign up with your invitation code first, then sign in with Google.');
        return;
      }
      Alert.alert('Google sign-in failed', e?.message ?? 'Could not sign in with Google.');
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Image source={require('../assets/app-icon.png')} style={styles.appIcon} />
        <Text style={styles.title}>Apollo SFS</Text>
        <Text style={styles.subtitle}>Sign in to your account</Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.inputLabel}>Email</Text>
        <TextInput
          style={styles.input}
          placeholder="you@example.com"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />

        <Text style={styles.inputLabel}>Password</Text>
        <TextInput
          style={styles.input}
          placeholder="••••••••"
          placeholderTextColor={colors.textMuted}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        <TouchableOpacity
          style={[styles.primaryButton, loading && styles.buttonDisabled]}
          onPress={handleLogin}
          disabled={loading}
        >
          <Text style={styles.primaryButtonText}>{loading ? 'Signing in…' : 'Sign In'}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or continue with</Text>
        <View style={styles.dividerLine} />
      </View>

      <View style={styles.socialGroup}>
        {Platform.OS === 'ios' && (
          <AppleButton
            buttonStyle={AppleButton.Style.BLACK}
            buttonType={AppleButton.Type.SIGN_IN}
            style={styles.appleButton}
            onPress={handleApple}
          />
        )}

        <TouchableOpacity style={styles.googleButton} onPress={handleGoogle} activeOpacity={0.8}>
          <Svg width={18} height={18} viewBox="0 0 18 18">
            <Path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
            <Path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
            <Path fill="#FBBC05" d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"/>
            <Path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58z"/>
          </Svg>
          <Text style={styles.googleButtonText}>Sign in with Google</Text>
        </TouchableOpacity>
      </View>

      {/* Account request — same form + refundable deposit flow as the web
          /interest page (Apollo SFS is invite-only). */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Don't have an account?{' '}
          <Text style={styles.footerLink} onPress={() => navigation.navigate('AccountRequest')}>
            Request access
          </Text>
        </Text>
      </View>

    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface, padding: spacing.lg },

  header: { marginTop: spacing.xl * 2, marginBottom: spacing.xl },
  appIcon: { width: 80, height: 80, borderRadius: 18, marginBottom: spacing.md },
  title: { fontSize: 30, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.xs },
  subtitle: { fontSize: 16, color: colors.textSecondary },

  form: { marginBottom: spacing.lg },
  inputLabel: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: spacing.xs },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    marginBottom: spacing.md,
  },

  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  buttonDisabled: { opacity: 0.6 },
  primaryButtonText: { color: colors.surface, fontWeight: '600', fontSize: 16 },

  dividerRow: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing.lg },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { fontSize: 13, color: colors.textMuted, marginHorizontal: spacing.sm },

  socialGroup: { gap: spacing.sm },
  appleButton: { width: '100%', height: 48 },
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    height: 48,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dadce0',
    borderRadius: radius.md,
  },
  googleButtonText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#3c4043',
    letterSpacing: 0.25,
  },

  footer: { marginTop: 'auto', paddingTop: spacing.xl, alignItems: 'center' },
  footerText: { fontSize: 14, color: colors.textSecondary },
  footerLink: { color: colors.primary, fontWeight: '600' },
});
