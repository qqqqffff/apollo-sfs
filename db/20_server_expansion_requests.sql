-- Server capacity expansion requests.
-- When a user wants to purchase a storage tier whose capacity is not currently
-- available on their chosen server (or the server is >= 90% allocated), they
-- can submit an expansion request with a 50% deposit.
--
-- SLA model (business days, Mon–Fri):
--   * approval: 7 business days from deposit (3 for custom manual-review
--     requests). Missed → deposit auto-refunded.
--   * expansion: 14 business days from approval. Missed → deposit auto-refunded.
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
    -- opened    : deposit captured, awaiting admin approval
    -- approved  : admin approved; capacity expansion in progress
    -- expanded  : server capacity physically expanded, quota not yet allocated
    -- completed : quota allocated to user
    -- expired   : an SLA elapsed, deposit refunded automatically (or the user
    --             missed the remaining-balance payment window — no refund)
    -- refunded  : admin cancelled, deposit refunded with reason
    status               TEXT        NOT NULL DEFAULT 'opened'
                             CHECK (status IN ('opened','approved','expanded','completed','expired','refunded')),
    -- is_custom marks custom capacity requests (1 TiB – 10 PiB) that go
    -- through manual review with a 3-business-day approval SLA.
    is_custom            BOOLEAN     NOT NULL DEFAULT FALSE,
    pre_quota_bytes      BIGINT      NOT NULL,
    post_quota_bytes     BIGINT,
    expires_at           TIMESTAMPTZ NOT NULL,
    -- approval_due_at mirrors expires_at for new rows: the admin must approve
    -- by this time or the deposit is refunded.
    approval_due_at      TIMESTAMPTZ,
    approved_at          TIMESTAMPTZ,
    -- expansion_due_at = approved_at + 14 business days; capacity must be
    -- expanded by then or the deposit is refunded.
    expansion_due_at     TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at         TIMESTAMPTZ,
    -- payment_due_at is set when admin marks request 'expanded'; user has 3 days
    -- to pay the remaining 50% balance before the request expires.
    payment_due_at       TIMESTAMPTZ,
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
CREATE INDEX ser_approval_due_idx ON server_expansion_requests (approval_due_at)
    WHERE status = 'opened';
CREATE INDEX ser_expansion_due_idx ON server_expansion_requests (expansion_due_at)
    WHERE status = 'approved';
