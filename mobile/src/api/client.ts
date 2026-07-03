import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { secureStorage } from '../utils/storage';
import { API_BASE_URL } from '../config';
import { brokerRefresh } from './oidc';

export const BASE_URL = API_BASE_URL;

const STORE_KEY_ACCESS = 'apollo_access_token';
const STORE_KEY_REFRESH = 'apollo_refresh_token';
const STORE_KEY_METHOD = 'apollo_auth_method';

// How the current tokens were obtained — determines how they get refreshed:
//  - 'password': minted by the backend for apollo-sfs-api; refreshed via the backend.
//  - 'broker':   minted by Keycloak for apollo-sfs-mobile (social login); refreshed
//                client-side via react-native-app-auth. The backend cannot refresh
//                these, since they belong to a different Keycloak client.
export type AuthMethod = 'password' | 'broker';

export async function getStoredTokens() {
  const [access, refresh] = await Promise.all([
    secureStorage.getItem(STORE_KEY_ACCESS),
    secureStorage.getItem(STORE_KEY_REFRESH),
  ]);
  return { access, refresh };
}

export async function getAuthMethod(): Promise<AuthMethod> {
  const m = await secureStorage.getItem(STORE_KEY_METHOD);
  return m === 'broker' ? 'broker' : 'password';
}

// Persists a token pair. Pass `method` at login time to record how the tokens
// were obtained; omit it on routine rotation so the existing method is kept.
export async function storeTokens(access: string, refresh: string, method?: AuthMethod) {
  await Promise.all([
    secureStorage.setItem(STORE_KEY_ACCESS, access),
    secureStorage.setItem(STORE_KEY_REFRESH, refresh),
    method ? secureStorage.setItem(STORE_KEY_METHOD, method) : Promise.resolve(),
  ]);
}

export async function clearTokens() {
  await Promise.all([
    secureStorage.removeItem(STORE_KEY_ACCESS).catch(() => {}),
    secureStorage.removeItem(STORE_KEY_REFRESH).catch(() => {}),
    secureStorage.removeItem(STORE_KEY_METHOD).catch(() => {}),
  ]);
}

let onAuthFailure: (() => void) | null = null;
export function setAuthFailureHandler(cb: () => void) {
  onAuthFailure = cb;
}

const api = axios.create({ baseURL: BASE_URL });

api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const { access, refresh } = await getStoredTokens();
  if (access) {
    config.headers.Authorization = `Bearer ${access}`;
  }
  // Only password-session refresh tokens belong to the backend's Keycloak client.
  // Brokered refresh tokens are useless to it and shouldn't be exposed, so the
  // backend's proactive-refresh header is sent only for password sessions.
  if (refresh && (await getAuthMethod()) === 'password') {
    config.headers['X-Refresh-Token'] = refresh;
  }
  return config;
});

let isRefreshing = false;
let pendingQueue: Array<{
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}> = [];

function drainQueue(token: string | null, error?: unknown) {
  pendingQueue.forEach((p) => (token ? p.resolve(token) : p.reject(error)));
  pendingQueue = [];
}

// Refreshes a password session through the backend (apollo-sfs-api client).
async function refreshPasswordTokens(refreshToken: string): Promise<string> {
  const res = await axios.post<{ access_token: string; refresh_token: string }>(
    `${BASE_URL}/api/v1/mobile/auth/refresh`,
    { refresh_token: refreshToken },
  );
  await storeTokens(res.data.access_token, res.data.refresh_token, 'password');
  return res.data.access_token;
}

// Refreshes a brokered (social-login) session directly against Keycloak.
async function refreshBrokerTokens(refreshToken: string): Promise<string> {
  const result = await brokerRefresh(refreshToken);
  // Keycloak rotates refresh tokens; keep the old one if no new one is returned.
  await storeTokens(result.accessToken, result.refreshToken || refreshToken, 'broker');
  return result.accessToken;
}

api.interceptors.response.use(
  async (response) => {
    const newAccess = response.headers['x-new-access-token'];
    const newRefresh = response.headers['x-new-refresh-token'];
    if (newAccess && newRefresh) {
      await storeTokens(newAccess, newRefresh);
    }
    return response;
  },
  async (error: AxiosError) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (error.response?.status !== 401 || original._retry) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        pendingQueue.push({ resolve, reject });
      }).then((token) => {
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      });
    }

    original._retry = true;
    isRefreshing = true;

    try {
      const { refresh } = await getStoredTokens();
      if (!refresh) return Promise.reject(error);

      const accessToken =
        (await getAuthMethod()) === 'broker'
          ? await refreshBrokerTokens(refresh)
          : await refreshPasswordTokens(refresh);

      drainQueue(accessToken);
      original.headers.Authorization = `Bearer ${accessToken}`;
      return api(original);
    } catch (refreshError) {
      drainQueue(null, refreshError);
      await clearTokens();
      onAuthFailure?.();
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);

export default api;
