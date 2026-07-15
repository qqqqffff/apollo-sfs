-- Admin product-pricing editor:
--   * storage_pricing_items    — per-server, per-tier purchasable storage line
--     items (quantity + price), replacing the hardcoded plan table in
--     api/routes/billing/plans.go for servers that have rows here. Line items
--     are purchased by their UUID (plan_id in storage_orders); the legacy
--     string plan ids ("64gb"…"1tb") keep resolving against the hardcoded
--     table so existing mobile clients are unaffected.
--   * pricing_discounts        — admin-created discounts at server, tier, or
--     line-item scope. Exactly one row may exist per exact target (creating a
--     new one replaces it). Most-specific scope wins at price resolution;
--     expired rows (expires_at in the past) are ignored, never auto-deleted.

-- ── storage_pricing_items ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_pricing_items (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id    UUID        NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    storage_type TEXT        NOT NULL CHECK (storage_type IN ('nvme', 'hdd')),
    bytes        BIGINT      NOT NULL CHECK (bytes > 0),
    price_cents  INTEGER     NOT NULL CHECK (price_cents >= 0),
    sort_order   INTEGER     NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (server_id, storage_type, bytes)
);

CREATE INDEX IF NOT EXISTS storage_pricing_items_server_idx
    ON storage_pricing_items (server_id, storage_type, sort_order, bytes);

-- ── pricing_discounts ─────────────────────────────────────────────────────────
-- scope='server' targets every item on server_id; scope='tier' additionally
-- requires storage_type; scope='item' requires item_id (server_id/storage_type
-- are still stored, denormalized from the item, so recipient queries and the
-- admin listing never need a join).
-- mode='percent' stores percent_off (1–100); mode='price' stores price_cents,
-- the reduced price applied per item (clamped to the item's own price at
-- resolution time; the displayed percentage is derived per item).
CREATE TABLE IF NOT EXISTS pricing_discounts (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    scope        TEXT        NOT NULL CHECK (scope IN ('server', 'tier', 'item')),
    server_id    UUID        NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    storage_type TEXT        CHECK (storage_type IN ('nvme', 'hdd')),
    item_id      UUID        REFERENCES storage_pricing_items (id) ON DELETE CASCADE,
    mode         TEXT        NOT NULL CHECK (mode IN ('percent', 'price')),
    percent_off  INTEGER     CHECK (percent_off >= 1 AND percent_off <= 100),
    price_cents  INTEGER     CHECK (price_cents >= 0),
    premium_only BOOLEAN     NOT NULL DEFAULT FALSE,
    expires_at   TIMESTAMPTZ,
    -- Notification group chosen at creation ('all' | 'server' | 'server_tier'),
    -- NULL when no emails were requested. Recorded for audit only.
    notify_group TEXT        CHECK (notify_group IN ('all', 'server', 'server_tier')),
    created_by   TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (scope <> 'tier' OR storage_type IS NOT NULL),
    CHECK (scope <> 'item' OR item_id IS NOT NULL),
    CHECK (mode <> 'percent' OR percent_off IS NOT NULL),
    CHECK (mode <> 'price'   OR price_cents IS NOT NULL)
);

-- One discount per exact target — CreatePricingDiscount deletes the previous
-- row for the same target in the same transaction before inserting.
CREATE UNIQUE INDEX IF NOT EXISTS pricing_discounts_server_uq
    ON pricing_discounts (server_id) WHERE scope = 'server';
CREATE UNIQUE INDEX IF NOT EXISTS pricing_discounts_tier_uq
    ON pricing_discounts (server_id, storage_type) WHERE scope = 'tier';
CREATE UNIQUE INDEX IF NOT EXISTS pricing_discounts_item_uq
    ON pricing_discounts (item_id) WHERE scope = 'item';

CREATE INDEX IF NOT EXISTS pricing_discounts_server_idx
    ON pricing_discounts (server_id);

-- ── Seed ──────────────────────────────────────────────────────────────────────
-- Populate each existing server tier (any server with at least one active
-- drive of that type) with the five legacy plans at their current hardcoded
-- prices, so the admin page starts from today's effective price list.
--
-- Guarded on the table being COMPLETELY empty: apply-migrations.sh re-runs
-- every file forever (no tracking table — see its header), and once an admin
-- has edited/removed rows this seed must never resurrect them. Servers added
-- after this migration first runs start with no items (the admin page seeds
-- or adds items explicitly); the billing API falls back to the legacy
-- hardcoded plans for servers without rows.
INSERT INTO storage_pricing_items (server_id, storage_type, bytes, price_cents, sort_order)
SELECT s.id, t.storage_type, t.bytes, t.price_cents, t.sort_order
FROM servers s
CROSS JOIN (VALUES
    ('nvme',   68719476736::bigint,  3000, 0),  -- 64 GB
    ('nvme',  137438953472::bigint,  5000, 1),  -- 128 GB
    ('nvme',  274877906944::bigint,  8000, 2),  -- 256 GB
    ('nvme',  549755813888::bigint, 15000, 3),  -- 512 GB
    ('nvme', 1099511627776::bigint, 25000, 4),  -- 1 TB
    ('hdd',    68719476736::bigint,  2000, 0),
    ('hdd',   137438953472::bigint,  3000, 1),
    ('hdd',   274877906944::bigint,  5000, 2),
    ('hdd',   549755813888::bigint,  8000, 3),
    ('hdd',  1099511627776::bigint, 12000, 4)
) AS t(storage_type, bytes, price_cents, sort_order)
WHERE EXISTS (
        SELECT 1 FROM drives d
        WHERE d.server_id = s.id
          AND d.drive_type = t.storage_type
          AND d.is_active = true
      )
  AND NOT EXISTS (SELECT 1 FROM storage_pricing_items)
ON CONFLICT (server_id, storage_type, bytes) DO NOTHING;
