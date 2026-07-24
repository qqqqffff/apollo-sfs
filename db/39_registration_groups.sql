-- Limited user group registration: admin-configured groups of preconfigured
-- account slots that end users claim from a public /group-invite?id=<link_id>
-- page. Each slot pins a server + drive tier + quota + account status; while a
-- group is active every unconsumed slot pre-reserves its quota on the drive
-- (see the reserved-slot joins in the capacity queries in api/db/drives.go),
-- so ordinary invitations cannot allocate the space out from under it.

CREATE TABLE registration_groups (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by_user_id   UUID        NOT NULL,
    name                 TEXT        NOT NULL,
    -- Public link identifier: "<slugified name>-<4 random alphanumerics>",
    -- used as https://<app>/group-invite?id=<link_id>.
    link_id              TEXT        NOT NULL UNIQUE,
    expires_at           TIMESTAMPTZ,
    is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
    -- Addresses notified when the group is created (and again a day before
    -- expiry when send_expiry_reminder is set).
    notify_emails        TEXT[]      NOT NULL DEFAULT '{}',
    send_expiry_reminder BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Set once the last-chance reminder has been enqueued so the background
    -- sweep never double-sends.
    reminder_sent_at     TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per registerable account. Duplicated slot configurations are stored
-- as N identical rows and grouped for display. drive_id is resolved at group
-- creation (best-fit active drive of the requested tier on the server).
-- Admin accounts cannot be provisioned this way (account_status has no
-- 'admin' value on purpose); premium_expires_at is meaningful only for
-- 'premium' slots (NULL = permanent grant).
CREATE TABLE registration_slots (
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

CREATE INDEX registration_slots_group_id_idx ON registration_slots (group_id);
CREATE INDEX registration_slots_drive_id_idx ON registration_slots (drive_id);

-- Short-lived (10 minute) hold on one specific slot while a user completes the
-- registration form. Expired holds are swept lazily (released_at set) before
-- any new reservation is taken, so the partial unique index below can enforce
-- at most one live hold per slot without a time predicate.
CREATE TABLE registration_slot_reservations (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id      UUID        NOT NULL REFERENCES registration_slots (id) ON DELETE CASCADE,
    token        TEXT        NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    released_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX registration_slot_reservations_active_idx
    ON registration_slot_reservations (slot_id)
    WHERE completed_at IS NULL AND released_at IS NULL;
