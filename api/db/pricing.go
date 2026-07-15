package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/lib/pq"

	"apollo-sfs.com/api/models"
)

// ── Pricing line items ────────────────────────────────────────────────────────

const pricingItemColumns = `
	id, server_id, storage_type, bytes, price_cents, sort_order, created_at, updated_at
`

func scanPricingItem(row interface{ Scan(...any) error }) (*models.PricingItem, error) {
	var it models.PricingItem
	if err := row.Scan(&it.ID, &it.ServerID, &it.StorageType, &it.Bytes,
		&it.PriceCents, &it.SortOrder, &it.CreatedAt, &it.UpdatedAt); err != nil {
		return nil, err
	}
	return &it, nil
}

// ListPricingItems returns every line item on a server, both tiers, in the
// admin-defined display order.
func (q *Queries) ListPricingItems(ctx context.Context, serverID uuid.UUID) ([]models.PricingItem, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT`+pricingItemColumns+`
		FROM storage_pricing_items
		WHERE server_id = $1
		ORDER BY storage_type, sort_order, bytes
	`, serverID)
	if err != nil {
		return nil, fmt.Errorf("ListPricingItems: %w", err)
	}
	defer rows.Close()

	var items []models.PricingItem
	for rows.Next() {
		it, err := scanPricingItem(rows)
		if err != nil {
			return nil, fmt.Errorf("ListPricingItems: %w", err)
		}
		items = append(items, *it)
	}
	return items, rows.Err()
}

// GetPricingItem fetches one line item, or nil when it doesn't exist.
func (q *Queries) GetPricingItem(ctx context.Context, id uuid.UUID) (*models.PricingItem, error) {
	it, err := scanPricingItem(q.db.QueryRowContext(ctx, `
		SELECT`+pricingItemColumns+`
		FROM storage_pricing_items WHERE id = $1
	`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetPricingItem: %w", err)
	}
	return it, nil
}

// CreatePricingItemParams are the admin-supplied fields of a new line item.
type CreatePricingItemParams struct {
	ServerID    uuid.UUID
	StorageType string
	Bytes       int64
	PriceCents  int
	SortOrder   int
}

// ErrDuplicatePricingItem is returned when a line item with the same
// quantity already exists on the server tier.
var ErrDuplicatePricingItem = fmt.Errorf("a line item with this quantity already exists on this server tier")

func mapPricingItemErr(op string, err error) error {
	var pqErr *pq.Error
	if errors.As(err, &pqErr) && pqErr.Code == "23505" {
		return ErrDuplicatePricingItem
	}
	return fmt.Errorf("%s: %w", op, err)
}

// CreatePricingItem inserts a new line item and returns it.
func (q *Queries) CreatePricingItem(ctx context.Context, p CreatePricingItemParams) (*models.PricingItem, error) {
	it, err := scanPricingItem(q.db.QueryRowContext(ctx, `
		INSERT INTO storage_pricing_items (server_id, storage_type, bytes, price_cents, sort_order)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING`+pricingItemColumns,
		p.ServerID, p.StorageType, p.Bytes, p.PriceCents, p.SortOrder))
	if err != nil {
		return nil, mapPricingItemErr("CreatePricingItem", err)
	}
	return it, nil
}

// UpdatePricingItem overwrites a line item's quantity, price, and display
// order. Returns nil when the item doesn't exist.
func (q *Queries) UpdatePricingItem(ctx context.Context, id uuid.UUID, bytes int64, priceCents, sortOrder int) (*models.PricingItem, error) {
	it, err := scanPricingItem(q.db.QueryRowContext(ctx, `
		UPDATE storage_pricing_items
		SET bytes = $2, price_cents = $3, sort_order = $4, updated_at = NOW()
		WHERE id = $1
		RETURNING`+pricingItemColumns,
		id, bytes, priceCents, sortOrder))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, mapPricingItemErr("UpdatePricingItem", err)
	}
	return it, nil
}

// DeletePricingItem removes a line item (its item-scope discount cascades).
func (q *Queries) DeletePricingItem(ctx context.Context, id uuid.UUID) error {
	if _, err := q.db.ExecContext(ctx,
		`DELETE FROM storage_pricing_items WHERE id = $1`, id); err != nil {
		return fmt.Errorf("DeletePricingItem: %w", err)
	}
	return nil
}

// ── Discounts ─────────────────────────────────────────────────────────────────

const pricingDiscountColumns = `
	id, scope, server_id, storage_type, item_id, mode, percent_off, price_cents,
	premium_only, expires_at, notify_group, created_by, created_at
`

func scanPricingDiscount(row interface{ Scan(...any) error }) (*models.PricingDiscount, error) {
	var d models.PricingDiscount
	if err := row.Scan(&d.ID, &d.Scope, &d.ServerID, &d.StorageType, &d.ItemID,
		&d.Mode, &d.PercentOff, &d.PriceCents, &d.PremiumOnly, &d.ExpiresAt,
		&d.NotifyGroup, &d.CreatedBy, &d.CreatedAt); err != nil {
		return nil, err
	}
	return &d, nil
}

// ListActivePricingDiscounts returns the unexpired discounts targeting a
// server (all three scopes). Feeds effective-price resolution.
func (q *Queries) ListActivePricingDiscounts(ctx context.Context, serverID uuid.UUID) ([]models.PricingDiscount, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT`+pricingDiscountColumns+`
		FROM pricing_discounts
		WHERE server_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
		ORDER BY created_at
	`, serverID)
	if err != nil {
		return nil, fmt.Errorf("ListActivePricingDiscounts: %w", err)
	}
	defer rows.Close()

	var ds []models.PricingDiscount
	for rows.Next() {
		d, err := scanPricingDiscount(rows)
		if err != nil {
			return nil, fmt.Errorf("ListActivePricingDiscounts: %w", err)
		}
		ds = append(ds, *d)
	}
	return ds, rows.Err()
}

