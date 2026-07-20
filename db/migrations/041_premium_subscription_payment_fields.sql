-- Gives premium_subscriptions the same payment-record shape as payments/
-- storage_orders (amount charged, currency, payment method) so the client
-- orders page can list them alongside other purchase history.
ALTER TABLE premium_subscriptions
    ADD COLUMN IF NOT EXISTS amount_cents   INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS currency       TEXT NOT NULL DEFAULT 'USD',
    ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'paypal';
