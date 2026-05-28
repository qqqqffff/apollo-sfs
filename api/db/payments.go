package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const paymentColumns = `id, username, paypal_order_id, paypal_capture_id,
	amount_cents, currency, status, payment_method, created_at, captured_at`

// CreatePendingPayment inserts a "created" payment row immediately after
// PayPal returns an order_id. The capture_id and captured_at are populated
// later by MarkPaymentCaptured. Bypasses RLS — payments live outside the
// per-user namespace and are reconciled by username FK.
func (q *Queries) CreatePendingPayment(ctx context.Context, p *models.Payment) error {
	err := q.db.QueryRowContext(ctx, `
		INSERT INTO payments (username, paypal_order_id, amount_cents,
		                      currency, status, payment_method)
		VALUES ($1, $2, $3, $4, 'created', $5)
		RETURNING id, created_at
	`, p.Username, p.PayPalOrderID, p.AmountCents, p.Currency, p.PaymentMethod,
	).Scan(&p.ID, &p.CreatedAt)
	if err != nil {
		return fmt.Errorf("CreatePendingPayment: %w", err)
	}
	p.Status = "created"
	return nil
}

// GetPaymentByOrderID loads a payment by its PayPal order_id.
// Returns sql.ErrNoRows if no such order exists.
func (q *Queries) GetPaymentByOrderID(ctx context.Context, orderID string) (*models.Payment, error) {
	return scanPayment(q.db.QueryRowContext(ctx, `
		SELECT `+paymentColumns+`
		FROM payments WHERE paypal_order_id = $1
	`, orderID))
}

// GetPaymentByCaptureID loads a payment by its PayPal capture_id (set after
// a successful capture). Used by the idempotent ApplyCapture flow.
func (q *Queries) GetPaymentByCaptureID(ctx context.Context, captureID string) (*models.Payment, error) {
	return scanPayment(q.db.QueryRowContext(ctx, `
		SELECT `+paymentColumns+`
		FROM payments WHERE paypal_capture_id = $1
	`, captureID))
}

// MarkPaymentCaptured records a successful PayPal capture. Uses an INSERT ...
// ON CONFLICT (paypal_capture_id) DO NOTHING via the underlying UNIQUE so
// concurrent webhook + sync-capture races resolve to one flip. Returns true
// if this call actually transitioned the row (i.e. caller should apply tier
// upgrade); false if a prior call already captured.
func (q *Queries) MarkPaymentCaptured(ctx context.Context, orderID, captureID string, raw []byte) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE payments
		SET paypal_capture_id = $2,
		    status            = 'captured',
		    captured_at       = NOW(),
		    raw_webhook       = COALESCE($3::jsonb, raw_webhook)
		WHERE paypal_order_id   = $1
		  AND paypal_capture_id IS NULL
	`, orderID, captureID, rawWebhookOrNil(raw))
	if err != nil {
		// 23505 = unique_violation on paypal_capture_id => already captured.
		return false, fmt.Errorf("MarkPaymentCaptured: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// MarkPaymentRefunded records a refund / dispute. Caller is responsible for
// any downstream user-state cleanup (premium flag, API key revocation).
func (q *Queries) MarkPaymentRefunded(ctx context.Context, captureID string, raw []byte) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE payments
		SET status = 'refunded',
		    raw_webhook = COALESCE($2::jsonb, raw_webhook)
		WHERE paypal_capture_id = $1
	`, captureID, rawWebhookOrNil(raw))
	if err != nil {
		return fmt.Errorf("MarkPaymentRefunded: %w", err)
	}
	return nil
}

// ListPaymentsForUser returns all of the given user's payments most-recent
// first. Used for profile / billing history surfaces.
func (q *Queries) ListPaymentsForUser(ctx context.Context, username string) ([]models.Payment, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+paymentColumns+`
		FROM payments WHERE username = $1
		ORDER BY created_at DESC
	`, username)
	if err != nil {
		return nil, fmt.Errorf("ListPaymentsForUser: %w", err)
	}
	defer rows.Close()
	var out []models.Payment
	for rows.Next() {
		var p models.Payment
		var captureID sql.NullString
		var capturedAt sql.NullTime
		if err := rows.Scan(
			&p.ID, &p.Username, &p.PayPalOrderID, &captureID,
			&p.AmountCents, &p.Currency, &p.Status, &p.PaymentMethod,
			&p.CreatedAt, &capturedAt,
		); err != nil {
			return nil, fmt.Errorf("ListPaymentsForUser scan: %w", err)
		}
		if captureID.Valid {
			s := captureID.String
			p.PayPalCaptureID = &s
		}
		if capturedAt.Valid {
			p.CapturedAt = &capturedAt.Time
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func scanPayment(row *sql.Row) (*models.Payment, error) {
	var p models.Payment
	var captureID sql.NullString
	var capturedAt sql.NullTime
	if err := row.Scan(
		&p.ID, &p.Username, &p.PayPalOrderID, &captureID,
		&p.AmountCents, &p.Currency, &p.Status, &p.PaymentMethod,
		&p.CreatedAt, &capturedAt,
	); err != nil {
		return nil, err
	}
	if captureID.Valid {
		s := captureID.String
		p.PayPalCaptureID = &s
	}
	if capturedAt.Valid {
		p.CapturedAt = &capturedAt.Time
	}
	return &p, nil
}

func rawWebhookOrNil(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	return json.RawMessage(raw)
}

// Compile-time anti-unused checks for the otherwise-only-from-other-pkg refs.
var (
	_ = uuid.UUID{}
	_ = time.Time{}
)
