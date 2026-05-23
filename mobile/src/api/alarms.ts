import api from './client';

export interface AlarmSettings {
  cpu_usage_emails: string[];
  cpu_usage_last_fired_at: string | null;
  cpu_temp_emails: string[];
  cpu_temp_last_fired_at: string | null;
  drive_temp_emails: string[];
  drive_temp_last_fired_at: string | null;
  drive_load_emails: string[];
  drive_load_last_fired_at: string | null;
  network_traffic_emails: string[];
  network_traffic_last_fired_at: string | null;
  api_error_rate_emails: string[];
  api_error_rate_last_fired_at: string | null;
  updated_at: string;
}

export interface AlarmType {
  key: string;
  emailField: keyof AlarmSettings;
  label: string;
  description: string;
}

export const ALARM_TYPES: AlarmType[] = [
  { key: 'cpu_usage', emailField: 'cpu_usage_emails', label: 'CPU Usage', description: '≥ 90% avg over 30 min' },
  { key: 'cpu_temp', emailField: 'cpu_temp_emails', label: 'CPU Temperature', description: '≥ 75°C avg over 30 min' },
  { key: 'drive_temp', emailField: 'drive_temp_emails', label: 'Drive Temperature', description: '≥ 50°C avg over 30 min' },
  { key: 'drive_load', emailField: 'drive_load_emails', label: 'Drive Load', description: '≥ 90% allocated quota capacity' },
  { key: 'network_traffic', emailField: 'network_traffic_emails', label: 'Network Traffic', description: '≥ 90% of link capacity over 30 min' },
  { key: 'api_error_rate', emailField: 'api_error_rate_emails', label: 'API Error Rate', description: '≥ 5% of requests returning 500+ errors' },
];

export async function getAlarmSettings(): Promise<AlarmSettings> {
  const res = await api.get<AlarmSettings>('/api/v1/admin/system/alarm/settings');
  return res.data;
}

export async function toggleAlarmSubscription(
  alarmType: string,
  subscribed: boolean,
): Promise<AlarmSettings> {
  const res = await api.post<AlarmSettings>('/api/v1/admin/system/alarm/subscribe', {
    alarm_type: alarmType,
    subscribed,
  });
  return res.data;
}
