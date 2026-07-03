-- interest_submissions: stores interest form submissions from unauthenticated visitors.
-- Tracks name, email, desired storage size, use case, and originating IP.
-- Admins can provision accounts from submissions via the admin panel.

CREATE TABLE IF NOT EXISTS interest_submissions (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name               TEXT        NOT NULL,
    email              TEXT        NOT NULL,
    desired_storage_gb INT         NOT NULL,
    use_case           TEXT        NOT NULL,
    ip_address         TEXT        NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    provisioned_at     TIMESTAMPTZ,
    invitation_id      UUID        REFERENCES invitations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS interest_submissions_email_idx
    ON interest_submissions (email);

CREATE INDEX IF NOT EXISTS interest_submissions_ip_idx
    ON interest_submissions (ip_address);

CREATE INDEX IF NOT EXISTS interest_submissions_created_idx
    ON interest_submissions (created_at DESC);

-- Single-row settings table for configurable interest form parameters.
-- Enforced to have exactly one row with id = 1.
CREATE TABLE IF NOT EXISTS interest_form_settings (
    id         INT         PRIMARY KEY DEFAULT 1,
    daily_cap  INT         NOT NULL DEFAULT 100,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO interest_form_settings (id, daily_cap)
VALUES (1, 100)
ON CONFLICT (id) DO NOTHING;
