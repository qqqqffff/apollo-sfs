-- Transactional email queue processed by the background mail worker.
-- template_data is raw JSON passed to the template renderer at send time.
-- The worker increments attempts before each send; after 3 failed attempts
-- status is set to 'failed' and the row is left for inspection.

CREATE TYPE email_status AS ENUM ('pending', 'sent', 'failed');

CREATE TABLE email_queue (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    to_address    TEXT         NOT NULL,
    subject       TEXT         NOT NULL,
    template_name TEXT         NOT NULL,
    template_data JSONB        NOT NULL DEFAULT '{}',
    status        email_status NOT NULL DEFAULT 'pending',
    attempts      INT          NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    sent_at       TIMESTAMPTZ
);

CREATE INDEX email_queue_pending_idx ON email_queue (created_at ASC) WHERE status = 'pending';
