-- Audit log for master key rotation events.
-- Rows are inserted before rotation begins (status = 'failed') and updated to
-- 'completed' only when the full re-wrap succeeds, so any mid-rotation crash
-- leaves a self-documenting failed record.

CREATE TYPE key_rotation_status AS ENUM ('completed', 'failed');

CREATE TABLE key_rotation_log (
    id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    old_key_version TEXT                NOT NULL,
    new_key_version TEXT                NOT NULL,
    users_rewrapped INT                 NOT NULL DEFAULT 0,
    started_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    status          key_rotation_status NOT NULL,
    error           TEXT
);
