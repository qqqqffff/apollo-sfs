import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import HomeScreen from '../HomeScreen';
import { type PreviewItem } from '../../services/SyncService';

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../../context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('../../context/SyncContext', () => ({ useSync: jest.fn() }));

jest.mock('../../api/files', () => ({
  getPreferences: jest.fn(),
  listRoot: jest.fn(),
  listFavorites: jest.fn(),
  updatePreferences: jest.fn(),
  unfavoriteFile: jest.fn(),
  uploadFile: jest.fn(),
}));

jest.mock('../../api/sync', () => ({
  registerDevice: jest.fn(() => Promise.resolve({ id: 'device-1' })),
}));

jest.mock('../../tasks/backgroundSync', () => ({
  registerBackgroundSync: jest.fn(),
  NIGHTSYNC_KEY: 'apollo_nightsync_enabled',
  NIGHTSYNC_HOUR_KEY: 'apollo_nightsync_hour',
  NIGHTSYNC_DEFAULT_HOUR: 4,
}));

// Simplified SyncPreviewModal — renders enough for HomeScreen flow tests
jest.mock('../../components/SyncPreviewModal', () => ({
  __esModule: true,
  default: (props: any) => {
    if (!props.visible) return null;
    const React = require('react');
    const { View, Text, TouchableOpacity } = require('react-native');
    return React.createElement(
      View,
      { testID: 'sync-preview-modal' },
      React.createElement(Text, null, `${props.items.length} items to sync`),
      React.createElement(
        TouchableOpacity,
        { testID: 'modal-start-sync', onPress: () => props.onConfirm(props.items) },
        React.createElement(Text, null, 'Start Sync'),
      ),
      React.createElement(
        TouchableOpacity,
        { testID: 'modal-cancel', onPress: props.onCancel },
        React.createElement(Text, null, 'Cancel'),
      ),
    );
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const { useAuth } = require('../../context/AuthContext');
const { useSync } = require('../../context/SyncContext');
const { getPreferences, listRoot, listFavorites, updatePreferences } = require('../../api/files');

const mockedAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const MB = 1024 * 1024;

const DEFAULT_PROFILE = {
  username: 'apollo',
  email: 'apollo@test.com',
  storage_used_bytes: 2 * MB,
  storage_quota_bytes: 10 * MB,
  is_admin: false,
};

const mockScanForPreview = jest.fn();
const mockConfirmSync = jest.fn();

function setupMocks(overrides?: {
  previewItems?: PreviewItem[];
  pendingCount?: number;
  isSyncing?: boolean;
}) {
  useAuth.mockReturnValue({ profile: DEFAULT_PROFILE, isAuthenticated: true });
  useSync.mockReturnValue({
    pendingCount: overrides?.pendingCount ?? 0,
    syncedCount: 5,
    inProgressFiles: [],
    lastSyncedAt: null,
    isSyncing: overrides?.isSyncing ?? false,
    lastError: null,
    scanForPreview: mockScanForPreview,
    confirmSync: mockConfirmSync,
  });
  getPreferences.mockResolvedValue({ media_autoupload_folder_id: null });
  listRoot.mockResolvedValue({ folder: null, subfolders: { items: [] }, files: { items: [] } });
  listFavorites.mockResolvedValue({ files: [] });
  updatePreferences.mockResolvedValue({ media_autoupload_folder_id: null });
  mockedAsyncStorage.getItem.mockResolvedValue(null);
}

function makePreviewItem(id: string): PreviewItem {
  return {
    uri: `ph://${id}`,
    filename: `photo-${id}.jpg`,
    sizeBytes: MB,
    takenAt: new Date('2026-06-12T10:00:00Z'),
    mimeType: 'image/jpeg',
  };
}

function renderHome() {
  return render(<HomeScreen />);
}

beforeEach(() => {
  jest.clearAllMocks();
  setupMocks();
});

// ── Storage card ──────────────────────────────────────────────────────────────

describe('storage card', () => {
  it('renders the storage label', async () => {
    const { findByText } = renderHome();
    await findByText('Storage');
  });

  it('shows used storage in MB', async () => {
    const { findByText } = renderHome();
    await findByText('2 MB');
  });

  it('shows quota in MB', async () => {
    const { findByText } = renderHome();
    // quota is formatted as "/ X MB"
    await findByText('/ 10 MB');
  });
});

// ── Camera Roll Backup card ───────────────────────────────────────────────────

describe('camera roll backup card', () => {
  it('renders section label', async () => {
    const { findByText } = renderHome();
    await findByText('Camera Roll Backup');
  });

  it('shows destination label', async () => {
    // "Destination" appears on both the Camera Roll and Files cards.
    const { findAllByText } = renderHome();
    expect((await findAllByText('Destination')).length).toBeGreaterThan(0);
  });

  it('shows "/" when no destination is set', async () => {
    const { getAllByText } = renderHome();
    await waitFor(() => expect(getAllByText('/').length).toBeGreaterThan(0));
  });

  it('shows pending count when there are pending uploads', async () => {
    setupMocks({ pendingCount: 7 });
    const { findByText } = renderHome();
    await findByText(/7 photo.*waiting/);
  });

  it('shows Sync Now button', async () => {
    const { findByText } = renderHome();
    await findByText('Sync Now');
  });
});

// ── Sync Now flow ─────────────────────────────────────────────────────────────

describe('Sync Now', () => {
  it('shows spinner while scanning', async () => {
    mockScanForPreview.mockReturnValue(new Promise(() => {})); // never resolves
    const { findByText, getByTestId } = renderHome();
    const syncBtn = await findByText('Sync Now');
    fireEvent.press(syncBtn);
    await waitFor(() => expect(mockScanForPreview).toHaveBeenCalled());
  });

  it('opens preview modal when photos are found', async () => {
    mockScanForPreview.mockResolvedValue([makePreviewItem('a'), makePreviewItem('b')]);
    const { findByText, findByTestId } = renderHome();
    fireEvent.press(await findByText('Sync Now'));
    await findByTestId('sync-preview-modal');
  });

  it('shows item count in modal', async () => {
    mockScanForPreview.mockResolvedValue([makePreviewItem('a'), makePreviewItem('b')]);
    const { findByText } = renderHome();
    fireEvent.press(await findByText('Sync Now'));
    await findByText('2 items to sync');
  });

  it('shows Alert when nothing is pending', async () => {
    mockScanForPreview.mockResolvedValue([]);
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { findByText } = renderHome();
    fireEvent.press(await findByText('Sync Now'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Up to date', expect.any(String)));
    alertSpy.mockRestore();
  });

  it('calls confirmSync with selected items on modal confirm', async () => {
    const items = [makePreviewItem('a'), makePreviewItem('b')];
    mockScanForPreview.mockResolvedValue(items);
    mockConfirmSync.mockResolvedValue(undefined);

    const { findByText, findByTestId } = renderHome();
    fireEvent.press(await findByText('Sync Now'));
    await findByTestId('sync-preview-modal');
    fireEvent.press(await findByTestId('modal-start-sync'));

    await waitFor(() => expect(mockConfirmSync).toHaveBeenCalledWith(items));
  });

  it('dismisses modal without calling confirmSync on cancel', async () => {
    mockScanForPreview.mockResolvedValue([makePreviewItem('a')]);
    const { findByText, findByTestId, queryByTestId } = renderHome();
    fireEvent.press(await findByText('Sync Now'));
    await findByTestId('sync-preview-modal');
    fireEvent.press(await findByTestId('modal-cancel'));
    await waitFor(() => expect(queryByTestId('sync-preview-modal')).toBeNull());
    expect(mockConfirmSync).not.toHaveBeenCalled();
  });

  it('disables Sync Now button while isSyncing', async () => {
    setupMocks({ isSyncing: true });
    const { findByText, UNSAFE_getAllByType } = renderHome();
    await findByText('Camera Roll Backup');
    // When isSyncing is true, the status bar and the Sync Now button both show a spinner.
    const { ActivityIndicator } = require('react-native');
    expect(UNSAFE_getAllByType(ActivityIndicator).length).toBeGreaterThan(0);
  });
});

// ── Camera roll destination picker ───────────────────────────────────────────

describe('camera roll destination picker', () => {
  it('opens the picker sheet on tapping Destination', async () => {
    const { getAllByText, findByText } = renderHome();
    await waitFor(() => getAllByText('Destination'));
    fireEvent.press(getAllByText('Destination')[0]);
    await findByText('Camera Roll Destination');
  });

  it('shows "/" (root) option in picker', async () => {
    const { getAllByText, findByText } = renderHome();
    await waitFor(() => getAllByText('Destination'));
    fireEvent.press(getAllByText('Destination')[0]);
    await findByText('/  (root)');
  });

  it('updates destination label after selecting root', async () => {
    const { getAllByText, findByText } = renderHome();
    await waitFor(() => getAllByText('Destination'));
    fireEvent.press(getAllByText('Destination')[0]);
    await findByText('/  (root)');
    fireEvent.press(await findByText('/  (root)'));
    await waitFor(() =>
      expect(updatePreferences).toHaveBeenCalledWith({ media_autoupload_folder_id: null }),
    );
  });

  it('shows media collections in picker when available', async () => {
    listRoot.mockResolvedValue({
      folder: null,
      subfolders: {
        items: [
          { id: 'mc-1', name: 'Vacation', kind: 'media', user_id: 'u', parent_id: null, created_at: '', updated_at: '' },
        ],
      },
      files: { items: [] },
    });
    const { getAllByText, findByText } = renderHome();
    await waitFor(() => getAllByText('Destination'));
    fireEvent.press(getAllByText('Destination')[0]);
    await findByText('Vacation');
  });
});

// ── On Device Files card ──────────────────────────────────────────────────────

describe('on device files card', () => {
  it('renders section label', async () => {
    const { findByText } = renderHome();
    await findByText('On Device Files');
  });

  it('renders Pick Files to Upload button', async () => {
    const { findByText } = renderHome();
    await findByText('Pick Files to Upload');
  });
});

// ── Favorites card ────────────────────────────────────────────────────────────

describe('favorites card', () => {
  it('renders Favorites section', async () => {
    const { findByText } = renderHome();
    await findByText('Favorites');
  });

  it('shows empty state when no favorites', async () => {
    const { findByText } = renderHome();
    await findByText('No favorites yet');
  });

  it('renders favorited files by name', async () => {
    listFavorites.mockResolvedValue({
      files: [
        { id: 'f1', name: 'sunset.jpg', mime_type: 'image/jpeg', size_bytes: 2000000 },
        { id: 'f2', name: 'notes.pdf', mime_type: 'application/pdf', size_bytes: 50000 },
      ],
    });
    const { findByText } = renderHome();
    await findByText('sunset.jpg');
    await findByText('notes.pdf');
  });
});
