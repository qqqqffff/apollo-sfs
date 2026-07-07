package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// AdminOrder is one row on the admin Orders tab: a premium payment or a
// storage add-on purchase, normalised into a single shape.
type AdminOrder struct {
	ID       uuid.UUID `json:"id"`
	Type     string    `json:"type"` // "premium" | "storage"
	Username string    `json:"username"`
	Status   string    `json:"status"`
	// AmountCents is the captured payment amount.
	AmountCents   int64      `json:"amount_cents"`
	Currency      string     `json:"currency"`
	PaymentMethod string     `json:"payment_method"` // paypal | card | hosted_card | apple_pay | google_pay
	Reference     string     `json:"reference"`      // PayPal order ID
	InvoiceNumber string     `json:"invoice_number"`
	CreatedAt     time.Time  `json:"created_at"`
	CapturedAt    *time.Time `json:"captured_at"`
	RefundID      *string    `json:"refund_id"`
	RefundedAt    *time.Time `json:"refunded_at"`
	// PayPalCaptureID backs the refund action (never rendered).
	PayPalCaptureID *string `json:"-"`
	// Environment is which PayPal instance ("sandbox" | "live") this order was
	// created against, so refunds route to the matching client and the UI can
	// flag sandbox test orders as distinct from real revenue.
	Environment string `json:"environment"`

	// Storage order details (zero-valued for premium payments).
	PlanID      string `json:"plan_id,omitempty"`
	StorageType string `json:"storage_type,omitempty"`
	BytesAdded  int64  `json:"bytes_added,omitempty"`
	ServerName  string `json:"server_name,omitempty"`
}

// adminOrdersBase normalises payments and storage_orders into one relation.
// Invoice numbers are derived deterministically from the row (orders predate
// invoice numbering): ORD-<yymmdd>-<first 6 hex of id>.
const adminOrdersBase = `
	SELECT p.id, 'premium' AS order_type, p.username, p.status,
	       p.amount_cents::bigint AS amount_cents, p.currency, p.payment_method,
	       p.paypal_order_id AS reference,
	       'ORD-' || to_char(p.created_at, 'YYMMDD') || '-' || upper(left(replace(p.id::text,'-',''), 6)) AS invoice_number,
	       p.created_at, p.captured_at, p.refund_id, p.refunded_at, p.paypal_capture_id, p.environment,
	       '' AS plan_id, '' AS storage_type, 0::bigint AS bytes_added, '' AS server_name
	FROM payments p
	UNION ALL
	SELECT o.id, 'storage' AS order_type, o.username, o.status,
	       o.amount_cents::bigint, o.currency, o.payment_method,
	       o.paypal_order_id,
	       'ORD-' || to_char(o.created_at, 'YYMMDD') || '-' || upper(left(replace(o.id::text,'-',''), 6)),
	       o.created_at, o.captured_at, o.refund_id, o.refunded_at, o.paypal_capture_id, o.environment,
	       o.plan_id, o.storage_type, o.bytes_added, COALESCE(srv.name, '')
	FROM storage_orders o
	LEFT JOIN servers srv ON srv.id = o.server_id`

// ListAdminOrders returns a searched, sorted, offset-paginated page of
// combined orders plus the total row count.
// sort: "date" (newest first, default) or "amount" (largest first).
func (q *Queries) ListAdminOrders(ctx context.Context, search, sort string, limit, offset int) ([]AdminOrder, int, error) {
	limit = clampLimit(limit)
	if offset < 0 {
		offset = 0
	}

	where := ""
	args := []any{}
	if search != "" {
		args = append(args, "%"+search+"%")
		where = `WHERE ord.username ILIKE $1 OR ord.reference ILIKE $1
		         OR ord.invoice_number ILIKE $1 OR ord.status ILIKE $1
		         OR ord.payment_method ILIKE $1`
	}

	var total int
	countQuery := fmt.Sprintf(`SELECT COUNT(*) FROM (%s) ord %s`, adminOrdersBase, where)
	if err := q.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("ListAdminOrders count: %w", err)
	}

	orderBy := "ord.created_at DESC"
	if sort == "amount" {
		orderBy = "ord.amount_cents DESC, ord.created_at DESC"
	}

	args = append(args, limit, offset)
	query := fmt.Sprintf(`
		SELECT * FROM (%s) ord
		%s
		ORDER BY %s
		LIMIT $%d OFFSET $%d
	`, adminOrdersBase, where, orderBy, len(args)-1, len(args))

	rows, err := q.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("ListAdminOrders: %w", err)
	}
	defer rows.Close()

	var out []AdminOrder
	for rows.Next() {
		var o AdminOrder
		var capturedAt, refundedAt sql.NullTime
		var refundID, captureID sql.NullString
		if err := rows.Scan(
			&o.ID, &o.Type, &o.Username, &o.Status,
			&o.AmountCents, &o.Currency, &o.PaymentMethod,
			&o.Reference, &o.InvoiceNumber,
			&o.CreatedAt, &capturedAt, &refundID, &refundedAt, &captureID, &o.Environment,
			&o.PlanID, &o.StorageType, &o.BytesAdded, &o.ServerName,
		); err != nil {
			return nil, 0, fmt.Errorf("ListAdminOrders scan: %w", err)
		}
		if capturedAt.Valid {
			t := capturedAt.Time
			o.CapturedAt = &t
		}
		if refundedAt.Valid {
			t := refundedAt.Time
			o.RefundedAt = &t
		}
		if refundID.Valid {
			s := refundID.String
			o.RefundID = &s
		}
		if captureID.Valid {
			s := captureID.String
			o.PayPalCaptureID = &s
		}
		out = append(out, o)
	}
	return out, total, rows.Err()
}

