-- PayPal payment records.
-- One row per checkout attempt; paypal_order_id and paypal_capture_id are
-- both unique. paypal_capture_id UNIQUE is the idempotency key used by
-- services/payment.go ApplyCapture so the synchronous capture handler and
-- the asynchronous webhook can both fire without double-granting premium.

CREATE TABLE payments (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username           TEXT        NOT NULL REFERENCES users (username) ON DELETE CASCADE,
    paypal_order_id    TEXT        NOT NULL UNIQUE,
    paypal_capture_id  TEXT        UNIQUE,
    amount_cents       INTEGER     NOT NULL,
    currency           TEXT        NOT NULL,
    status             TEXT        NOT NULL CHECK (status IN ('created', 'approved', 'captured', 'refunded', 'failed')),
    payment_method     TEXT        NOT NULL CHECK (payment_method IN ('apple_pay', 'card', 'paypal')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    captured_at        TIMESTAMPTZ,
    -- Admin refunds (90-day window from capture).
    refund_id          TEXT,
    refunded_at        TIMESTAMPTZ,
    raw_webhook        JSONB,
    -- Which PayPal environment this order was created against (admin sandbox
    -- payments toggle). Stamped at creation so later captures/refunds always
    -- use the matching client.
    environment        TEXT        NOT NULL DEFAULT 'live' CHECK (environment IN ('sandbox', 'live'))
);

CREATE INDEX payments_username_idx        ON payments (username);
CREATE INDEX payments_status_idx          ON payments (status);
