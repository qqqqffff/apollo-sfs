-- Limited user group registration: registration groups, their preconfigured
-- account slots, and short-lived slot reservations. Mirrors
-- db/39_registration_groups.sql for existing databases.

CREATE TABLE IF NOT EXISTS registration_groups (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by_user_id   UUID        NOT NULL,
    name                 TEXT        NOT NULL,
    link_id              TEXT        NOT NULL UNIQUE,
    expires_at           TIMESTAMPTZ,
    is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
    notify_emails        TEXT[]      NOT NULL DEFAULT '{}',
    send_expiry_reminder BOOLEAN     NOT NULL DEFAULT FALSE,
    reminder_sent_at     TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS registration_slots (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id           UUID        NOT NULL REFERENCES registration_groups (id) ON DELETE CASCADE,
    server_id          UUID        NOT NULL REFERENCES servers (id),
    drive_id           UUID        NOT NULL REFERENCES drives (id),
    drive_type         TEXT        NOT NULL CHECK (drive_type IN ('nvme', 'hdd')),
    quota_bytes        BIGINT      NOT NULL CHECK (quota_bytes > 0),
    account_status     TEXT        NOT NULL DEFAULT 'base' CHECK (account_status IN ('base', 'premium')),
    premium_expires_at TIMESTAMPTZ,
    consumed_at        TIMESTAMPTZ,
    consumed_by        TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS registration_slots_group_id_idx ON registration_slots (group_id);
CREATE INDEX IF NOT EXISTS registration_slots_drive_id_idx ON registration_slots (drive_id);

CREATE TABLE IF NOT EXISTS registration_slot_reservations (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id      UUID        NOT NULL REFERENCES registration_slots (id) ON DELETE CASCADE,
    token        TEXT        NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    released_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS registration_slot_reservations_active_idx
    ON registration_slot_reservations (slot_id)
    WHERE completed_at IS NULL AND released_at IS NULL;
