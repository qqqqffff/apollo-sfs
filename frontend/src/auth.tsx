import React, { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLogin, useRefreshToken, useLogout } from './services/userService';

interface AuthContextType {
  isAuthenticated: boolean;
  isAdmin: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  token: string | null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const navigate = useNavigate();

  const loginMutation = useLogin();
  const refreshMutation = useRefreshToken();
  const logoutMutation = useLogout();

  useEffect(() => {
    if (token) {
      // Validate token and set roles
      validateToken(token);
    }
  }, [token]);

  const validateToken = async (token: string) => {
    try {
      const response = await fetch('/api/v1/auth/verify', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        setIsAuthenticated(true);
        // Check if admin (assuming realm_access.roles includes 'admin')
        const roles = data.realm_access?.roles || [];
        setIsAdmin(roles.includes('admin'));
      } else {
        logout();
      }
    } catch (error) {
      logout();
    }
  };

  const login = async (username: string, password: string) => {
    try {
      const data = await loginMutation.mutateAsync({ username, password });
      const accessToken = data.access_token;
      localStorage.setItem('token', accessToken);
      setToken(accessToken);
      setIsAuthenticated(true);
      // Set admin based on token
      const roles = data.realm_access?.roles || [];
      setIsAdmin(roles.includes('admin'));
      navigate({ to: '/files' });
    } catch (error) {
      throw error;
    }
  };

  const logout = () => {
    if (token) {
      logoutMutation.mutate(localStorage.getItem('refreshToken') || '');
    }
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    setToken(null);
    setIsAuthenticated(false);
    setIsAdmin(false);
    navigate({ to: '/login' });
  };

  return (
    <AuthContext.Provider value={{ isAuthenticated, isAdmin, login, logout, token }}>
      {children}
    </AuthContext.Provider>
  );
};