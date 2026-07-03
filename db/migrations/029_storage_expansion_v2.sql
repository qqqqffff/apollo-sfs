-- Storage capacity expansion v2:
--   * business-day SLA model with an explicit admin approval stage
--     (opened → approved → expanded → completed)
--   * custom capacity requests (1 TiB – 10 PiB, manual review)
--   * server_id recorded on direct storage purchases (90% allocation rule)
--   * user preference toggles for the storage upgrade UI

-- ── user_preferences ──────────────────────────────────────────────────────────
-- show_storage_buttons: show the "+" add-storage buttons on the client home
-- page and upload modal. storage_prompt_enabled: automatically open the
-- storage upgrade modal when an upload would push usage past 75% of quota or
-- exceed it. Both default ON.
ALTER TABLE user_preferences
    ADD COLUMN IF NOT EXISTS show_storage_buttons   BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS storage_prompt_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- ── storage_orders ────────────────────────────────────────────────────────────
-- The server the user purchased capacity on. NULL for legacy/mobile orders
-- that did not specify a server.
ALTER TABLE storage_orders
    ADD COLUMN IF NOT EXISTS server_id UUID REFERENCES servers(id);

-- ── server_expansion_requests ─────────────────────────────────────────────────
-- approval_due_at   : admin must approve by this time (7 business days;
--                     3 business days for custom manual-review requests) or
--                     the deposit is auto-refunded.
-- approved_at       : when the admin approved the request.
-- expansion_due_at  : capacity must be expanded within 14 business days of
--                     approval or the deposit is auto-refunded.
-- is_custom         : custom capacity request (manual review).
ALTER TABLE server_expansion_requests
    ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS approval_due_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS expansion_due_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS is_custom        BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing 'opened' rows keep their original 14-calendar-day deadline as the
-- approval deadline.
UPDATE server_expansion_requests
SET approval_due_at = expires_at
WHERE approval_due_at IS NULL;

-- Allow the new 'approved' status.
ALTER TABLE server_expansion_requests
    DROP CONSTRAINT IF EXISTS server_expansion_requests_status_check;
ALTER TABLE server_expansion_requests
    ADD CONSTRAINT server_expansion_requests_status_check
    CHECK (status IN ('opened','approved','expanded','completed','expired','refunded'));

CREATE INDEX IF NOT EXISTS ser_approval_due_idx
    ON server_expansion_requests (approval_due_at)
    WHERE status = 'opened';
CREATE INDEX IF NOT EXISTS ser_expansion_due_idx
    ON server_expansion_requests (expansion_due_at)
    WHERE status = 'approved';
