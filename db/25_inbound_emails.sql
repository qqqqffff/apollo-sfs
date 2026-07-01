-- Inbound emails received via the SendGrid Inbound Parse webhook.
-- The full parsed message (headers, text/html bodies, attachments) is written
-- to disk under EMAIL_STORAGE_PATH/<worker_name>/<YYYY-MM>/<id>.json; this table
-- is only a queryable index. worker_name is the sanitized local-part of the
-- recipient address (e.g. "support" from support@domain.com).
--
-- message_id is the RFC 5322 Message-ID when present; it is UNIQUE so the
-- webhook can ignore SendGrid's at-least-once retries via ON CONFLICT DO NOTHING.
-- It is nullable because not every message carries one, and Postgres treats
-- multiple NULLs as distinct under a UNIQUE constraint.

CREATE TABLE inbound_emails (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    worker_name     TEXT        NOT NULL,
    message_id      TEXT        UNIQUE,
    from_addr       TEXT        NOT NULL,
    to_addr         TEXT        NOT NULL,
    subject         TEXT        NOT NULL DEFAULT '',
    file_path       TEXT        NOT NULL,
    has_attachments BOOLEAN     NOT NULL DEFAULT FALSE,
    read            BOOLEAN     NOT NULL DEFAULT FALSE,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary access pattern: list a worker's inbox newest-first.
CREATE INDEX inbound_emails_worker_idx ON inbound_emails (worker_name, received_at DESC);

-- Partial index backing the per-worker unread badge counts.
CREATE INDEX inbound_emails_unread_idx ON inbound_emails (worker_name) WHERE read = FALSE;
