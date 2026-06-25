import notifee, { AndroidImportance, AuthorizationStatus } from '@notifee/react-native';

// Local OS notifications. Used today only to announce that a Google backup has
// finished. The backup loop runs while the app is in the foreground, so the
// iOS foregroundPresentationOptions below make the banner appear even when the
// app is open. If the app is fully backgrounded mid-upload JS is suspended, so
// the notification posts once the app returns to the foreground.

const BACKUP_CHANNEL_ID = 'google-backup';

let permissionAsked = false;

// Asks the OS for notification permission. Safe to call repeatedly — the system
// only prompts once. Returns true when notifications are authorized (or
// provisionally authorized on iOS).
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const settings = await notifee.requestPermission();
    permissionAsked = true;
    return (
      settings.authorizationStatus === AuthorizationStatus.AUTHORIZED ||
      settings.authorizationStatus === AuthorizationStatus.PROVISIONAL
    );
  } catch {
    return false;
  }
}

// Posts a "backup complete" notification. uploaded = newly stored, duplicates =
// already present (skipped), errors = failed. Best-effort: any failure
// (permission denied, simulator without notification support) is swallowed.
export async function notifyBackupComplete(uploaded: number, duplicates: number, errors: number): Promise<void> {
  try {
    if (!permissionAsked) {
      const granted = await requestNotificationPermission();
      if (!granted) return;
    }

    const channelId = await notifee.createChannel({
      id: BACKUP_CHANNEL_ID,
      name: 'Google Backup',
      importance: AndroidImportance.DEFAULT,
    });

    const title = errors === 0 ? 'Google backup complete' : 'Google backup finished with errors';
    const body = [
      `${uploaded} backed up`,
      duplicates > 0 ? `${duplicates} duplicate${duplicates !== 1 ? 's' : ''} skipped` : null,
      errors > 0 ? `${errors} failed` : null,
    ].filter(Boolean).join(' · ');

    await notifee.displayNotification({
      title,
      body,
      android: { channelId, pressAction: { id: 'default' } },
      ios: { foregroundPresentationOptions: { banner: true, sound: true, list: true } },
    });
  } catch {
    // notifications are best-effort
  }
}
