-- interest_submissions: stores interest form submissions from unauthenticated visitors.
-- Tracks name, email, requested storage plan, use case, and originating IP.
-- A 50% refundable deposit (same fixed plan pricing as storage_orders /
-- server_expansion_requests) must be captured via PayPal before a submission
-- is accepted — no free-form storage amounts are allowed.
-- Admins can provision accounts from submissions, or deny them (refunding the
-- deposit), via the admin panel.

CREATE TABLE IF NOT EXISTS interest_submissions (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  TEXT        NOT NULL,
    email                 TEXT        NOT NULL,
    desired_storage_gb    INT         NOT NULL,
    use_case              TEXT        NOT NULL,
    ip_address            TEXT        NOT NULL,
    -- Fixed storage plan requested (mirrors billing.storagePlans — 64gb,
    -- 128gb, 256gb, 512gb, 1tb). No custom/arbitrary amounts.
    plan_id               TEXT        NOT NULL DEFAULT '',
    storage_type          TEXT        NOT NULL DEFAULT 'nvme',
    full_price_cents      INT         NOT NULL DEFAULT 0,
    deposit_amount_cents  INT         NOT NULL DEFAULT 0,
    currency              TEXT        NOT NULL DEFAULT 'USD',
    payment_method        TEXT        NOT NULL DEFAULT '',
    paypal_order_id       TEXT,
    paypal_capture_id     TEXT,
    denied_at             TIMESTAMPTZ,
    refund_id             TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    provisioned_at        TIMESTAMPTZ,
    invitation_id         UUID        REFERENCES invitations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS interest_submissions_email_idx
    ON interest_submissions (email);

CREATE INDEX IF NOT EXISTS interest_submissions_ip_idx
    ON interest_submissions (ip_address);

CREATE INDEX IF NOT EXISTS interest_submissions_created_idx
    ON interest_submissions (created_at DESC);

-- interest_deposit_orders bridges the deposit-payment step (which happens
-- before the visitor has submitted name/email/use_case) to the final
-- interest_submissions row above: a PayPal order is created and captured
-- against a fixed plan_id/storage_type, then consumed exactly once when the
-- form is submitted.
CREATE TABLE IF NOT EXISTS interest_deposit_orders (
    order_id             TEXT        PRIMARY KEY,
    plan_id              TEXT        NOT NULL,
    storage_type         TEXT        NOT NULL,
    full_price_cents     INT         NOT NULL,
    deposit_amount_cents INT         NOT NULL,
    currency             TEXT        NOT NULL,
    payment_method       TEXT        NOT NULL,
    paypal_capture_id    TEXT,
    captured_at          TIMESTAMPTZ,
    consumed_at          TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS interest_deposit_orders_created_idx
    ON interest_deposit_orders (created_at DESC);

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
