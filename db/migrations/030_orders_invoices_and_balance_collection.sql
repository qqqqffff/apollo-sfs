-- Orders admin page, custom-request invoicing, and provision-first balance
-- collection:
--   * expansion_invoices table (custom requests are invoiced after manual
--     review; estimated price only at submission, 14-business-day acceptance)
--   * refund tracking on payments and storage_orders (90-day admin refunds)
--   * server_expansion_requests: reminder_sent_at + new statuses
--     invoice_sent / accepted / rejected
--   * quota is provisioned before the remaining balance is collected;
--     a reminder is emailed after 7 business days and the allocation is
--     reverted (deposit kept) 30 days after payment came due

-- ── payments / storage_orders refunds ─────────────────────────────────────────
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS refund_id   TEXT,
    ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

ALTER TABLE storage_orders
    ADD COLUMN IF NOT EXISTS refund_id   TEXT,
    ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

-- ── server_expansion_requests ─────────────────────────────────────────────────
ALTER TABLE server_expansion_requests
    ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

ALTER TABLE server_expansion_requests
    DROP CONSTRAINT IF EXISTS server_expansion_requests_status_check;
ALTER TABLE server_expansion_requests
    ADD CONSTRAINT server_expansion_requests_status_check
    CHECK (status IN ('opened','invoice_sent','accepted','approved','expanded',
                      'completed','expired','refunded','rejected'));

-- Custom requests are now submitted without an up-front payment, so
-- paypal_order_id may be empty until the invoice deposit is captured.

-- ── expansion_invoices ────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS expansion_invoice_number_seq;

CREATE TABLE IF NOT EXISTS expansion_invoices (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id          UUID        NOT NULL REFERENCES server_expansion_requests(id) ON DELETE CASCADE,
    invoice_number      TEXT        NOT NULL UNIQUE,
    line_items          JSONB       NOT NULL,
    total_cents         BIGINT      NOT NULL,
    deposit_cents       BIGINT      NOT NULL DEFAULT 0,
    disclosures         TEXT        NOT NULL DEFAULT '',
    notes               TEXT        NOT NULL DEFAULT '',
    include_review_link BOOLEAN     NOT NULL DEFAULT TRUE,
    review_token        TEXT        UNIQUE,
    status              TEXT        NOT NULL DEFAULT 'sent'
                            CHECK (status IN ('sent','accepted','expired','cancelled')),
    paypal_order_id     TEXT,
    paypal_capture_id   TEXT        UNIQUE,
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accept_due_at       TIMESTAMPTZ NOT NULL,
    accepted_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ei_request_id_idx ON expansion_invoices (request_id);
CREATE INDEX IF NOT EXISTS ei_status_idx     ON expansion_invoices (status);
CREATE INDEX IF NOT EXISTS ei_accept_due_idx ON expansion_invoices (accept_due_at) WHERE status = 'sent';
