-- Alarm settings: single-row table (id=1) storing per-alarm toggle flags and
-- the list of email addresses that should receive alarm notifications.

CREATE TABLE IF NOT EXISTS alarm_settings (
    id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    notify_emails           TEXT[]      NOT NULL DEFAULT '{}',
    cpu_usage_enabled       BOOLEAN     NOT NULL DEFAULT false,
    cpu_temp_enabled        BOOLEAN     NOT NULL DEFAULT false,
    drive_temp_enabled      BOOLEAN     NOT NULL DEFAULT false,
    drive_load_enabled      BOOLEAN     NOT NULL DEFAULT false,
    network_traffic_enabled BOOLEAN     NOT NULL DEFAULT false,
    api_error_rate_enabled  BOOLEAN     NOT NULL DEFAULT false,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO alarm_settings DEFAULT VALUES
ON CONFLICT (id) DO NOTHING;
