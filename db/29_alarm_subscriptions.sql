-- Normalized alarm subscriptions: one row per (subscriber, alarm type, target).
-- Replaces the per-alarm email-array columns in alarm_settings for per-node and
-- per-drive granularity; alarm_settings remains in place but is no longer written
-- by the application.
--
-- Target scope is implied by alarm_type:
--   cpu_usage / cpu_temp / memory / network_traffic → node_id set (node-scoped)
--   drive_temp / drive_load                         → drive_id set (drive-scoped)
--   api_error_rate                                  → both NULL   (cluster-wide)
--
-- Threshold units: percent for cpu_usage/memory/drive_load/network_traffic/api_error_rate;
-- degrees Celsius for cpu_temp/drive_temp.

CREATE TABLE alarm_subscriptions (
    id            UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT             NOT NULL,
    alarm_type    TEXT             NOT NULL,
    node_id       UUID             REFERENCES nodes  (id) ON DELETE CASCADE,
    drive_id      UUID             REFERENCES drives (id) ON DELETE CASCADE,
    threshold     DOUBLE PRECISION NOT NULL,
    last_fired_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- One configuration per (subscriber, alarm type, target). A zero-UUID sentinel
-- stands in for NULL targets so cluster-wide rows (both NULL) and per-node /
-- per-drive rows all collapse to a single unique tuple.
CREATE UNIQUE INDEX alarm_sub_uniq ON alarm_subscriptions (
    email,
    alarm_type,
    COALESCE(node_id,  '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(drive_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE INDEX alarm_sub_email_idx ON alarm_subscriptions (email);
