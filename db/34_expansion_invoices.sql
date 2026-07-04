-- Invoices for custom capacity expansion requests.
-- Custom requests (1 TiB – 10 PiB) show the user an *estimated* price at
-- submission time and collect no payment. After manual review (3 business
-- day SLA) an admin builds an invoice with final line-item pricing, an
-- optional deposit, disclosures and notes, and sends it by email. When
-- include_review_link is set, the email links back to the website where the
-- user reviews and approves the invoice (paying the deposit if one is
-- listed). The user has 14 business days to accept and pay, otherwise the
-- request expires.
CREATE SEQUENCE IF NOT EXISTS expansion_invoice_number_seq;

CREATE TABLE expansion_invoices (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id          UUID        NOT NULL REFERENCES server_expansion_requests(id) ON DELETE CASCADE,
    invoice_number      TEXT        NOT NULL UNIQUE,
    -- line_items: [{"description": TEXT, "amount_cents": INT}, ...]
    line_items          JSONB       NOT NULL,
    total_cents         BIGINT      NOT NULL,
    deposit_cents       BIGINT      NOT NULL DEFAULT 0,
    disclosures         TEXT        NOT NULL DEFAULT '',
    notes               TEXT        NOT NULL DEFAULT '',
    include_review_link BOOLEAN     NOT NULL DEFAULT TRUE,
    review_token        TEXT        UNIQUE,
    -- sent      : emailed to the user, awaiting acceptance
    -- accepted  : user approved (and paid the deposit when one was listed)
    -- expired   : 14-business-day acceptance window elapsed
    -- cancelled : superseded by a newer invoice or declined by the user
    status              TEXT        NOT NULL DEFAULT 'sent'
                            CHECK (status IN ('sent','accepted','expired','cancelled')),
    -- PayPal order/capture for the deposit payment (when deposit_cents > 0).
    paypal_order_id     TEXT,
    paypal_capture_id   TEXT        UNIQUE,
    sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accept_due_at       TIMESTAMPTZ NOT NULL,
    accepted_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ei_request_id_idx ON expansion_invoices (request_id);
CREATE INDEX ei_status_idx     ON expansion_invoices (status);
CREATE INDEX ei_accept_due_idx ON expansion_invoices (accept_due_at) WHERE status = 'sent';
