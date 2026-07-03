-- Alarm subscriptions: replace the single-row, cluster-global alarm_settings
-- model (one subscriber-email array per alarm type) with a normalized table so
-- alarms can be configured per node / per drive, each with its own threshold and
-- its own subscriber. The legacy alarm_settings table is left in place but is no
-- longer read or written by the application.
--
-- Target scope is implied by alarm_type and enforced in the API handler:
--   cpu_usage / cpu_temp / memory / network_traffic  -> node_id   set (node-scoped)
--   drive_temp / drive_load                          -> drive_id  set (drive-scoped)
--   api_error_rate                                   -> both NULL     (cluster-wide)
-- threshold units: cpu_usage/memory/drive_load/network_traffic/api_error_rate in
-- percent, cpu_temp/drive_temp in degrees Celsius.

CREATE TABLE IF NOT EXISTS alarm_subscriptions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT             NOT NULL,
    alarm_type    TEXT             NOT NULL,
    node_id       UUID REFERENCES nodes  (id) ON DELETE CASCADE,
    drive_id      UUID REFERENCES drives (id) ON DELETE CASCADE,
    threshold     DOUBLE PRECISION NOT NULL,
    last_fired_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ      NOT NULL DEFAULT now()
);

-- One configuration per (subscriber, alarm type, target). A zero-UUID sentinel
-- stands in for NULL targets so cluster-wide rows (both NULL) and per-node /
-- per-drive rows all collapse to a single unique tuple.
CREATE UNIQUE INDEX IF NOT EXISTS alarm_sub_uniq ON alarm_subscriptions (
    email,
    alarm_type,
    COALESCE(node_id,  '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(drive_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE INDEX IF NOT EXISTS alarm_sub_email_idx ON alarm_subscriptions (email);
