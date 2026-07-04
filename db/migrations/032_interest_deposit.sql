-- Interest form now requires a 50% refundable deposit against the same fixed
-- storage-plan pricing used elsewhere (server_expansion_requests /
-- storage_orders) instead of a free-form desired_storage_gb amount.
--
-- interest_deposit_orders bridges the deposit-payment step (which happens
-- before the visitor has submitted name/email/use_case) to the final
-- interest_submissions row: a PayPal order is created and captured against a
-- fixed plan_id/storage_type, then consumed exactly once when the form is
-- submitted.
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

ALTER TABLE interest_submissions
    ADD COLUMN IF NOT EXISTS plan_id              TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS storage_type          TEXT NOT NULL DEFAULT 'nvme',
    ADD COLUMN IF NOT EXISTS full_price_cents      INT  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS deposit_amount_cents  INT  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS currency              TEXT NOT NULL DEFAULT 'USD',
    ADD COLUMN IF NOT EXISTS payment_method         TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS paypal_order_id        TEXT,
    ADD COLUMN IF NOT EXISTS paypal_capture_id      TEXT,
    ADD COLUMN IF NOT EXISTS denied_at              TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refund_id              TEXT;

CREATE INDEX IF NOT EXISTS interest_deposit_orders_created_idx
    ON interest_deposit_orders (created_at DESC);
