import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { secureStorage } from '../utils/storage';
import { API_BASE_URL } from '../config';

export const BASE_URL = API_BASE_URL;

const STORE_KEY_ACCESS = 'apollo_access_token';
const STORE_KEY_REFRESH = 'apollo_refresh_token';

export async function getStoredTokens() {
  const [access, refresh] = await Promise.all([
    secureStorage.getItem(STORE_KEY_ACCESS),
    secureStorage.getItem(STORE_KEY_REFRESH),
  ]);
  return { access, refresh };
}

export async function storeTokens(access: string, refresh: string) {
  await Promise.all([
    secureStorage.setItem(STORE_KEY_ACCESS, access),
    secureStorage.setItem(STORE_KEY_REFRESH, refresh),
  ]);
}

export async function clearTokens() {
  await Promise.all([
    secureStorage.removeItem(STORE_KEY_ACCESS),
    secureStorage.removeItem(STORE_KEY_REFRESH),
  ]);
}

const api = axios.create({ baseURL: BASE_URL });

api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const { access, refresh } = await getStoredTokens();
  if (access) {
    config.headers.Authorization = `Bearer ${access}`;
  }
  if (refresh) {
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
      if (!refresh) throw new Error('no refresh token');

      const res = await axios.post<{ access_token: string; refresh_token: string }>(
        `${BASE_URL}/api/v1/mobile/auth/refresh`,
        { refresh_token: refresh },
      );
      const { access_token, refresh_token } = res.data;
      await storeTokens(access_token, refresh_token);
      drainQueue(access_token);
      original.headers.Authorization = `Bearer ${access_token}`;
      return api(original);
    } catch (refreshError) {
      drainQueue(null, refreshError);
      await clearTokens();
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);

export default api;
