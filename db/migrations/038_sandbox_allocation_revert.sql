-- Tracks when a captured sandbox order's local quota/premium grant was
-- undone via the admin "Revert allocation" action or the 7-day auto-revert
-- loop. Separate from refund_id/refunded_at: reverting is orthogonal to
-- refunding (no PayPal call, order stays 'captured' for accounting) and
-- payments.status has a CHECK constraint that doesn't need a new value here.
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS allocation_reverted_at TIMESTAMPTZ;

ALTER TABLE storage_orders
    ADD COLUMN IF NOT EXISTS allocation_reverted_at TIMESTAMPTZ;
