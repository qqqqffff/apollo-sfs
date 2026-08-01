-- Self-billed premium subscriptions (card / Apple Pay / Google Pay).
--
-- Premium has until now been PayPal Subscriptions v1 only: the shopper is sent
-- to PayPal's hosted approval page and PayPal owns the recurring billing. That
-- flow is PayPal-wallet-only by construction — POST /v1/billing/subscriptions
-- silently ignores a `payment_source`, so a card or wallet cannot be bound to
-- a PayPal-managed subscription at all (verified against sandbox: a bogus
-- payment_source returns 201 APPROVAL_PENDING and the subscription echoes no
-- payment_source back, while a bad plan_id correctly 400s).
--
-- So the three non-wallet funding sources are billed by us instead, on the
-- rails Orders v2 does support and that the storage add-ons already use:
--
--   1. First period: an ordinary Orders v2 create+capture with
--      payment_source.<src>.attributes.vault.store_in_vault = ON_SUCCESS.
--      The response carries attributes.vault.id — the saved payment method.
--   2. Every period after: Orders v2 create+capture against that vault_id with
--      stored_credential {payment_initiator: MERCHANT, payment_type: RECURRING,
--      usage: SUBSEQUENT, usage_pattern: SUBSCRIPTION_PREPAID}, no shopper
--      present. Driven by SubscriptionRenewalLoop.
--
-- Both modes live in this one table so "does this user have premium" stays a
-- single query, and the existing premium_subscriptions_one_live_idx keeps a
-- user from holding a PayPal-managed and a self-billed subscription at once.
--
-- Self-billed rows have no PayPal subscription id, but paypal_subscription_id
-- is NOT NULL UNIQUE and is the lookup key for every webhook path. Rather than
-- relax that (and have to null-guard every one of those paths), self-billed
-- rows synthesise 'self:<uuid>', which no PayPal webhook can ever match.
--
-- Idempotent so it can be re-applied safely against partially-migrated
-- databases.

ALTER TABLE premium_subscriptions
    -- 'paypal' = PayPal-managed (Subscriptions v1, hosted approval).
    -- 'self'   = billed by us against a vaulted payment method.
    ADD COLUMN IF NOT EXISTS billing_mode        TEXT NOT NULL DEFAULT 'paypal',
    -- PayPal Vault payment-method token (payment_source.<src>.attributes.vault.id).
    -- Self-billed rows only; NULL for PayPal-managed ones.
    ADD COLUMN IF NOT EXISTS vault_id            TEXT,
    -- Which funding source the vaulted token is, so renewals rebuild the same
    -- payment_source key. Wallet tokens vault as the underlying card, but the
    -- original source is kept for display and for support/debugging.
    ADD COLUMN IF NOT EXISTS vault_source        TEXT,
    -- When the next renewal charge is due. Self-billed rows only; the loop
    -- claims rows whose next_charge_at has passed.
    ADD COLUMN IF NOT EXISTS next_charge_at      TIMESTAMPTZ,
    -- Consecutive failed renewal attempts. Reset to 0 on every success.
    ADD COLUMN IF NOT EXISTS failed_charge_count INT NOT NULL DEFAULT 0,
    -- Last renewal failure, for the admin orders page and support.
    ADD COLUMN IF NOT EXISTS last_charge_error   TEXT,
    -- PayPal capture id of the most recent successful charge (opening period
    -- or renewal). The admin prorated-refund tooling needs it: a self-billed
    -- subscription has no PayPal subscription, so there are no subscription
    -- transactions to look the sale up from — the capture id is the only
    -- handle on the money that moved.
    ADD COLUMN IF NOT EXISTS last_capture_id     TEXT;

DO $$
BEGIN
    ALTER TABLE premium_subscriptions
        ADD CONSTRAINT premium_subscriptions_billing_mode_check
        CHECK (billing_mode IN ('paypal', 'self'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE premium_subscriptions
        ADD CONSTRAINT premium_subscriptions_vault_source_check
        CHECK (vault_source IS NULL OR vault_source IN ('card', 'apple_pay', 'google_pay'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- A self-billed subscription is only chargeable if it actually carries a
-- vaulted payment method — without one the renewal loop would spin on a row it
-- can never charge.
DO $$
BEGIN
    ALTER TABLE premium_subscriptions
        ADD CONSTRAINT premium_subscriptions_self_needs_vault_check
        CHECK (billing_mode <> 'self' OR vault_id IS NOT NULL);
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Drives the renewal loop's claim query. Partial: only live self-billed rows
-- are ever due, which is a small slice of the table.
CREATE INDEX IF NOT EXISTS premium_subscriptions_due_idx
    ON premium_subscriptions (next_charge_at)
    WHERE billing_mode = 'self' AND status IN ('active', 'suspended');
