import React, { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import api from '../api/client';
import { loginWithApple, loginWithGoogle, storeTokens } from '../api/auth';
import { useAuth } from '../context/AuthContext';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = 'REPLACE_WITH_GOOGLE_CLIENT_ID';

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

  // Pre-fill invite token from deep link.
  useEffect(() => {
    const handleURL = ({ url }: { url: string }) => {
      const parsed = Linking.parse(url);
      if (parsed.queryParams?.token) {
        setInviteToken(String(parsed.queryParams.token));
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
      // After registration, log in to obtain mobile tokens.
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
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) throw new Error('No identity token');
      await loginWithApple(credential.identityToken);
      await refreshProfile();
    } catch (e: any) {
      if (e.code !== 'ERR_CANCELED') Alert.alert('Apple sign-in failed', e.message);
    }
  };

  const discovery = AuthSession.useAutoDiscovery('https://accounts.google.com');
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_CLIENT_ID,
      scopes: ['openid', 'email', 'profile'],
      responseType: AuthSession.ResponseType.IdToken,
    },
    discovery,
  );

  useEffect(() => {
    if (response?.type === 'success') {
      const idToken = response.params.id_token;
      if (idToken) {
        loginWithGoogle(idToken)
          .then(() => refreshProfile())
          .catch((e) => Alert.alert('Google sign-in failed', e.message));
      }
    }
  }, [response]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>Create Account</Text>
      <Text style={styles.subtitle}>You'll need an invitation link from an admin.</Text>

      <TextInput style={styles.input} placeholder="Username" autoCapitalize="none" value={username} onChangeText={setUsername} />
      <TextInput style={styles.input} placeholder="Email" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
      <TextInput style={styles.input} placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
      <TextInput style={styles.input} placeholder="Invite token" autoCapitalize="none" value={inviteToken} onChangeText={setInviteToken} />

      <TouchableOpacity style={styles.button} onPress={handleRegister} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? 'Creating account…' : 'Register'}</Text>
      </TouchableOpacity>

      <Text style={styles.orDivider}>— or register with —</Text>

      {Platform.OS === 'ios' && (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={8}
          style={styles.appleButton}
          onPress={handleApple}
        />
      )}

      <TouchableOpacity style={[styles.button, styles.googleButton]} onPress={() => promptAsync()} disabled={!request}>
        <Text style={styles.buttonText}>Sign up with Google</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.navigate('Login')}>
        <Text style={styles.link}>Already have an account? Sign in</Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  subtitle: { textAlign: 'center', color: '#666', marginBottom: 24 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 16 },
  button: { backgroundColor: '#1a56db', borderRadius: 8, padding: 14, alignItems: 'center', marginBottom: 12 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  googleButton: { backgroundColor: '#db4437' },
  appleButton: { width: '100%', height: 48, marginBottom: 12 },
  orDivider: { textAlign: 'center', color: '#888', marginVertical: 8 },
  link: { textAlign: 'center', color: '#1a56db', marginTop: 16 },
});
