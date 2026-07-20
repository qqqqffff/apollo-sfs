-- The premium checkout modal now creates PayPal orders the same way the
-- storage-allocation modal does: no payment_source restriction at creation,
-- so the buyer can complete via the PayPal wallet button, Google Pay, or
-- hosted card fields (see billing.CreateWalletOrder / storage_orders'
-- payment_method, which already stores "paypal" for that flow). The
-- payments table's CHECK constraint predates this and only allowed the
-- single-funding-source premium flow ('apple_pay', 'card') — widen it to
-- also accept 'paypal'.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_payment_method_check
    CHECK (payment_method IN ('apple_pay', 'card', 'paypal'));
