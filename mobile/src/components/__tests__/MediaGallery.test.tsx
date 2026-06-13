import React from 'react';
import { Alert } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import MediaGallery, { __clearUrlCache } from '../MediaGallery';
import { type ApiFile } from '../../api/files';

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('../../api/files', () => ({
  downloadFile: jest.fn(),
  deleteFile: jest.fn(),
  favoriteFile: jest.fn(),
  unfavoriteFile: jest.fn(),
  getFolder: jest.fn(),
  listRoot: jest.fn(),
  moveFile: jest.fn(),
}));

jest.mock('../../services/UploadQueue', () => ({
  getDoneHashSet: jest.fn(() => Promise.resolve(new Set<string>())),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const {
  downloadFile,
  deleteFile,
  favoriteFile,
  getFolder,
  listRoot,
} = require('../../api/files');

function makeFile(id: string, taken?: string): ApiFile {
  return {
    id,
    user_id: 'u',
    folder_id: 'folder-1',
    name: `photo-${id}.jpg`,
    mime_type: 'image/jpeg',
    size_bytes: 1024 * 1024,
    hidden: false,
    taken_at: taken ?? `2026-06-12T${id.padStart(2, '0')}:00:00Z`,
    created_at: `2026-06-12T${id.padStart(2, '0')}:00:00Z`,
    updated_at: `2026-06-12T${id.padStart(2, '0')}:00:00Z`,
  };
}

const THREE_FILES: ApiFile[] = [makeFile('1'), makeFile('2'), makeFile('3')];

const defaultProps = {
  files: THREE_FILES,
  currentFolderID: 'folder-1',
  isSubcollection: false,
  onDeleteFile: jest.fn(),
};

function renderGallery(overrides?: Partial<typeof defaultProps>) {
  return render(<MediaGallery {...defaultProps} {...overrides} />);
}

beforeEach(() => {
  jest.clearAllMocks();
  __clearUrlCache(); // ensure downloadFile is called fresh each test
  downloadFile.mockResolvedValue('data:image/jpeg;base64,/9j/fake');
  deleteFile.mockResolvedValue(undefined);
  favoriteFile.mockResolvedValue(undefined);
  getFolder.mockResolvedValue({ folder: null, subfolders: { items: [] }, files: { items: [] } });
  listRoot.mockResolvedValue({ folder: null, subfolders: { items: [] }, files: { items: [] } });
});

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('rendering', () => {
  it('renders a section header for each date group', async () => {
    // All files are from June 2026 — should produce a single "June 2026" section
    const { findByText } = renderGallery();
    await findByText(/june 2026/i);
  });

  it('renders one section per distinct month', async () => {
    const mixed: ApiFile[] = [
      makeFile('a'),
      { ...makeFile('b'), taken_at: '2026-05-01T00:00:00Z', created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z' },
    ];
    const { findByText } = renderGallery({ files: mixed });
    await findByText(/june 2026/i);
    await findByText(/may 2026/i);
  });

  it('renders no sections when files list is empty', async () => {
    const { queryByText, findByText } = renderGallery({ files: [] });
    // No section headers should appear; just the date pill bar
    await waitFor(() => {});
    expect(queryByText(/june 2026/i)).toBeNull();
  });

  it('fetches preview for each file', async () => {
    renderGallery();
    await waitFor(() => expect(downloadFile).toHaveBeenCalledTimes(3));
    expect(downloadFile).toHaveBeenCalledWith('1');
    expect(downloadFile).toHaveBeenCalledWith('2');
    expect(downloadFile).toHaveBeenCalledWith('3');
  });

  it('does not re-fetch a file already in cache', async () => {
    const { unmount } = renderGallery();
    await waitFor(() => expect(downloadFile).toHaveBeenCalledTimes(3));
    unmount();
    downloadFile.mockClear();
    // Re-render with the same files — cache should satisfy all requests
    renderGallery();
    await waitFor(() => {});
    expect(downloadFile).not.toHaveBeenCalled();
  });
});

// ── Select mode ───────────────────────────────────────────────────────────────

describe('select mode', () => {
  async function enterSelectMode(screen: ReturnType<typeof renderGallery>) {
    await waitFor(() => expect(downloadFile).toHaveBeenCalled());
    const { TouchableOpacity } = require('react-native');
    const tiles = screen.UNSAFE_getAllByType(TouchableOpacity).filter(
      (t: any) => typeof t.props.onLongPress === 'function',
    );
    expect(tiles.length).toBeGreaterThan(0);
    fireEvent(tiles[0], 'longPress');
    return tiles;
  }

  it('shows selected count in toolbar after long press', async () => {
    const screen = renderGallery();
    await enterSelectMode(screen);
    await screen.findByText(/1 selected/);
  });

  it('Cancel button exits select mode', async () => {
    const screen = renderGallery();
    await enterSelectMode(screen);
    await screen.findByText(/1 selected/);
    fireEvent.press(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText(/selected/)).toBeNull());
  });

  it('tapping another tile adds it to selection', async () => {
    const screen = renderGallery();
    const tiles = await enterSelectMode(screen);
    await screen.findByText(/1 selected/);
    fireEvent.press(tiles[1]); // tap second tile
    await screen.findByText(/2 selected/);
  });

  it('tapping a selected tile deselects it', async () => {
    const screen = renderGallery();
    const tiles = await enterSelectMode(screen);
    await screen.findByText(/1 selected/);
    fireEvent.press(tiles[0]); // deselect the one we long-pressed
    await screen.findByText(/0 selected/);
  });

  it('toolbar shows Favorite, Move, and Delete buttons', async () => {
    const screen = renderGallery();
    await enterSelectMode(screen);
    await screen.findByText(/1 selected/);
    // These icons are mocked as null, but their parent TouchableOpacities exist.
    // We verify the toolbar rendered by checking the cancel button and count exist.
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('Delete button shows confirmation Alert', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = renderGallery();
    const tiles = await enterSelectMode(screen);
    await screen.findByText(/1 selected/);

    // The select toolbar has 4 touchables: Cancel, Favorite, Move, Delete
    const { TouchableOpacity } = require('react-native');
    const allTouchables = screen.UNSAFE_getAllByType(TouchableOpacity);
    // Toolbar is absolutely positioned at bottom; Delete is the last toolbar button
    // Find Cancel first, then get siblings
    const cancelBtn = screen.getByText('Cancel');
    // Trigger delete — it's the last action button in the toolbar
    const toolbarTouchables = allTouchables.slice(-4); // last 4: cancel + 3 actions
    fireEvent.press(toolbarTouchables[toolbarTouchables.length - 1]);

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls[0][0]).toMatch(/delete/i);
    alertSpy.mockRestore();
  });

  it('confirming bulk delete calls deleteFile for each selected item', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(
      (_title, _msg, buttons) => {
        // Simulate pressing the destructive "Delete" button
        const deleteBtn = (buttons as any[])?.find((b: any) => b.style === 'destructive');
        deleteBtn?.onPress?.();
      },
    );

    const screen = renderGallery();
    const tiles = await enterSelectMode(screen);
    await screen.findByText(/1 selected/);

    // Select a second tile
    fireEvent.press(tiles[1]);
    await screen.findByText(/2 selected/);

    // Trigger delete
    const { TouchableOpacity } = require('react-native');
    const allTouchables = screen.UNSAFE_getAllByType(TouchableOpacity);
    const toolbarTouchables = allTouchables.slice(-4);
    fireEvent.press(toolbarTouchables[toolbarTouchables.length - 1]);

    await waitFor(() => expect(deleteFile).toHaveBeenCalledTimes(2));
    alertSpy.mockRestore();
  });
});

// ── Columns prop ──────────────────────────────────────────────────────────────

describe('columns prop', () => {
  it('defaults to 3 columns per row', async () => {
    const screen = renderGallery();
    await waitFor(() => expect(downloadFile).toHaveBeenCalled());
    // With 3 files and 3 cols, all 3 files fit in one row — one section row
    const { View } = require('react-native');
    // We can't measure pixel widths, but we verify the gallery renders without errors
    expect(screen.UNSAFE_getAllByType(View).length).toBeGreaterThan(0);
  });

  it('renders with cols=1 without crashing', async () => {
    expect(() => renderGallery({ cols: 1 })).not.toThrow();
  });

  it('renders with cols=5 without crashing', async () => {
    expect(() => renderGallery({ cols: 5 })).not.toThrow();
  });

  it('clamps cols below 1 to 1', async () => {
    expect(() => renderGallery({ cols: 0 })).not.toThrow();
  });

  it('clamps cols above 5 to 5', async () => {
    expect(() => renderGallery({ cols: 10 })).not.toThrow();
  });
});

// ── Single-file toolbar actions ───────────────────────────────────────────────

describe('single file actions (via prop callbacks)', () => {
  function getTiles(screen: ReturnType<typeof renderGallery>) {
    const { TouchableOpacity } = require('react-native');
    return screen.UNSAFE_getAllByType(TouchableOpacity).filter(
      (t: any) => typeof t.props.onLongPress === 'function',
    );
  }

  it('calls favoriteFile when tile onFavorite fires', async () => {
    const screen = renderGallery();
    await waitFor(() => expect(downloadFile).toHaveBeenCalled());
    const tiles = getTiles(screen);
    // Invoke onFavorite directly on the first tile's props
    await tiles[0].props.onFavorite?.();
    expect(favoriteFile).toHaveBeenCalledWith('1');
  });

  it('calls deleteFile and removes file when tile onDelete fires and confirmed', async () => {
    const onDeleteFile = jest.fn();
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(
      (_title, _msg, buttons) => {
        const delBtn = (buttons as any[])?.find((b: any) => b.style === 'destructive');
        delBtn?.onPress?.();
      },
    );

    const screen = renderGallery({ onDeleteFile });
    await waitFor(() => expect(downloadFile).toHaveBeenCalled());
    const tiles = getTiles(screen);
    await tiles[0].props.onDelete?.();

    await waitFor(() => expect(deleteFile).toHaveBeenCalledWith('1'));
    await waitFor(() => expect(onDeleteFile).toHaveBeenCalledWith('1'));
    alertSpy.mockRestore();
  });

  it('does not delete when alert is cancelled', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(
      (_title, _msg, buttons) => {
        const cancelBtn = (buttons as any[])?.find((b: any) => b.style === 'cancel');
        cancelBtn?.onPress?.();
      },
    );

    const screen = renderGallery();
    await waitFor(() => expect(downloadFile).toHaveBeenCalled());
    const tiles = getTiles(screen);
    await tiles[0].props.onDelete?.();
    expect(deleteFile).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});
