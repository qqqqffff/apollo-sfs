-- Records the admin's reason for a Cancel action (orders.Handler.
-- CancelSubscription) — always set regardless of whether a refund was
-- issued. Distinguishes admin-initiated cancellations from ordinary
-- self-service cancels/webhooks (which never set this), so the cancelled
-- user's notification bell can surface a "why" alongside the prorated
-- refund amount.
ALTER TABLE premium_subscriptions
    ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