// CreatePricingDiscount inserts d (ID/CreatedAt are populated on return),
// atomically replacing any existing discount on the same exact target —
// one discount per target, enforced by partial unique indexes.
func (q *Queries) CreatePricingDiscount(ctx context.Context, d *models.PricingDiscount) error {
	tx, err := q.pool.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("CreatePricingDiscount: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	switch d.Scope {
	case models.DiscountScopeServer:
		_, err = tx.ExecContext(ctx,
			`DELETE FROM pricing_discounts WHERE scope = 'server' AND server_id = $1`, d.ServerID)
	case models.DiscountScopeTier:
		_, err = tx.ExecContext(ctx,
			`DELETE FROM pricing_discounts WHERE scope = 'tier' AND server_id = $1 AND storage_type = $2`,
			d.ServerID, d.StorageType)
	case models.DiscountScopeItem:
		_, err = tx.ExecContext(ctx,
			`DELETE FROM pricing_discounts WHERE scope = 'item' AND item_id = $1`, d.ItemID)
	default:
		return fmt.Errorf("CreatePricingDiscount: unknown scope %q", d.Scope)
	}
	if err != nil {
		return fmt.Errorf("CreatePricingDiscount: replace: %w", err)
	}

	if err := tx.QueryRowContext(ctx, `
		INSERT INTO pricing_discounts
			(scope, server_id, storage_type, item_id, mode, percent_off, price_cents,
			 premium_only, expires_at, notify_group, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id, created_at
	`, d.Scope, d.ServerID, d.StorageType, d.ItemID, d.Mode, d.PercentOff,
		d.PriceCents, d.PremiumOnly, d.ExpiresAt, d.NotifyGroup, d.CreatedBy,
	).Scan(&d.ID, &d.CreatedAt); err != nil {
		return fmt.Errorf("CreatePricingDiscount: insert: %w", err)
	}
	return tx.Commit()
}

