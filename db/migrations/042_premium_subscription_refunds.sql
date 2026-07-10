-- Tracks admin-initiated prorated refunds on premium subscription
-- cancellations (see orders.Handler.CancelSubscription). Mirrors the
-- refund_id/refunded_at columns already on payments/storage_orders;
-- refund_amount_cents additionally records the prorated amount, since it's
-- never the full amount_cents like a one-time order refund is.
ALTER TABLE premium_subscriptions
    ADD COLUMN IF NOT EXISTS refund_id            TEXT,
    ADD COLUMN IF NOT EXISTS refund_amount_cents   INTEGER,
    ADD COLUMN IF NOT EXISTS refunded_at           TIMESTAMPTZ;
