import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const API_BASE = '/api/v1';

export const useProfile = (token: string) => {
  return useQuery({
    queryKey: ['profile'],
    queryFn: () => fetch(`${API_BASE}/user/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(res => res.json()),
  });
};

export const useQuota = (token: string) => {
  return useQuery({
    queryKey: ['quota'],
    queryFn: () => fetch(`${API_BASE}/user/quota`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(res => res.json()),
  });
};

export const useLogin = () => {
  return useMutation({
    mutationFn: ({ username, password }: { username: string; password: string }) =>
      fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }).then(res => res.json()),
  });
};

export const useSignup = () => {
  return useMutation({
    mutationFn: ({ username, email, password }: { username: string; email: string; password: string }) =>
      fetch(`${API_BASE}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      }).then(res => res.json()),
  });
};

export const useRefreshToken = () => {
  return useMutation({
    mutationFn: (refreshToken: string) =>
      fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).then(res => res.json()),
  });
};

export const useLogout = () => {
  return useMutation({
    mutationFn: (refreshToken: string) =>
      fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).then(res => res.json()),
  });
};