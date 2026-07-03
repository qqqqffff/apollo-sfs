import React from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { AuthProvider } from './src/context/AuthContext';
import { SyncProvider } from './src/context/SyncContext';
import AppNavigator from './src/navigation/AppNavigator';
import { GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID } from './src/config';

GoogleSignin.configure({
  webClientId: GOOGLE_CLIENT_ID,
  iosClientId: GOOGLE_IOS_CLIENT_ID,
  scopes: [
    'https://www.googleapis.com/auth/drive',
    // photoslibrary.readonly was removed by Google on 2025-03-31 — library-wide
    // listing now 403s. Reading user photos requires the Photos Picker API scope.
    'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
  ],
});

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <SyncProvider>
          <AppNavigator />
        </SyncProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
