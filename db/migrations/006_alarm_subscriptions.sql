-- Alarm settings v2: replace global notify_emails + boolean flags with
-- per-alarm subscriber arrays and last-fired timestamps.
-- The alarm is active for a given alarm type whenever its email list is non-empty.

ALTER TABLE alarm_settings
  DROP COLUMN IF EXISTS notify_emails,
  DROP COLUMN IF EXISTS cpu_usage_enabled,
  DROP COLUMN IF EXISTS cpu_temp_enabled,
  DROP COLUMN IF EXISTS drive_temp_enabled,
  DROP COLUMN IF EXISTS drive_load_enabled,
  DROP COLUMN IF EXISTS network_traffic_enabled,
  DROP COLUMN IF EXISTS api_error_rate_enabled,
  ADD COLUMN IF NOT EXISTS cpu_usage_emails           TEXT[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cpu_usage_last_fired_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cpu_temp_emails            TEXT[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cpu_temp_last_fired_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS drive_temp_emails          TEXT[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS drive_temp_last_fired_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS drive_load_emails          TEXT[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS drive_load_last_fired_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS network_traffic_emails     TEXT[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS network_traffic_last_fired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS api_error_rate_emails      TEXT[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS api_error_rate_last_fired_at  TIMESTAMPTZ;
