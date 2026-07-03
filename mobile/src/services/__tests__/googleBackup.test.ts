jest.mock('../../api/sync', () => ({ checkHash: jest.fn() }));
jest.mock('../../api/files', () => ({ uploadFile: jest.fn() }));

import {
  googlePreviewSource,
  uploadGoogleEntries,
  type BackupEntry,
  type GoogleBackupItem,
} from '../GoogleBackupService';
import { loadBackupSettings, setBackupSetting } from '../backupSettings';
import { checkHash } from '../../api/sync';
import { uploadFile } from '../../api/files';

const mockCheckHash = checkHash as jest.Mock;
const mockUploadFile = uploadFile as jest.Mock;

const baseItem: GoogleBackupItem = {
  id: 'f1',
  name: 'a.jpg',
  mimeType: 'image/jpeg',
  size: 100,
  modifiedTime: '',
  source: 'drive',
  isGoogleDoc: false,
  baseUrl: null,
  thumbnailLink: null,
};

describe('googlePreviewSource', () => {
  it('returns null for non-image items', () => {
    expect(googlePreviewSource({ ...baseItem, mimeType: 'video/mp4' }, 'tok')).toBeNull();
    expect(googlePreviewSource({ ...baseItem, mimeType: 'application/pdf' }, 'tok')).toBeNull();
  });

  it('builds an authenticated Drive image URL', () => {
    const s = googlePreviewSource(baseItem, 'tok');
    expect(s?.uri).toContain('/files/f1?alt=media');
    expect(s?.headers.Authorization).toBe('Bearer tok');
  });

  it('builds a sized, authenticated Photos URL', () => {
    const s = googlePreviewSource(
      { ...baseItem, source: 'photos', baseUrl: 'https://photos/p1' },
      'tok',
    );
    expect(s?.uri).toBe('https://photos/p1=w1024-h1024');
    expect(s?.headers.Authorization).toBe('Bearer tok');
  });

  it('returns null for a Photos item with no baseUrl', () => {
    expect(googlePreviewSource({ ...baseItem, source: 'photos', baseUrl: null }, 'tok')).toBeNull();
  });
});

describe('uploadGoogleEntries dedup', () => {
  const entry = (id: string): BackupEntry => ({
    googleItem: { ...baseItem, id, name: id, source: 'drive' },
    name: `${id}.jpg`,
    type: 'image/jpeg',
    destFolderId: null,
  });

  beforeEach(() => {
    mockCheckHash.mockReset();
    mockUploadFile.mockReset().mockResolvedValue({});
  });

  it('skips duplicates and uploads new files, reporting per-item status', async () => {
    mockCheckHash
      .mockResolvedValueOnce({ exists: true })   // first already in SFS
      .mockResolvedValueOnce({ exists: false }); // second is new

    const statuses: string[] = [];
    const res = await uploadGoogleEntries(
      [entry('a'), entry('b')],
      'tok',
      (_done, _total, finished) => { if (finished) statuses.push(finished.status); },
    );

    expect(res).toEqual({ uploaded: 1, duplicates: 1, errors: 0 });
    expect(mockUploadFile).toHaveBeenCalledTimes(1); // duplicate was not uploaded
    expect(statuses).toEqual(['duplicate', 'done']);
  });

  it('tags Google Drive uploads with the google_drive source', async () => {
    mockCheckHash.mockResolvedValue({ exists: false });
    await uploadGoogleEntries([entry('a')], 'tok');
    // source is the 7th argument of uploadFile
    expect(mockUploadFile.mock.calls[0][6]).toBe('google_drive');
  });
});

describe('backupSettings', () => {
  it('defaults both flags to enabled when nothing is stored', async () => {
    expect(await loadBackupSettings()).toEqual({ background: true, notify: true });
  });

  it('persists and reloads a disabled flag', async () => {
    await setBackupSetting('background', false);
    expect((await loadBackupSettings()).background).toBe(false);

    await setBackupSetting('background', true);
    expect((await loadBackupSettings()).background).toBe(true);

    await setBackupSetting('notify', false);
    expect((await loadBackupSettings()).notify).toBe(false);
  });
});
