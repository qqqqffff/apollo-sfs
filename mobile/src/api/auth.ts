import api, { BASE_URL, storeTokens, clearTokens } from './client';

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in?: number;
}

export async function login(username: string, password: string): Promise<TokenResponse> {
  const res = await api.post<TokenResponse>('/api/v1/mobile/auth/login', { username, password });
  await storeTokens(res.data.access_token, res.data.refresh_token);
  return res.data;
}

export async function loginWithApple(identityToken: string): Promise<TokenResponse> {
  const res = await api.post<TokenResponse>('/api/v1/mobile/auth/apple', {
    identity_token: identityToken,
  });
  await storeTokens(res.data.access_token, res.data.refresh_token);
  return res.data;
}

export async function loginWithGoogle(idToken: string): Promise<TokenResponse> {
  const res = await api.post<TokenResponse>('/api/v1/mobile/auth/google', { id_token: idToken });
  await storeTokens(res.data.access_token, res.data.refresh_token);
  return res.data;
}

export async function logout(): Promise<void> {
  await clearTokens();
}

export async function linkSocial(provider: 'apple' | 'google', token: string): Promise<void> {
  await api.post('/api/v1/me/social/link', { provider, token });
}

export async function unlinkSocial(provider: 'apple' | 'google'): Promise<void> {
  await api.delete('/api/v1/me/social/unlink', { data: { provider } });
}

export async function getMe() {
  const res = await api.get('/api/v1/me');
  return res.data;
}