// DeletePricingDiscount removes a discount by id.
func (q *Queries) DeletePricingDiscount(ctx context.Context, id uuid.UUID) error {
	if _, err := q.db.ExecContext(ctx,
		`DELETE FROM pricing_discounts WHERE id = $1`, id); err != nil {
		return fmt.Errorf("DeletePricingDiscount: %w", err)
	}
	return nil
}

// ── Pricing servers (admin picker) ───────────────────────────────────────────

// PricingServer is a row of the admin pricing page's server picker: the
// server plus which storage tiers it physically offers (active drives).
type PricingServer struct {
	ID       uuid.UUID `json:"id"`
	Name     string    `json:"name"`
	IsActive bool      `json:"is_active"`
	Tiers    []string  `json:"tiers"`
}

// ListPricingServers returns every server (active first, then by name) with
// its distinct active drive types.
func (q *Queries) ListPricingServers(ctx context.Context) ([]PricingServer, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT s.id, s.name, s.is_active,
		       COALESCE(ARRAY_AGG(DISTINCT d.drive_type) FILTER (WHERE d.drive_type IS NOT NULL), '{}')
		FROM servers s
		LEFT JOIN drives d ON d.server_id = s.id AND d.is_active = true
		GROUP BY s.id, s.name, s.is_active
		ORDER BY s.is_active DESC, s.name
	`)
	if err != nil {
		return nil, fmt.Errorf("ListPricingServers: %w", err)
	}
	defer rows.Close()

	var out []PricingServer
	for rows.Next() {
		var s PricingServer
		if err := rows.Scan(&s.ID, &s.Name, &s.IsActive, pq.Array(&s.Tiers)); err != nil {
			return nil, fmt.Errorf("ListPricingServers: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ── Discount notification recipients ─────────────────────────────────────────

// Notification groups selectable when creating a discount. Containment is
// all ⊃ server ⊃ server_tier; the admin UI enforces that picking a broader
// group absorbs the narrower ones, so exactly one group value arrives here.
const (
	NotifyGroupAll        = "all"
	NotifyGroupServer     = "server"
	NotifyGroupServerTier = "server_tier"
)

// ListDiscountRecipients returns the distinct, non-empty email addresses of
// the users in the given notification group. serverID scopes the "server"
// and "server_tier" groups (membership = having a drive allocation on that
// server); storageType additionally scopes "server_tier". premiumOnly
// restricts any group to premium users and admins — mirroring who a
// premium-gated discount actually applies to.
func (q *Queries) ListDiscountRecipients(ctx context.Context, group string, serverID uuid.UUID, storageType string, premiumOnly bool) ([]string, error) {
	var (
		query string
		args  []any
	)
	premiumClause := ""
	if premiumOnly {
		premiumClause = " AND (u.is_premium = true OR u.is_admin = true)"
	}
	switch group {
	case NotifyGroupAll:
		query = `SELECT u.email FROM users u WHERE u.email <> ''` + premiumClause
	case NotifyGroupServer:
		query = `
			SELECT DISTINCT u.email FROM users u
			JOIN user_drive_allocations uda ON uda.user_id = u.username
			JOIN drives d ON d.id = uda.drive_id
			WHERE d.server_id = $1 AND u.email <> ''` + premiumClause
		args = append(args, serverID)
	case NotifyGroupServerTier:
		query = `
			SELECT DISTINCT u.email FROM users u
			JOIN user_drive_allocations uda ON uda.user_id = u.username
			JOIN drives d ON d.id = uda.drive_id
			WHERE d.server_id = $1 AND d.drive_type = $2 AND u.email <> ''` + premiumClause
		args = append(args, serverID, storageType)
	default:
		return nil, fmt.Errorf("ListDiscountRecipients: unknown group %q", group)
	}

	rows, err := q.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("ListDiscountRecipients: %w", err)
	}
	defer rows.Close()

	var emails []string
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return nil, fmt.Errorf("ListDiscountRecipients: %w", err)
		}
		emails = append(emails, e)
	}
	return emails, rows.Err()
}
