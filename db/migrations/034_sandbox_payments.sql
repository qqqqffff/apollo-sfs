-- Sandbox payments toggle: stamps which PayPal environment each order was
-- actually created against, so a later capture/refund always uses the
-- matching client regardless of the acting admin's current toggle state.
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'live'
        CHECK (environment IN ('sandbox', 'live'));

ALTER TABLE storage_orders
    ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'live'
        CHECK (environment IN ('sandbox', 'live'));

ALTER TABLE server_expansion_requests
    ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'live'
        CHECK (environment IN ('sandbox', 'live'));
