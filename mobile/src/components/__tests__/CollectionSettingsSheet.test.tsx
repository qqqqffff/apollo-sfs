import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import CollectionSettingsSheet from '../CollectionSettingsSheet';
import type { ApiFolder } from '../../api/files';

jest.mock('../../api/recognition', () => ({
  getRecognitionStatus: jest.fn().mockResolvedValue({
    enabled: false,
    service_available: true,
    counts: { pending: 0, processing: 0, done: 0, failed: 0, skipped: 0 },
    groups: { face: 0, pet: 0, object: 0 },
    storage_bytes: 0,
  }),
  setRecognitionEnabled: jest.fn().mockResolvedValue({ enabled: true, files_enqueued: 3, freed_bytes: 0 }),
}));

import { setRecognitionEnabled } from '../../api/recognition';

const folder: ApiFolder = {
  id: 'coll-1',
  user_id: 'u1',
  parent_id: null,
  name: 'Family Photos',
  kind: 'media',
  ai_recognition_enabled: false,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

function renderSheet(overrides: Partial<React.ComponentProps<typeof CollectionSettingsSheet>> = {}) {
  return render(
    <CollectionSettingsSheet
      visible
      folder={folder}
      isPremium
      onClose={jest.fn()}
      onChanged={jest.fn()}
      {...overrides}
    />,
  );
}

describe('CollectionSettingsSheet', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows the collection name and AI recognition section', async () => {
    const { findByText } = renderSheet();
    expect(await findByText('Family Photos')).toBeTruthy();
    expect(await findByText('AI recognition')).toBeTruthy();
  });

  it('shows the premium hint for free users', async () => {
    const { findByText } = renderSheet({ isPremium: false });
    expect(await findByText(/premium feature/i)).toBeTruthy();
  });

  it('requires the disclaimer before enabling', async () => {
    const { getByRole, findByText } = renderSheet();
    fireEvent(getByRole('switch'), 'valueChange', true);

    // Disclaimer shown, no API call yet.
    expect(await findByText(/count toward your storage quota/i)).toBeTruthy();
    expect(setRecognitionEnabled).not.toHaveBeenCalled();

    fireEvent.press(await findByText('Enable'));
    await waitFor(() => expect(setRecognitionEnabled).toHaveBeenCalledWith('coll-1', true, false));
  });

  it('disable flow passes the purge option through', async () => {
    const { getByRole, findByText } = renderSheet({
      folder: { ...folder, ai_recognition_enabled: true },
    });
    fireEvent(getByRole('switch'), 'valueChange', false);

    expect(await findByText(/stop indexing this collection/i)).toBeTruthy();
    fireEvent.press(await findByText(/also delete groups and stored thumbnails/i));
    fireEvent.press(await findByText('Disable & delete'));
    await waitFor(() => expect(setRecognitionEnabled).toHaveBeenCalledWith('coll-1', false, true));
  });
});
