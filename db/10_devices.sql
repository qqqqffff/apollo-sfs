-- Mobile device registrations. One row per installed app instance.
-- push_token is the APNs/FCM token for server-initiated push notifications (optional).

CREATE TABLE devices (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL,
    name         TEXT        NOT NULL,
    platform     TEXT        NOT NULL CHECK (platform IN ('ios', 'android')),
    push_token   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX devices_user_id_idx ON devices (user_id);
