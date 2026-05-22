import React from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { AuthProvider } from './src/context/AuthContext';
import { SyncProvider } from './src/context/SyncContext';
import AppNavigator from './src/navigation/AppNavigator';
import { GOOGLE_CLIENT_ID } from './src/config';

GoogleSignin.configure({ webClientId: GOOGLE_CLIENT_ID });

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
