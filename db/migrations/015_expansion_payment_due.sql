-- Migration 29: add payment_due_at to server_expansion_requests
--
-- When an admin marks an expansion request as fulfilled (server capacity expanded),
-- the user has 3 days to pay the remaining 50% balance. If they do not pay within
-- that window the request expires and the deposit is forfeited (not refunded).

ALTER TABLE server_expansion_requests
  ADD COLUMN payment_due_at TIMESTAMPTZ;
