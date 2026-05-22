import BackgroundFetch from 'react-native-background-fetch';
import { SyncService } from '../services/SyncService';

export const headlessTask = async (event: { taskId: string; timeout: boolean }) => {
  if (event.timeout) {
    BackgroundFetch.finish(event.taskId);
    return;
  }
  try {
    const svc = new SyncService();
    await svc.run();
  } finally {
    BackgroundFetch.finish(event.taskId);
  }
};

export async function registerBackgroundSync(): Promise<void> {
  await BackgroundFetch.configure(
    {
      minimumFetchInterval: 15, // minutes; iOS enforces its own minimum
      stopOnTerminate: false,
      startOnBoot: true,
      enableHeadless: true,
      requiredNetworkType: BackgroundFetch.NETWORK_TYPE_ANY,
    },
    async (taskId) => {
      try {
        const svc = new SyncService();
        await svc.run();
      } finally {
        BackgroundFetch.finish(taskId);
      }
    },
    (taskId) => {
      // Timeout handler
      BackgroundFetch.finish(taskId);
    },
  );
}
