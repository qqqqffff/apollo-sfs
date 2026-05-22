import React, { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import appleAuth, { AppleButton } from '@invertase/react-native-apple-authentication';
import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import { login, loginWithApple, loginWithGoogle } from '../api/auth';
import { useAuth } from '../context/AuthContext';

export default function LoginScreen({ navigation }: { navigation: any }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { refreshProfile } = useAuth();

  const handleLogin = async () => {
    if (!username.trim() || !password) return;
    setLoading(true);
    try {
      await login(username.trim(), password);
      await refreshProfile();
    } catch {
      Alert.alert('Login failed', 'Invalid username or password.');
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
      if (e.code !== appleAuth.Error.CANCELED) {
        Alert.alert('Apple sign-in failed', e.message);
      }
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
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>Apollo SFS</Text>

      <TextInput
        style={styles.input}
        placeholder="Username"
        autoCapitalize="none"
        autoCorrect={false}
        value={username}
        onChangeText={setUsername}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      <TouchableOpacity style={styles.button} onPress={handleLogin} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? 'Signing in…' : 'Sign In'}</Text>
      </TouchableOpacity>

      <Text style={styles.orDivider}>— or —</Text>

      {Platform.OS === 'ios' && (
        <AppleButton
          buttonStyle={AppleButton.Style.BLACK}
          buttonType={AppleButton.Type.SIGN_IN}
          style={styles.appleButton}
          onPress={handleApple}
        />
      )}

      <TouchableOpacity style={[styles.button, styles.googleButton]} onPress={handleGoogle}>
        <Text style={styles.buttonText}>Sign in with Google</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.navigate('Register')}>
        <Text style={styles.link}>Don't have an account? Register with an invite</Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center', marginBottom: 32 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#1a56db',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  googleButton: { backgroundColor: '#db4437' },
  appleButton: { width: '100%', height: 48, marginBottom: 12 },
  orDivider: { textAlign: 'center', color: '#888', marginVertical: 8 },
  link: { textAlign: 'center', color: '#1a56db', marginTop: 16 },
});
