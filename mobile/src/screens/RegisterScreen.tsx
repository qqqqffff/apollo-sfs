import React, { useEffect, useState } from 'react';
import {
  Alert,
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
import appleAuth, { AppleButton } from '@invertase/react-native-apple-authentication';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import api from '../api/client';
import { loginWithApple, loginWithGoogle, storeTokens } from '../api/auth';
import { useAuth } from '../context/AuthContext';
import { colors, radius, spacing } from '../theme';

export default function RegisterScreen({
  navigation,
  route,
}: {
  navigation: any;
  route: any;
}) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken, setInviteToken] = useState(route?.params?.token ?? '');
  const [loading, setLoading] = useState(false);
  const { refreshProfile } = useAuth();

  // Pre-fill invite token from deep link arriving while screen is mounted.
  useEffect(() => {
    const handleURL = ({ url }: { url: string }) => {
      try {
        const parsed = new URL(url);
        const token = parsed.searchParams.get('token');
        if (token) setInviteToken(token);
      } catch {
        // malformed URL — ignore
      }
    };
    const sub = Linking.addEventListener('url', handleURL);
    return () => sub.remove();
  }, []);

  const handleRegister = async () => {
    if (!username.trim() || !email.trim() || !password || !inviteToken.trim()) {
      Alert.alert('Missing fields', 'All fields including the invite token are required.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/api/v1/auth/register', {
        username: username.trim(),
        email: email.trim(),
        password,
        invite_token: inviteToken.trim(),
      });
      const res = await api.post('/api/v1/mobile/auth/login', {
        username: username.trim(),
        password,
      });
      await storeTokens(res.data.access_token, res.data.refresh_token);
      await refreshProfile();
    } catch (e: any) {
      Alert.alert('Registration failed', e?.response?.data?.error ?? e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleApple = async () => {
    try {
      const credential = await appleAuth.performRequest({
        requestedOperation: appleAuth.Operation.LOGIN,
        requestedScopes: [appleAuth.Scope.FULL_NAME, appleAuth.Scope.EMAIL],
      });
      if (!credential.identityToken) throw new Error('No identity token');
      await loginWithApple(credential.identityToken);
      await refreshProfile();
    } catch (e: any) {
      if (e.code !== appleAuth.Error.CANCELED) Alert.alert('Apple sign-in failed', e.message);
    }
  };

  const handleGoogle = async () => {
    try {
      await GoogleSignin.hasPlayServices();
      const response = await GoogleSignin.signIn();
      const idToken = (response as any).data?.idToken ?? (response as any).idToken;
      if (!idToken) throw new Error('No ID token');
      await loginWithGoogle(idToken);
      await refreshProfile();
    } catch (e: any) {
      if (e.code !== statusCodes.SIGN_IN_CANCELLED) {
        Alert.alert('Google sign-in failed', e.message);
      }
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.outer}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.title}>Create Account</Text>
          <Text style={styles.subtitle}>You'll need an invitation link from an admin.</Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.inputLabel}>Invite Token</Text>
          <TextInput
            style={[styles.input, inviteToken && styles.inputFilled]}
            placeholder="Paste your invite token"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            value={inviteToken}
            onChangeText={setInviteToken}
          />

          <Text style={styles.inputLabel}>Username</Text>
          <TextInput
            style={styles.input}
            placeholder="choose-a-username"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            value={username}
            onChangeText={setUsername}
          />

          <Text style={styles.inputLabel}>Email</Text>
          <TextInput
            style={styles.input}
            placeholder="you@example.com"
            placeholderTextColor={colors.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
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
            onPress={handleRegister}
            disabled={loading}
          >
            <Text style={styles.primaryButtonText}>{loading ? 'Creating account…' : 'Register'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or register with</Text>
          <View style={styles.dividerLine} />
        </View>

        <View style={styles.socialGroup}>
          {Platform.OS === 'ios' && (
            <AppleButton
              buttonStyle={AppleButton.Style.BLACK}
              buttonType={AppleButton.Type.SIGN_UP}
              style={styles.appleButton}
              onPress={handleApple}
            />
          )}

          <TouchableOpacity style={styles.googleButton} onPress={handleGoogle}>
            <Text style={styles.googleButtonText}>Sign up with Google</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.footer} onPress={() => navigation.navigate('Login')}>
          <Text style={styles.footerText}>
            Already have an account?{' '}
            <Text style={styles.footerLink}>Sign in</Text>
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  outer: { flex: 1, backgroundColor: colors.surface },
  container: { flexGrow: 1, padding: spacing.lg },

  header: { marginTop: spacing.xl, marginBottom: spacing.lg },
  title: { fontSize: 28, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.xs },
  subtitle: { fontSize: 15, color: colors.textSecondary },

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
    marginBottom: spacing.md,
  },
  inputFilled: { borderColor: colors.primary, backgroundColor: colors.primaryLighter },

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
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 12,
    alignItems: 'center',
  },
  googleButtonText: { fontSize: 16, fontWeight: '500', color: colors.textPrimary },

  footer: { marginTop: spacing.xl, alignItems: 'center', paddingBottom: spacing.md },
  footerText: { fontSize: 14, color: colors.textSecondary },
  footerLink: { color: colors.primary, fontWeight: '600' },
});
