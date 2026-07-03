package db

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const expansionInvoiceColumns = `
	id, request_id, invoice_number, line_items, total_cents, deposit_cents,
	disclosures, notes, include_review_link, review_token, status,
	paypal_order_id, paypal_capture_id, sent_at, accept_due_at, accepted_at, created_at`

func scanExpansionInvoice(row interface{ Scan(...any) error }) (*models.ExpansionInvoice, error) {
	var inv models.ExpansionInvoice
	var reviewToken, orderID, captureID sql.NullString
	var acceptedAt sql.NullTime
	var lineItems []byte
	err := row.Scan(
		&inv.ID, &inv.RequestID, &inv.InvoiceNumber, &lineItems, &inv.TotalCents, &inv.DepositCents,
		&inv.Disclosures, &inv.Notes, &inv.IncludeReviewLink, &reviewToken, &inv.Status,
		&orderID, &captureID, &inv.SentAt, &inv.AcceptDueAt, &acceptedAt, &inv.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	inv.LineItemsRaw = lineItems
	_ = json.Unmarshal(lineItems, &inv.LineItems)
	if reviewToken.Valid {
		s := reviewToken.String
		inv.ReviewToken = &s
	}
	if orderID.Valid {
		s := orderID.String
		inv.PayPalOrderID = &s
	}
	if captureID.Valid {
		s := captureID.String
		inv.PayPalCaptureID = &s
	}
	if acceptedAt.Valid {
		t := acceptedAt.Time
		inv.AcceptedAt = &t
	}
	return &inv, nil
}

// CreateExpansionInvoiceParams carries the admin-entered invoice fields.
type CreateExpansionInvoiceParams struct {
	RequestID         uuid.UUID
	LineItems         []models.InvoiceLineItem
	TotalCents        int64
	DepositCents      int64
	Disclosures       string
	Notes             string
	IncludeReviewLink bool
	AcceptDueAt       time.Time
}

// CreateExpansionInvoice inserts a new invoice for a custom expansion request,
// generating a sequential invoice number and (when the review link is
// included) a random review token. Any previously 'sent' invoice for the same
// request is cancelled first so only one invoice is ever pending.
func (q *Queries) CreateExpansionInvoice(ctx context.Context, p CreateExpansionInvoiceParams) (*models.ExpansionInvoice, error) {
	if _, err := q.db.ExecContext(ctx, `
		UPDATE expansion_invoices SET status = 'cancelled'
		WHERE request_id = $1 AND status = 'sent'
	`, p.RequestID); err != nil {
		return nil, fmt.Errorf("CreateExpansionInvoice supersede: %w", err)
	}

	var seq int64
	if err := q.db.QueryRowContext(ctx,
		`SELECT nextval('expansion_invoice_number_seq')`).Scan(&seq); err != nil {
		return nil, fmt.Errorf("CreateExpansionInvoice seq: %w", err)
	}
	invoiceNumber := fmt.Sprintf("INV-%s-%05d", time.Now().Format("2006"), seq)

	var reviewToken any
	if p.IncludeReviewLink {
		buf := make([]byte, 24)
		if _, err := rand.Read(buf); err != nil {
			return nil, fmt.Errorf("CreateExpansionInvoice token: %w", err)
		}
		reviewToken = hex.EncodeToString(buf)
	}

	items, err := json.Marshal(p.LineItems)
	if err != nil {
		return nil, fmt.Errorf("CreateExpansionInvoice marshal: %w", err)
	}

	row := q.db.QueryRowContext(ctx, `
		INSERT INTO expansion_invoices
			(request_id, invoice_number, line_items, total_cents, deposit_cents,
			 disclosures, notes, include_review_link, review_token, status, accept_due_at)
		VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,'sent',$10)
		RETURNING `+expansionInvoiceColumns+`
	`, p.RequestID, invoiceNumber, string(items), p.TotalCents, p.DepositCents,
		p.Disclosures, p.Notes, p.IncludeReviewLink, reviewToken, p.AcceptDueAt)
	return scanExpansionInvoice(row)
}

// GetExpansionInvoiceByToken loads a 'sent'/'accepted' invoice by its review
// token. Returns nil when not found.
func (q *Queries) GetExpansionInvoiceByToken(ctx context.Context, token string) (*models.ExpansionInvoice, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT `+expansionInvoiceColumns+`
		FROM expansion_invoices WHERE review_token = $1
	`, token)
	inv, err := scanExpansionInvoice(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetExpansionInvoiceByToken: %w", err)
	}
	return inv, nil
}

// GetLatestExpansionInvoice returns the most recent invoice for a request, or
// nil when the request has never been invoiced.
func (q *Queries) GetLatestExpansionInvoice(ctx context.Context, requestID uuid.UUID) (*models.ExpansionInvoice, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT `+expansionInvoiceColumns+`
		FROM expansion_invoices
		WHERE request_id = $1
		ORDER BY created_at DESC
		LIMIT 1
	`, requestID)
	inv, err := scanExpansionInvoice(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetLatestExpansionInvoice: %w", err)
	}
	return inv, nil
}

// AcceptExpansionInvoice flips a 'sent' invoice to 'accepted', recording the
// deposit PayPal order/capture when a deposit was collected. Returns false
// when the invoice was not in 'sent' state (idempotent duplicate).
func (q *Queries) AcceptExpansionInvoice(ctx context.Context, id uuid.UUID, paypalOrderID, paypalCaptureID *string) (bool, error) {
	var orderID, captureID any
	if paypalOrderID != nil {
		orderID = *paypalOrderID
	}
	if paypalCaptureID != nil {
		captureID = *paypalCaptureID
	}
	res, err := q.db.ExecContext(ctx, `
		UPDATE expansion_invoices
		SET status = 'accepted', accepted_at = NOW(),
		    paypal_order_id = COALESCE($2, paypal_order_id),
		    paypal_capture_id = COALESCE($3, paypal_capture_id)
		WHERE id = $1 AND status = 'sent'
	`, id, orderID, captureID)
	if err != nil {
		return false, fmt.Errorf("AcceptExpansionInvoice: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// SetExpansionInvoiceStatus moves an invoice into a terminal state
// ('expired' or 'cancelled').
func (q *Queries) SetExpansionInvoiceStatus(ctx context.Context, id uuid.UUID, status string) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE expansion_invoices SET status = $2 WHERE id = $1 AND status = 'sent'
	`, id, status)
	if err != nil {
		return fmt.Errorf("SetExpansionInvoiceStatus: %w", err)
	}
	return nil
}

// ListExpiredSentInvoices returns 'sent' invoices whose 14-business-day
// acceptance window has elapsed, together with their request IDs, so the
// expiry loop can expire both.
func (q *Queries) ListExpiredSentInvoices(ctx context.Context) ([]models.ExpansionInvoice, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+expansionInvoiceColumns+`
		FROM expansion_invoices
		WHERE status = 'sent' AND accept_due_at < NOW()
	`)
	if err != nil {
		return nil, fmt.Errorf("ListExpiredSentInvoices: %w", err)
	}
	defer rows.Close()

	var out []models.ExpansionInvoice
	for rows.Next() {
		inv, err := scanExpansionInvoice(rows)
		if err != nil {
			return nil, fmt.Errorf("ListExpiredSentInvoices scan: %w", err)
		}
		out = append(out, *inv)
	}
	return out, rows.Err()
}
