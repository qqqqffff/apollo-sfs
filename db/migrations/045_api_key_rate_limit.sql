-- Per-key rate limiting for the SFS S3-like API. Each key carries its own
-- requests/minute cap, settable by the owner up to the global ceiling of
-- 1000/min, enforced in-process by routes/middleware/apikey.go.

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS rate_limit_per_min INTEGER NOT NULL DEFAULT 300
        CHECK (rate_limit_per_min BETWEEN 1 AND 1000);
