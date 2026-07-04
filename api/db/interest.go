package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const interestColumns = `
	id, name, email, desired_storage_gb, use_case, ip_address,
	plan_id, storage_type, full_price_cents, deposit_amount_cents, currency,
	payment_method, paypal_order_id, paypal_capture_id, denied_at, refund_id,
	created_at, provisioned_at, invitation_id`

func scanInterestSubmission(rows *sql.Rows) (*models.InterestSubmission, error) {
	var s models.InterestSubmission
	var provisionedAt, deniedAt sql.NullTime
	var invitationID uuid.NullUUID
	var paypalOrderID, paypalCaptureID, refundID sql.NullString
	err := rows.Scan(
		&s.ID, &s.Name, &s.Email, &s.DesiredStorageGB, &s.UseCase, &s.IPAddress,
		&s.PlanID, &s.StorageType, &s.FullPriceCents, &s.DepositAmountCents, &s.Currency,
		&s.PaymentMethod, &paypalOrderID, &paypalCaptureID, &deniedAt, &refundID,
		&s.CreatedAt, &provisionedAt, &invitationID,
	)
	if err != nil {
		return nil, err
	}
	if provisionedAt.Valid {
		s.ProvisionedAt = &provisionedAt.Time
	}
	if deniedAt.Valid {
		s.DeniedAt = &deniedAt.Time
	}
	if invitationID.Valid {
		s.InvitationID = &invitationID.UUID
	}
	if paypalOrderID.Valid {
		s.PayPalOrderID = &paypalOrderID.String
	}
	if paypalCaptureID.Valid {
		s.PayPalCaptureID = &paypalCaptureID.String
	}
	if refundID.Valid {
		s.RefundID = &refundID.String
	}
	return &s, nil
}

// CreateInterestSubmission inserts a new interest form submission. The plan
// pricing/deposit fields must already be resolved from the fixed plan table
// and the deposit already captured — no free-form storage amounts.
func (q *Queries) CreateInterestSubmission(ctx context.Context, s *models.InterestSubmission) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO interest_submissions (
			name, email, desired_storage_gb, use_case, ip_address,
			plan_id, storage_type, full_price_cents, deposit_amount_cents, currency,
			payment_method, paypal_order_id, paypal_capture_id
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
	`,
		s.Name, s.Email, s.DesiredStorageGB, s.UseCase, s.IPAddress,
		s.PlanID, s.StorageType, s.FullPriceCents, s.DepositAmountCents, s.Currency,
		s.PaymentMethod, s.PayPalOrderID, s.PayPalCaptureID,
	)
	if err != nil {
		return fmt.Errorf("CreateInterestSubmission: %w", err)
	}
	return nil
}

// DenyInterestSubmission marks a submission denied and records the PayPal
// refund ID for its deposit (if one was refunded).
func (q *Queries) DenyInterestSubmission(ctx context.Context, id uuid.UUID, refundID string) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE interest_submissions
		SET denied_at = NOW(), refund_id = NULLIF($2, '')
		WHERE id = $1
	`, id, refundID)
	if err != nil {
		return fmt.Errorf("DenyInterestSubmission %s: %w", id, err)
	}
	return nil
}

// ExistsInterestSubmissionByEmail returns true if any submission with the given
// email already exists (case-insensitive). Used to silently de-duplicate.
func (q *Queries) ExistsInterestSubmissionByEmail(ctx context.Context, email string) (bool, error) {
	var exists bool
	err := q.db.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM interest_submissions WHERE email = $1)`,
		strings.ToLower(email),
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("ExistsInterestSubmissionByEmail: %w", err)
	}
	return exists, nil
}

// CountInterestSubmissionsFromIP returns the total number of submissions ever
// received from the given IP address.
func (q *Queries) CountInterestSubmissionsFromIP(ctx context.Context, ip string) (int, error) {
	var n int
	err := q.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM interest_submissions WHERE ip_address = $1`,
		ip,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("CountInterestSubmissionsFromIP: %w", err)
	}
	return n, nil
}

// CountInterestSubmissionsToday returns the number of submissions created today
// (UTC calendar day).
func (q *Queries) CountInterestSubmissionsToday(ctx context.Context) (int, error) {
	var n int
	err := q.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM interest_submissions
		 WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("CountInterestSubmissionsToday: %w", err)
	}
	return n, nil
}

// ListInterestSubmissions returns a paginated list ordered by creation time descending.
func (q *Queries) ListInterestSubmissions(ctx context.Context, in PageInput) (*PageResult[models.InterestSubmission], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListInterestSubmissions: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, `
		SELECT`+interestColumns+`
		FROM interest_submissions
		ORDER BY created_at DESC
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListInterestSubmissions: %w", err)
	}
	defer rows.Close()

	items := []models.InterestSubmission{}
	for rows.Next() {
		s, err := scanInterestSubmission(rows)
		if err != nil {
			return nil, fmt.Errorf("ListInterestSubmissions scan: %w", err)
		}
		items = append(items, *s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListInterestSubmissions: %w", err)
	}
	return &PageResult[models.InterestSubmission]{
		Items:     items,
		NextToken: offsetNextToken(len(items), limit, offset),
	}, nil
}

// MarkInterestSubmissionProvisioned sets provisioned_at and links the invitation.
func (q *Queries) MarkInterestSubmissionProvisioned(ctx context.Context, id uuid.UUID, invitationID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE interest_submissions
		SET provisioned_at = NOW(), invitation_id = $2
		WHERE id = $1
	`, id, invitationID)
	if err != nil {
		return fmt.Errorf("MarkInterestSubmissionProvisioned %s: %w", id, err)
	}
	return nil
}

