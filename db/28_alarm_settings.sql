-- Alarm settings: single-row cluster-wide configuration (id=1, enforced by PK + CHECK).
-- Each alarm type has its own subscriber email list; the alarm fires whenever the
-- list is non-empty. last_fired_at tracks the most recent trigger per alarm type
-- to prevent repeat notifications within a cooldown window.
-- For per-node and per-drive alarm subscriptions see alarm_subscriptions.

CREATE TABLE alarm_settings (
    id                              INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    cpu_usage_emails                TEXT[]      NOT NULL DEFAULT '{}',
    cpu_usage_last_fired_at         TIMESTAMPTZ,
    cpu_temp_emails                 TEXT[]      NOT NULL DEFAULT '{}',
    cpu_temp_last_fired_at          TIMESTAMPTZ,
    drive_temp_emails               TEXT[]      NOT NULL DEFAULT '{}',
    drive_temp_last_fired_at        TIMESTAMPTZ,
    drive_load_emails               TEXT[]      NOT NULL DEFAULT '{}',
    drive_load_last_fired_at        TIMESTAMPTZ,
    network_traffic_emails          TEXT[]      NOT NULL DEFAULT '{}',
    network_traffic_last_fired_at   TIMESTAMPTZ,
    api_error_rate_emails           TEXT[]      NOT NULL DEFAULT '{}',
    api_error_rate_last_fired_at    TIMESTAMPTZ,
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO alarm_settings DEFAULT VALUES
ON CONFLICT (id) DO NOTHING;
