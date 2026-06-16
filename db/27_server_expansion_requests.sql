-- Server capacity expansion requests.
-- When a user wants to purchase a storage tier whose capacity is not currently
-- available on their chosen server, they can submit an expansion request with a
-- 50% deposit. The request expires after 14 days; the deposit is refunded if the
-- admin does not fulfil it in time.
CREATE TABLE server_expansion_requests (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username             TEXT        NOT NULL REFERENCES users(username),
    server_id            UUID        NOT NULL REFERENCES servers(id),
    plan_id              TEXT        NOT NULL,
    storage_type         TEXT        NOT NULL CHECK (storage_type IN ('nvme', 'hdd')),
    bytes_requested      BIGINT      NOT NULL,
    deposit_amount_cents INT         NOT NULL,
    full_price_cents     INT         NOT NULL,
    currency             TEXT        NOT NULL DEFAULT 'USD',
    payment_method       TEXT        NOT NULL,
    paypal_order_id      TEXT        NOT NULL,
    paypal_capture_id    TEXT,
    -- opened    : deposit captured, awaiting admin action
    -- expanded  : server capacity physically expanded, quota not yet allocated
    -- completed : quota allocated to user
    -- expired   : 14-day SLA elapsed, deposit refunded automatically
    -- refunded  : admin cancelled, deposit refunded with reason
    status               TEXT        NOT NULL DEFAULT 'opened'
                             CHECK (status IN ('opened','expanded','completed','expired','refunded')),
    pre_quota_bytes      BIGINT      NOT NULL,
    post_quota_bytes     BIGINT,
    expires_at           TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at         TIMESTAMPTZ,
    refund_id            TEXT,
    cancellation_reason  TEXT
);

CREATE UNIQUE INDEX ser_paypal_capture_id_uidx
    ON server_expansion_requests (paypal_capture_id)
    WHERE paypal_capture_id IS NOT NULL;

CREATE INDEX ser_username_idx    ON server_expansion_requests (username);
CREATE INDEX ser_server_id_idx   ON server_expansion_requests (server_id);
CREATE INDEX ser_status_idx      ON server_expansion_requests (status);
CREATE INDEX ser_created_at_idx  ON server_expansion_requests (created_at DESC);
CREATE INDEX ser_expires_at_idx  ON server_expansion_requests (expires_at)
    WHERE status = 'opened';
