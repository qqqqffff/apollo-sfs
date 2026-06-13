import '@testing-library/jest-native/extend-expect';

// ─── AsyncStorage ─────────────────────────────────────────────────────────────

const asyncStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) => Promise.resolve(asyncStore.get(key) ?? null)),
  setItem: jest.fn((key: string, value: string) => {
    asyncStore.set(key, value);
    return Promise.resolve();
  }),
  removeItem: jest.fn((key: string) => {
    asyncStore.delete(key);
    return Promise.resolve();
  }),
  clear: jest.fn(() => {
    asyncStore.clear();
    return Promise.resolve();
  }),
}));

// ─── NetInfo ──────────────────────────────────────────────────────────────────

jest.mock('@react-native-community/netinfo', () => ({
  fetch: jest.fn(() => Promise.resolve({ type: 'wifi', isConnected: true })),
  addEventListener: jest.fn(() => () => {}),
}));

// ─── Camera roll ──────────────────────────────────────────────────────────────

jest.mock('@react-native-camera-roll/camera-roll', () => ({
  CameraRoll: {
    getPhotos: jest.fn(() =>
      Promise.resolve({ edges: [], page_info: { has_next_page: false } }),
    ),
    deletePhotos: jest.fn(() => Promise.resolve()),
  },
}));

// ─── Permissions ──────────────────────────────────────────────────────────────

jest.mock('react-native-permissions', () => ({
  check: jest.fn(() => Promise.resolve('granted')),
  request: jest.fn(() => Promise.resolve('granted')),
  PERMISSIONS: {
    IOS: { PHOTO_LIBRARY: 'ios.permission.PHOTO_LIBRARY' },
    ANDROID: { READ_MEDIA_IMAGES: 'android.permission.READ_MEDIA_IMAGES' },
  },
  RESULTS: { GRANTED: 'granted', LIMITED: 'limited' },
}));

// ─── BlobUtil ─────────────────────────────────────────────────────────────────

jest.mock('react-native-blob-util', () => ({
  config: jest.fn(() => ({
    fetch: jest.fn(() => Promise.resolve({ path: () => '/tmp/test-asset' })),
  })),
  fs: {
    hash: jest.fn(() => Promise.resolve('abc123deadbeef')),
    unlink: jest.fn(() => Promise.resolve()),
  },
}));

// ─── Background fetch ─────────────────────────────────────────────────────────

jest.mock('react-native-background-fetch', () => ({
  configure: jest.fn(() => Promise.resolve(0)),
  scheduleTask: jest.fn(() => Promise.resolve()),
  start: jest.fn(() => Promise.resolve(0)),
  stop: jest.fn(() => Promise.resolve()),
  STATUS_AVAILABLE: 0,
  STATUS_DENIED: 1,
  STATUS_RESTRICTED: 2,
}));

// ─── Document picker ──────────────────────────────────────────────────────────

jest.mock('react-native-document-picker', () => ({
  pick: jest.fn(() => Promise.resolve([])),
  pickSingle: jest.fn(() => Promise.resolve(null)),
  isCancel: jest.fn(() => false),
}));

// ─── Encrypted storage ────────────────────────────────────────────────────────

const encStore = new Map<string, string>();
jest.mock('react-native-encrypted-storage', () => ({
  setItem: jest.fn((key: string, value: string) => {
    encStore.set(key, value);
    return Promise.resolve();
  }),
  getItem: jest.fn((key: string) => Promise.resolve(encStore.get(key) ?? null)),
  removeItem: jest.fn((key: string) => {
    encStore.delete(key);
    return Promise.resolve();
  }),
}));

// ─── Auth providers ───────────────────────────────────────────────────────────

jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(() => Promise.resolve(true)),
    signIn: jest.fn(),
  },
}));

jest.mock('@invertase/react-native-apple-authentication', () => ({
  appleAuth: {
    performRequest: jest.fn(),
    onCredentialRevoked: jest.fn(() => () => {}),
    Operation: { LOGIN: 0 },
    Scope: { FULL_NAME: 0, EMAIL: 1 },
  },
  AppleButton: () => null,
}));

// ─── Gesture handler ──────────────────────────────────────────────────────────

jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
  PanGestureHandler: ({ children }: { children: React.ReactNode }) => children,
  TapGestureHandler: ({ children }: { children: React.ReactNode }) => children,
  State: {},
  Directions: {},
}));

// ─── SVG + Lucide ─────────────────────────────────────────────────────────────

jest.mock('react-native-svg', () => ({
  Svg: () => null,
  Path: () => null,
  Circle: () => null,
  Rect: () => null,
  G: () => null,
  default: () => null,
}));

jest.mock('lucide-react-native', () =>
  new Proxy({}, { get: () => () => null }),
);
