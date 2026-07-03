CREATE TABLE audit_logs (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    target_username TEXT        NOT NULL,
    actor_username  TEXT        NOT NULL,
    action          TEXT        NOT NULL,
    resource_type   TEXT,
    resource_id     UUID,
    resource_name   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_target ON audit_logs (target_username, created_at DESC);
