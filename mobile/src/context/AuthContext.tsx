import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { clearTokens, getStoredTokens } from '../api/client';
import { getMe } from '../api/auth';

interface UserProfile {
  username: string;
  email: string;
  storage_used_bytes: number;
  storage_quota_bytes: number;
  is_admin: boolean;
}

interface AuthContextValue {
  isLoading: boolean;
  isAuthenticated: boolean;
  profile: UserProfile | null;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  isLoading: true,
  isAuthenticated: false,
  profile: null,
  signOut: async () => {},
  refreshProfile: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  const loadSession = useCallback(async () => {
    try {
      const { access } = await getStoredTokens();
      if (!access) {
        setProfile(null);
        return;
      }
      const me = await getMe();
      setProfile(me);
    } catch {
      setProfile(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  const signOut = useCallback(async () => {
    await clearTokens();
    setProfile(null);
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const me = await getMe();
      setProfile(me);
    } catch {
      setProfile(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isLoading,
        isAuthenticated: profile !== null,
        profile,
        signOut,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