// ListUserOrders returns the given user's combined orders (premium payments +
// storage purchases), newest first. Backs the user-facing orders page.
func (q *Queries) ListUserOrders(ctx context.Context, username string) ([]AdminOrder, error) {
	query := fmt.Sprintf(`
		SELECT * FROM (%s) ord
		WHERE ord.username = $1
		ORDER BY ord.created_at DESC
		LIMIT 100
	`, adminOrdersBase)
	rows, err := q.db.QueryContext(ctx, query, username)
	if err != nil {
		return nil, fmt.Errorf("ListUserOrders: %w", err)
	}
	defer rows.Close()

	var out []AdminOrder
	for rows.Next() {
		var o AdminOrder
		var capturedAt, refundedAt sql.NullTime
		var refundID, captureID sql.NullString
		if err := rows.Scan(
			&o.ID, &o.Type, &o.Username, &o.Status,
			&o.AmountCents, &o.Currency, &o.PaymentMethod,
			&o.Reference, &o.InvoiceNumber,
			&o.CreatedAt, &capturedAt, &refundID, &refundedAt, &captureID, &o.Environment,
			&o.PlanID, &o.StorageType, &o.BytesAdded, &o.ServerName,
		); err != nil {
			return nil, fmt.Errorf("ListUserOrders scan: %w", err)
		}
		if capturedAt.Valid {
			t := capturedAt.Time
			o.CapturedAt = &t
		}
		if refundedAt.Valid {
			t := refundedAt.Time
			o.RefundedAt = &t
		}
		if refundID.Valid {
			s := refundID.String
			o.RefundID = &s
		}
		if captureID.Valid {
			s := captureID.String
			o.PayPalCaptureID = &s
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// GetAdminOrder loads a single normalised order by type + id.
func (q *Queries) GetAdminOrder(ctx context.Context, orderType string, id uuid.UUID) (*AdminOrder, error) {
	query := fmt.Sprintf(`SELECT * FROM (%s) ord WHERE ord.order_type = $1 AND ord.id = $2`, adminOrdersBase)
	rows, err := q.db.QueryContext(ctx, query, orderType, id)
	if err != nil {
		return nil, fmt.Errorf("GetAdminOrder: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var o AdminOrder
	var capturedAt, refundedAt sql.NullTime
	var refundID, captureID sql.NullString
	if err := rows.Scan(
		&o.ID, &o.Type, &o.Username, &o.Status,
		&o.AmountCents, &o.Currency, &o.PaymentMethod,
		&o.Reference, &o.InvoiceNumber,
		&o.CreatedAt, &capturedAt, &refundID, &refundedAt, &captureID, &o.Environment,
		&o.PlanID, &o.StorageType, &o.BytesAdded, &o.ServerName,
	); err != nil {
		return nil, fmt.Errorf("GetAdminOrder scan: %w", err)
	}
	if capturedAt.Valid {
		t := capturedAt.Time
		o.CapturedAt = &t
	}
	if refundedAt.Valid {
		t := refundedAt.Time
		o.RefundedAt = &t
	}
	if refundID.Valid {
		s := refundID.String
		o.RefundID = &s
	}
	if captureID.Valid {
		s := captureID.String
		o.PayPalCaptureID = &s
	}
	return &o, nil
}

// MarkPaymentRefundedByID records a completed admin refund on a premium
// payment. Distinct from MarkPaymentRefunded (payments.go), which handles
// PayPal webhook refunds keyed by capture ID.
// Returns false when the payment was already refunded (idempotent duplicate).
func (q *Queries) MarkPaymentRefundedByID(ctx context.Context, id uuid.UUID, refundID string) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE payments
		SET status = 'refunded', refund_id = $2, refunded_at = NOW()
		WHERE id = $1 AND status = 'captured'
	`, id, refundID)
	if err != nil {
		return false, fmt.Errorf("MarkPaymentRefunded: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// MarkStorageOrderRefunded records a completed refund on a storage order.
// Returns false when the order was already refunded (idempotent duplicate).
func (q *Queries) MarkStorageOrderRefunded(ctx context.Context, id uuid.UUID, refundID string) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE storage_orders
		SET status = 'refunded', refund_id = $2, refunded_at = NOW()
		WHERE id = $1 AND status = 'captured'
	`, id, refundID)
	if err != nil {
		return false, fmt.Errorf("MarkStorageOrderRefunded: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// RevokePremium clears the premium flag after a premium payment refund.
func (q *Queries) RevokePremium(ctx context.Context, username string) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE users SET is_premium = FALSE, premium_granted_at = NULL
		WHERE username = $1
	`, username)
	if err != nil {
		return fmt.Errorf("RevokePremium: %w", err)
	}
	return nil
}
