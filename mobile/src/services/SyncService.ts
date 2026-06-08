import { Platform } from 'react-native';
import { CameraRoll } from '@react-native-camera-roll/camera-roll';
import { check, request, PERMISSIONS, RESULTS } from 'react-native-permissions';
import NetInfo from '@react-native-community/netinfo';
import RNBlobUtil from 'react-native-blob-util';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { checkHash, deltaSync } from '../api/sync';
import { uploadFile } from '../api/files';
import {
  countByStatus,
  enqueue,
  getPendingItems,
  incrementRetry,
  isAlreadyDone,
  setStatus,
} from './UploadQueue';

const CURSOR_KEY = 'apollo_sync_cursor';
const DEVICE_ID_KEY = 'apollo_device_id';
const WIFI_ONLY_KEY = 'apollo_wifi_only';

interface SyncServiceOptions {
  onPendingCountChange?: (count: number) => void;
}

export class SyncService {
  private opts: SyncServiceOptions;

  constructor(opts: SyncServiceOptions = {}) {
    this.opts = opts;
  }

  async run(): Promise<void> {
    if (!(await this.networkOk())) return;
    await this.scanCameraRoll();
    await this.processQueue();
    await this.notifyPendingCount();
  }

  private async networkOk(): Promise<boolean> {
    const wifiOnly = (await AsyncStorage.getItem(WIFI_ONLY_KEY)) === 'true';
    if (!wifiOnly) return true;
    const state = await NetInfo.fetch();
    return state.type === 'wifi';
  }

  private async requestPhotoPermission(): Promise<boolean> {
    const permission =
      Platform.OS === 'ios'
        ? PERMISSIONS.IOS.PHOTO_LIBRARY
        : PERMISSIONS.ANDROID.READ_MEDIA_IMAGES;

    const current = await check(permission);
    if (current === RESULTS.GRANTED || current === RESULTS.LIMITED) return true;

    const result = await request(permission);
    return result === RESULTS.GRANTED || result === RESULTS.LIMITED;
  }

  private async hashAsset(uri: string): Promise<string | null> {
    try {
      let filePath = uri;
      let tempPath: string | null = null;

      if (Platform.OS === 'ios' && uri.startsWith('ph://')) {
        // Materialize ph:// URI to a temporary file so we can hash it
        const result = await RNBlobUtil.config({ fileCache: true }).fetch('GET', uri);
        tempPath = result.path();
        filePath = tempPath;
      }

      const hash = await RNBlobUtil.fs.hash(filePath, 'sha256');

      if (tempPath) {
        await RNBlobUtil.fs.unlink(tempPath).catch(() => {});
      }

      return hash;
    } catch {
      return null;
    }
  }

  private async scanCameraRoll(): Promise<void> {
    const granted = await this.requestPhotoPermission();
    if (!granted) return;

    const cursor = (await AsyncStorage.getItem(CURSOR_KEY)) ?? '1970-01-01T00:00:00Z';
    const fromTime = new Date(cursor).getTime();

    let hasNextPage = true;
    let endCursor: string | undefined;

    while (hasNextPage) {
      const page = await CameraRoll.getPhotos({
        first: 50,
        after: endCursor,
        assetType: 'All',
        fromTime,
        include: ['filename', 'fileSize'],
      });

      for (const edge of page.edges) {
        const node = edge.node;
        const assetId = node.image.uri;
        const localUri = node.image.uri;
        const filename = node.image.filename ?? `asset_${Date.now()}`;
        const mimeType = node.type === 'video' ? 'video/mp4' : 'image/jpeg';
        const sizeBytes = node.image.fileSize ?? null;

        if (await isAlreadyDone(assetId)) continue;

        const sha256Hash = await this.hashAsset(localUri);

        if (sha256Hash) {
          try {
            const { exists } = await checkHash(sha256Hash);
            if (exists) {
              await enqueue({
                local_asset_id: assetId,
                local_uri: localUri,
                filename,
                sha256_hash: sha256Hash,
                size_bytes: sizeBytes,
                mime_type: mimeType,
              });
              await setStatus(assetId, 'done');
              continue;
            }
          } catch {
            // dedup check failed — proceed to upload
          }
        }

        await enqueue({
          local_asset_id: assetId,
          local_uri: localUri,
          filename,
          sha256_hash: sha256Hash,
          size_bytes: sizeBytes,
          mime_type: mimeType,
        });
      }

      hasNextPage = page.page_info.has_next_page;
      endCursor = page.page_info.end_cursor;
    }
  }

  private async processQueue(): Promise<void> {
    const items = await getPendingItems(10);

    for (const item of items) {
      if (!(await this.networkOk())) break;

      try {
        await setStatus(item.local_asset_id, 'uploading');

        await uploadFile(
          item.local_uri,
          item.filename,
          item.mime_type ?? 'application/octet-stream',
        );

        await setStatus(item.local_asset_id, 'done');

        const deviceID = await AsyncStorage.getItem(DEVICE_ID_KEY);
        const delta = await deltaSync(new Date().toISOString(), deviceID ?? undefined);
        await AsyncStorage.setItem(CURSOR_KEY, delta.server_time);
      } catch {
        if (item.retry_count >= 4) {
          await setStatus(item.local_asset_id, 'failed');
        } else {
          await incrementRetry(item.local_asset_id);
        }
      }
    }
  }

  private async notifyPendingCount(): Promise<void> {
    if (!this.opts.onPendingCountChange) return;
    const count = await countByStatus('pending');
    this.opts.onPendingCountChange(count);
  }
}
