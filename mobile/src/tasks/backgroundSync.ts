import BackgroundFetch from 'react-native-background-fetch';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SyncService } from '../services/SyncService';
import { getMe } from '../api/auth';

export const NIGHTSYNC_KEY = 'apollo_nightsync_enabled';
export const NIGHTSYNC_HOUR_KEY = 'apollo_nightsync_hour';
export const NIGHTSYNC_DEFAULT_HOUR = 4;
const NIGHTSYNC_LAST_KEY = 'apollo_nightsync_last_run';

async function quotaOk(): Promise<boolean> {
  try {
    const profile = await getMe();
    if (!profile.storage_quota_bytes) return true;
    return (profile.storage_used_bytes / profile.storage_quota_bytes) * 100 < 75;
  } catch {
    return true;
  }
}

async function shouldRunNightSync(): Promise<boolean> {
  const enabled = (await AsyncStorage.getItem(NIGHTSYNC_KEY)) === 'true';
  if (!enabled) return false;

  const storedHour = await AsyncStorage.getItem(NIGHTSYNC_HOUR_KEY);
  const targetHour = storedHour !== null ? parseInt(storedHour, 10) : NIGHTSYNC_DEFAULT_HOUR;
  const currentHour = new Date().getHours();

  // Allow a 2-hour window around the target
  const inWindow = currentHour >= targetHour && currentHour < targetHour + 2;
  if (!inWindow) return false;

  // Only run once per calendar day
  const today = new Date().toDateString();
  const lastRun = await AsyncStorage.getItem(NIGHTSYNC_LAST_KEY);
  if (lastRun === today) return false;

  return await quotaOk();
}

export const headlessTask = async (event: { taskId: string; timeout: boolean }) => {
  if (event.timeout) {
    BackgroundFetch.finish(event.taskId);
    return;
  }
  try {
    if (await shouldRunNightSync()) {
      await AsyncStorage.setItem(NIGHTSYNC_LAST_KEY, new Date().toDateString());
      const svc = new SyncService();
      await svc.run();
    } else {
      // Regular background fetch — always run
      const svc = new SyncService();
      await svc.run();
    }
  } finally {
    BackgroundFetch.finish(event.taskId);
  }
};

export async function registerBackgroundSync(): Promise<void> {
  try {
    await BackgroundFetch.configure(
      {
        minimumFetchInterval: 15,
        stopOnTerminate: false,
        startOnBoot: true,
        enableHeadless: true,
        requiredNetworkType: BackgroundFetch.NETWORK_TYPE_ANY,
      },
      async (taskId) => {
        try {
          if (await shouldRunNightSync()) {
            await AsyncStorage.setItem(NIGHTSYNC_LAST_KEY, new Date().toDateString());
          }
          const svc = new SyncService();
          await svc.run();
        } finally {
          BackgroundFetch.finish(taskId);
        }
      },
      (taskId) => {
        BackgroundFetch.finish(taskId);
      },
    );
  } catch {
    // Background fetch unavailable in simulator or when App Group is not configured
  }
}
