import AsyncStorage from '@react-native-async-storage/async-storage';

// Persisted Google-backup preferences, shared between the backup modal's
// Settings tab and HomeScreen's background runner. Both default to ON, so a
// missing key is treated as enabled.

export const GBACKUP_BACKGROUND_KEY = 'apollo_gbackup_background';
export const GBACKUP_NOTIFY_KEY = 'apollo_gbackup_notify';

export interface BackupSettings {
  background: boolean; // run the backup off-modal, with progress in the card
  notify: boolean;     // post an OS notification when the backup completes
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { background: true, notify: true };

// A stored value is only "off" when explicitly set to 'false'.
function readFlag(value: string | null): boolean {
  return value !== 'false';
}

export async function loadBackupSettings(): Promise<BackupSettings> {
  try {
    const [bg, notify] = await Promise.all([
      AsyncStorage.getItem(GBACKUP_BACKGROUND_KEY),
      AsyncStorage.getItem(GBACKUP_NOTIFY_KEY),
    ]);
    return { background: readFlag(bg), notify: readFlag(notify) };
  } catch {
    return { ...DEFAULT_BACKUP_SETTINGS };
  }
}

export async function setBackupSetting(key: keyof BackupSettings, value: boolean): Promise<void> {
  const storageKey = key === 'background' ? GBACKUP_BACKGROUND_KEY : GBACKUP_NOTIFY_KEY;
  try {
    await AsyncStorage.setItem(storageKey, value ? 'true' : 'false');
  } catch {
    // best-effort persistence
  }
}
