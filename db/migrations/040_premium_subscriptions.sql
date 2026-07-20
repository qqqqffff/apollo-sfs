-- Premium is being rebuilt as a real recurring PayPal subscription (see
-- docs/paypal_setup.md, which has always described it that way even though
-- the code implemented a one-time Orders v2 purchase). This table is
-- billing/bookkeeping metadata layered on top of the existing enforcement
-- path (users.is_premium + the Keycloak "premium" group) — it does not
-- replace either of those.
CREATE TABLE IF NOT EXISTS premium_subscriptions (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    username                TEXT        NOT NULL REFERENCES users(username) ON DELETE CASCADE,
    paypal_subscription_id  TEXT        NOT NULL UNIQUE,
    plan                    TEXT        NOT NULL CHECK (plan IN ('monthly', 'annual')),
    status                  TEXT        NOT NULL CHECK (status IN (
                                'approval_pending', 'active', 'suspended', 'cancelled', 'expired'
                            )),
    -- Which PayPal environment this subscription was created against (admin
    -- sandbox payments toggle) — mirrors payments.environment/storage_orders.environment.
    environment             TEXT        NOT NULL DEFAULT 'live' CHECK (environment IN ('sandbox', 'live')),
    current_period_end      TIMESTAMPTZ,  -- PayPal's billing_info.next_billing_time; NULL until ACTIVATED
    cancelled_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_webhook             JSONB
);

CREATE INDEX IF NOT EXISTS premium_subscriptions_username_idx ON premium_subscriptions (username);
CREATE INDEX IF NOT EXISTS premium_subscriptions_status_idx   ON premium_subscriptions (status);

-- At most one truly live subscription per user. approval_pending rows are
-- deliberately NOT constrained here — abandoned checkouts are superseded
-- (see ExpireStalePendingSubscriptions) rather than blocking a retry.
CREATE UNIQUE INDEX IF NOT EXISTS premium_subscriptions_one_live_idx
    ON premium_subscriptions (username)
    WHERE status IN ('active', 'suspended');
