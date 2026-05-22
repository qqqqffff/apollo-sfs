import * as MediaLibrary from 'expo-media-library';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import * as Network from 'expo-network';
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
const CHUNK_THRESHOLD = 50 * 1024 * 1024; // 50 MB

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
    const state = await Network.getNetworkStateAsync();
    return state.type === Network.NetworkStateType.WIFI;
  }

  private async scanCameraRoll(): Promise<void> {
    const { status } = await MediaLibrary.requestPermissionsAsync();
    if (status !== 'granted') return;

    const cursor = (await AsyncStorage.getItem(CURSOR_KEY)) ?? '1970-01-01T00:00:00Z';
    const after = new Date(cursor).getTime();

    let hasNext = true;
    let endCursor: string | undefined;

    while (hasNext) {
      const page = await MediaLibrary.getAssetsAsync({
        first: 50,
        after: endCursor,
        createdAfter: after,
        mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        sortBy: MediaLibrary.SortBy.creationTime,
      });

      for (const asset of page.assets) {
        if (await isAlreadyDone(asset.id)) continue;

        const assetInfo = await MediaLibrary.getAssetInfoAsync(asset);
        const localUri = assetInfo.localUri ?? asset.uri;
        const filename = asset.filename;
        const mimeType = asset.mediaType === 'photo' ? 'image/jpeg' : 'video/mp4';

        let sha256Hash: string | null = null;
        try {
          const fileInfo = await FileSystem.getInfoAsync(localUri);
          if (fileInfo.exists) {
            const digest = await Crypto.digestStringAsync(
              Crypto.CryptoDigestAlgorithm.SHA256,
              await FileSystem.readAsStringAsync(localUri, {
                encoding: FileSystem.EncodingType.Base64,
              }),
            );
            sha256Hash = digest;
          }
        } catch {
          // hash unavailable — skip dedup, still enqueue
        }

        if (sha256Hash) {
          try {
            const { exists } = await checkHash(sha256Hash);
            if (exists) {
              await enqueue({
                local_asset_id: asset.id,
                local_uri: localUri,
                filename,
                sha256_hash: sha256Hash,
                size_bytes: asset.fileSize ?? null,
                mime_type: mimeType,
              });
              await setStatus(asset.id, 'done');
              continue;
            }
          } catch {
            // dedup check failed — continue with upload
          }
        }

        await enqueue({
          local_asset_id: asset.id,
          local_uri: localUri,
          filename,
          sha256_hash: sha256Hash,
          size_bytes: asset.fileSize ?? null,
          mime_type: mimeType,
        });
      }

      hasNext = page.hasNextPage;
      endCursor = page.endCursor;
    }
  }

  private async processQueue(): Promise<void> {
    const items = await getPendingItems(10);

    for (const item of items) {
      if (!(await this.networkOk())) break;

      try {
        await setStatus(item.local_asset_id, 'uploading');

        const fileInfo = await FileSystem.getInfoAsync(item.local_uri);
        if (!fileInfo.exists) {
          await setStatus(item.local_asset_id, 'failed');
          continue;
        }

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
