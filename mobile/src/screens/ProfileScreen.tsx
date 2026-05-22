import React, { useState } from 'react';
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { linkSocial, unlinkSocial } from '../api/auth';
import { useAuth } from '../context/AuthContext';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = 'REPLACE_WITH_GOOGLE_CLIENT_ID';

export default function ProfileScreen() {
  const { profile, signOut } = useAuth();
  const [linking, setLinking] = useState(false);

  const handleLinkApple = async () => {
    if (!Platform.OS === 'ios') return;
    setLinking(true);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
      });
      if (!credential.identityToken) throw new Error('No token');
      await linkSocial('apple', credential.identityToken);
      Alert.alert('Apple ID linked');
    } catch (e: any) {
      if (e.code !== 'ERR_CANCELED') Alert.alert('Failed to link Apple ID', e.message);
    } finally {
      setLinking(false);
    }
  };

  const handleUnlinkApple = async () => {
    try {
      await unlinkSocial('apple');
      Alert.alert('Apple ID unlinked');
    } catch (e: any) {
      Alert.alert('Failed', e.message);
    }
  };

  const discovery = AuthSession.useAutoDiscovery('https://accounts.google.com');
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_CLIENT_ID,
      scopes: ['openid', 'email'],
      responseType: AuthSession.ResponseType.IdToken,
    },
    discovery,
  );

  React.useEffect(() => {
    if (response?.type === 'success') {
      const idToken = response.params.id_token;
      if (idToken) {
        linkSocial('google', idToken)
          .then(() => Alert.alert('Google account linked'))
          .catch((e) => Alert.alert('Failed to link Google', e.message));
      }
    }
  }, [response]);

  const usedPct =
    profile && profile.storage_quota_bytes > 0
      ? ((profile.storage_used_bytes / profile.storage_quota_bytes) * 100).toFixed(1)
      : '0';

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.label}>Username</Text>
        <Text style={styles.value}>{profile?.username}</Text>

        <Text style={styles.label}>Email</Text>
        <Text style={styles.value}>{profile?.email}</Text>

        <Text style={styles.label}>Storage</Text>
        <Text style={styles.value}>{usedPct}% used</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Linked Accounts</Text>

        {Platform.OS === 'ios' && (
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Apple ID</Text>
            <View style={styles.rowActions}>
              <TouchableOpacity onPress={handleLinkApple} disabled={linking}>
                <Text style={styles.link}>Link</Text>
              </TouchableOpacity>
              <Text style={styles.sep}> · </Text>
              <TouchableOpacity onPress={handleUnlinkApple}>
                <Text style={styles.unlink}>Unlink</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.row}>
          <Text style={styles.rowLabel}>Google</Text>
          <View style={styles.rowActions}>
            <TouchableOpacity onPress={() => promptAsync()} disabled={!request}>
              <Text style={styles.link}>Link</Text>
            </TouchableOpacity>
            <Text style={styles.sep}> · </Text>
            <TouchableOpacity onPress={() => unlinkSocial('google').catch(() => {})}>
              <Text style={styles.unlink}>Unlink</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      <TouchableOpacity style={styles.signOutButton} onPress={signOut}>
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  section: { backgroundColor: '#fff', margin: 16, borderRadius: 12, padding: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 12 },
  label: { fontSize: 12, color: '#6b7280', marginTop: 8 },
  value: { fontSize: 16, fontWeight: '500', marginTop: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  rowLabel: { fontSize: 15 },
  rowActions: { flexDirection: 'row', alignItems: 'center' },
  link: { color: '#1a56db' },
  unlink: { color: '#ef4444' },
  sep: { color: '#9ca3af' },
  signOutButton: { margin: 16, backgroundColor: '#ef4444', borderRadius: 8, padding: 14, alignItems: 'center' },
  signOutText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});
