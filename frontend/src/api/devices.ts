import { get } from './client'
import type { Device } from '../types/api'

// listDevices returns the current user's registered mobile devices, used to
// resolve a file's device_id to a human-readable name in "uploaded from" info.
export function listDevices(): Promise<{ items: Device[] }> {
  return get<{ items: Device[] }>('/devices')
}
