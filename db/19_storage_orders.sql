-- storage_orders tracks one-time storage add-on purchases. Separate from the
-- premium `payments` table: multiple purchases are expected and each one
-- additively increases storage_quota_bytes on the users row.

CREATE TABLE IF NOT EXISTS storage_orders (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username          TEXT        NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    plan_id           TEXT        NOT NULL,               -- "64gb" | "128gb" | "256gb" | "512gb" | "1tb"
    storage_type      TEXT        NOT NULL,               -- "nvme" | "hdd"
    bytes_added       BIGINT      NOT NULL,
    amount_cents      INT         NOT NULL,
    currency          TEXT        NOT NULL DEFAULT 'USD',
    payment_method    TEXT        NOT NULL,               -- "paypal" | "card" | "apple_pay" | "google_pay"
    status            TEXT        NOT NULL DEFAULT 'created', -- "created" | "captured"
    paypal_order_id   TEXT        NOT NULL,
    paypal_capture_id TEXT        UNIQUE,                 -- idempotency key; NULL until captured
    server_id         UUID        REFERENCES servers(id), -- purchase target; NULL for legacy orders
    -- Admin refunds (90-day window from capture); refund reverts the quota.
    refund_id         TEXT,
    refunded_at       TIMESTAMPTZ,
    raw_response      JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    captured_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS storage_orders_username_idx       ON storage_orders (username);
CREATE INDEX IF NOT EXISTS storage_orders_paypal_order_idx  ON storage_orders (paypal_order_id);
