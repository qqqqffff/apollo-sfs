import api, { BASE_URL, storeTokens, clearTokens } from './client';
import { brokerAuthorize, type IdpHint } from './oidc';

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in?: number;
}

export async function login(email: string, password: string): Promise<TokenResponse> {
  const res = await api.post<TokenResponse>('/api/v1/mobile/auth/login', { email, password });
  await storeTokens(res.data.access_token, res.data.refresh_token, 'password');
  return res.data;
}

export async function loginWithApple(identityToken: string): Promise<TokenResponse> {
  const res = await api.post<TokenResponse>('/api/v1/mobile/auth/apple', {
    identity_token: identityToken,
  });
  await storeTokens(res.data.access_token, res.data.refresh_token, 'password');
  return res.data;
}

// Social login via Keycloak identity-provider brokering. Opens the system
// browser, runs the OIDC Authorization Code + PKCE flow against Keycloak
// (jumping straight to the chosen provider via kc_idp_hint), stores the returned
// realm tokens, and provisions the app-side user record for first-time users.
export async function loginWithIdp(idp: IdpHint): Promise<void> {
  const result = await brokerAuthorize(idp);
  await storeTokens(result.accessToken, result.refreshToken, 'broker');
  // Brokered logins bypass the backend login path where provisioning runs, so
  // trigger it explicitly. The request interceptor attaches the stored token.
  await api.post('/api/v1/mobile/auth/session');
}

export async function logout(): Promise<void> {
  await clearTokens();
}

export async function linkSocial(provider: 'apple' | 'google', token: string): Promise<void> {
  await api.post('/api/v1/me/social/link', { provider, token });
}

export async function linkSocialGoogle(serverAuthCode: string): Promise<void> {
  await api.post('/api/v1/me/social/link', { provider: 'google', server_auth_code: serverAuthCode });
}

export async function unlinkSocial(provider: 'apple' | 'google'): Promise<void> {
  await api.delete('/api/v1/me/social/unlink', { data: { provider } });
}

export async function getMe() {
  const res = await api.get('/api/v1/me');
  return res.data;
}