// GetInterestSubmissionByID returns a single submission by its UUID.
func (q *Queries) GetInterestSubmissionByID(ctx context.Context, id uuid.UUID) (*models.InterestSubmission, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT`+interestColumns+`
		FROM interest_submissions WHERE id = $1
	`, id)
	if err != nil {
		return nil, fmt.Errorf("GetInterestSubmissionByID: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, fmt.Errorf("GetInterestSubmissionByID %s: %w", id, sql.ErrNoRows)
	}
	s, err := scanInterestSubmission(rows)
	if err != nil {
		return nil, fmt.Errorf("GetInterestSubmissionByID scan: %w", err)
	}
	return s, nil
}

// GetInterestFormSettings returns the current form settings (single row).
// Creates the row with defaults if it does not exist.
func (q *Queries) GetInterestFormSettings(ctx context.Context) (*models.InterestFormSettings, error) {
	var s models.InterestFormSettings
	err := q.db.QueryRowContext(ctx,
		`SELECT daily_cap, updated_at FROM interest_form_settings WHERE id = 1`,
	).Scan(&s.DailyCap, &s.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("GetInterestFormSettings: %w", err)
	}
	return &s, nil
}

// UpdateInterestFormSettings replaces the daily cap in the settings row.
func (q *Queries) UpdateInterestFormSettings(ctx context.Context, dailyCap int) (*models.InterestFormSettings, error) {
	var s models.InterestFormSettings
	err := q.db.QueryRowContext(ctx, `
		UPDATE interest_form_settings
		SET daily_cap = $1, updated_at = NOW()
		WHERE id = 1
		RETURNING daily_cap, updated_at
	`, dailyCap).Scan(&s.DailyCap, &s.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("UpdateInterestFormSettings: %w", err)
	}
	return &s, nil
}

// CreateInterestDepositOrder persists a newly-created PayPal deposit order
// for a fixed plan/storage-type, before the visitor has submitted the rest of
// the interest form.
func (q *Queries) CreateInterestDepositOrder(ctx context.Context, o *models.InterestDepositOrder) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO interest_deposit_orders (
			order_id, plan_id, storage_type, full_price_cents, deposit_amount_cents,
			currency, payment_method, paypal_capture_id, captured_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, o.OrderID, o.PlanID, o.StorageType, o.FullPriceCents, o.DepositAmountCents,
		o.Currency, o.PaymentMethod, o.PayPalCaptureID, o.CapturedAt)
	if err != nil {
		return fmt.Errorf("CreateInterestDepositOrder: %w", err)
	}
	return nil
}

// GetInterestDepositOrder returns a deposit order by its PayPal order ID.
func (q *Queries) GetInterestDepositOrder(ctx context.Context, orderID string) (*models.InterestDepositOrder, error) {
	var o models.InterestDepositOrder
	var captureID sql.NullString
	var capturedAt, consumedAt sql.NullTime
	err := q.db.QueryRowContext(ctx, `
		SELECT order_id, plan_id, storage_type, full_price_cents, deposit_amount_cents,
		       currency, payment_method, paypal_capture_id, captured_at, consumed_at, created_at
		FROM interest_deposit_orders WHERE order_id = $1
	`, orderID).Scan(
		&o.OrderID, &o.PlanID, &o.StorageType, &o.FullPriceCents, &o.DepositAmountCents,
		&o.Currency, &o.PaymentMethod, &captureID, &capturedAt, &consumedAt, &o.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetInterestDepositOrder: %w", err)
	}
	if captureID.Valid {
		o.PayPalCaptureID = &captureID.String
	}
	if capturedAt.Valid {
		o.CapturedAt = &capturedAt.Time
	}
	if consumedAt.Valid {
		o.ConsumedAt = &consumedAt.Time
	}
	return &o, nil
}

// MarkInterestDepositOrderCaptured records the PayPal capture ID once the
// deposit order has been captured.
func (q *Queries) MarkInterestDepositOrderCaptured(ctx context.Context, orderID, captureID string) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE interest_deposit_orders
		SET paypal_capture_id = $2, captured_at = NOW()
		WHERE order_id = $1
	`, orderID, captureID)
	if err != nil {
		return fmt.Errorf("MarkInterestDepositOrderCaptured %s: %w", orderID, err)
	}
	return nil
}

// ConsumeInterestDepositOrder atomically marks a captured, not-yet-consumed
// deposit order as consumed, returning false if it was already consumed (or
// never captured) — preventing a single deposit from backing two submissions.
func (q *Queries) ConsumeInterestDepositOrder(ctx context.Context, orderID string) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE interest_deposit_orders
		SET consumed_at = NOW()
		WHERE order_id = $1 AND captured_at IS NOT NULL AND consumed_at IS NULL
	`, orderID)
	if err != nil {
		return false, fmt.Errorf("ConsumeInterestDepositOrder %s: %w", orderID, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("ConsumeInterestDepositOrder %s: %w", orderID, err)
	}
	return n == 1, nil
}

// ListAdminEmails returns the email addresses of all users with is_admin = true.
func (q *Queries) ListAdminEmails(ctx context.Context) ([]string, error) {
	rows, err := q.db.QueryContext(ctx,
		`SELECT email FROM users WHERE is_admin = true`,
	)
	if err != nil {
		return nil, fmt.Errorf("ListAdminEmails: %w", err)
	}
	defer rows.Close()

	var emails []string
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			return nil, fmt.Errorf("ListAdminEmails scan: %w", err)
		}
		emails = append(emails, email)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListAdminEmails: %w", err)
	}
	return emails, nil
}
