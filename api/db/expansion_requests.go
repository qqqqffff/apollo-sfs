package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const expansionRequestColumns = `
	ser.id, ser.username, ser.server_id, ser.plan_id, ser.storage_type,
	ser.bytes_requested, ser.deposit_amount_cents, ser.full_price_cents,
	ser.currency, ser.payment_method, ser.paypal_order_id, ser.paypal_capture_id,
	ser.status, ser.is_custom, ser.pre_quota_bytes, ser.post_quota_bytes,
	ser.expires_at, ser.approval_due_at, ser.approved_at, ser.expansion_due_at,
	ser.created_at, ser.completed_at,
	ser.refund_id, ser.cancellation_reason, ser.payment_due_at, ser.reminder_sent_at,
	ser.reminders_sent, ser.environment,
	s.name AS server_name, s.state AS server_state,
	u.email AS user_email`

func scanExpansionRequest(rows interface {
	Scan(...any) error
}) (*models.ServerExpansionRequest, error) {
	var r models.ServerExpansionRequest
	var captureID, refundID, reason sql.NullString
	var postQuota sql.NullInt64
	var completedAt, paymentDueAt, approvalDueAt, approvedAt, expansionDueAt, reminderSentAt sql.NullTime
	err := rows.Scan(
		&r.ID, &r.Username, &r.ServerID, &r.PlanID, &r.StorageType,
		&r.BytesRequested, &r.DepositAmountCents, &r.FullPriceCents,
		&r.Currency, &r.PaymentMethod, &r.PayPalOrderID, &captureID,
		&r.Status, &r.IsCustom, &r.PreQuotaBytes, &postQuota,
		&r.ExpiresAt, &approvalDueAt, &approvedAt, &expansionDueAt,
		&r.CreatedAt, &completedAt,
		&refundID, &reason, &paymentDueAt, &reminderSentAt, &r.RemindersSent, &r.Environment,
		&r.ServerName, &r.ServerState, &r.UserEmail,
	)
	if err != nil {
		return nil, err
	}
	if reminderSentAt.Valid {
		t := reminderSentAt.Time
		r.ReminderSentAt = &t
	}
	if approvalDueAt.Valid {
		t := approvalDueAt.Time
		r.ApprovalDueAt = &t
	}
	if approvedAt.Valid {
		t := approvedAt.Time
		r.ApprovedAt = &t
	}
	if expansionDueAt.Valid {
		t := expansionDueAt.Time
		r.ExpansionDueAt = &t
	}
	if captureID.Valid {
		s := captureID.String
		r.PayPalCaptureID = &s
	}
	if postQuota.Valid {
		v := postQuota.Int64
		r.PostQuotaBytes = &v
	}
	if completedAt.Valid {
		t := completedAt.Time
		r.CompletedAt = &t
	}
	if refundID.Valid {
		s := refundID.String
		r.RefundID = &s
	}
	if reason.Valid {
		s := reason.String
		r.CancellationReason = &s
	}
	if paymentDueAt.Valid {
		t := paymentDueAt.Time
		r.PaymentDueAt = &t
	}
	return &r, nil
}

// CreateExpansionRequestParams carries the fields required to insert a new
// expansion request row. PayPalCaptureID is nil for wallet orders (set later
// on capture) and non-nil for direct charges.
type CreateExpansionRequestParams struct {
	Username           string
	ServerID           uuid.UUID
	PlanID             string
	StorageType        string
	BytesRequested     int64
	DepositAmountCents int
	FullPriceCents     int
	Currency           string
	PaymentMethod      string
	PayPalOrderID      string
	PayPalCaptureID    *string
	Status             string // "opened"
	IsCustom           bool
	PreQuotaBytes      int64
	// ExpiresAt is the approval deadline (also stored in approval_due_at).
	ExpiresAt time.Time
	// Environment is which PayPal instance ("sandbox" | "live") this request's
	// orders are created against — set from the admin sandbox-payments toggle.
	// Defaults to "live" when empty.
	Environment string
}

// CreateExpansionRequest inserts a new server expansion request.
func (q *Queries) CreateExpansionRequest(ctx context.Context, p CreateExpansionRequestParams) (*models.ServerExpansionRequest, error) {
	var captureID any
	if p.PayPalCaptureID != nil {
		captureID = *p.PayPalCaptureID
	}
	env := p.Environment
	if env == "" {
		env = "live"
	}
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO server_expansion_requests
			(username, server_id, plan_id, storage_type, bytes_requested,
			 deposit_amount_cents, full_price_cents, currency, payment_method,
			 paypal_order_id, paypal_capture_id, status, is_custom,
			 pre_quota_bytes, expires_at, approval_due_at, environment)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16)
		RETURNING id, created_at
	`,
		p.Username, p.ServerID, p.PlanID, p.StorageType, p.BytesRequested,
		p.DepositAmountCents, p.FullPriceCents, p.Currency, p.PaymentMethod,
		p.PayPalOrderID, captureID, p.Status, p.IsCustom, p.PreQuotaBytes, p.ExpiresAt, env,
	)
	var id uuid.UUID
	var createdAt time.Time
	if err := row.Scan(&id, &createdAt); err != nil {
		return nil, fmt.Errorf("CreateExpansionRequest: %w", err)
	}
	return q.GetExpansionRequestByID(ctx, id)
}

// GetExpansionRequestByID fetches a single expansion request with server + user info.
func (q *Queries) GetExpansionRequestByID(ctx context.Context, id uuid.UUID) (*models.ServerExpansionRequest, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT `+expansionRequestColumns+`
		FROM server_expansion_requests ser
		JOIN servers s ON s.id = ser.server_id
		JOIN users   u ON u.username = ser.username
		WHERE ser.id = $1
	`, id)
	r, err := scanExpansionRequest(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetExpansionRequestByID: %w", err)
	}
	return r, nil
}

// CountActiveExpansionRequests returns how many in-flight expansion requests the
// user has — those still awaiting user payment or admin fulfilment: 'opened'
// (deposit paid, awaiting capacity) and 'expanded' (capacity added, awaiting the
// remaining balance). Terminal states (completed/refunded/expired) are excluded.
// Backs the admin quick-link to the requests page.
func (q *Queries) CountActiveExpansionRequests(ctx context.Context, username string) (int, error) {
	var n int
	err := q.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM server_expansion_requests
		WHERE username = $1 AND status IN ('opened', 'approved', 'expanded')
	`, username).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("CountActiveExpansionRequests: %w", err)
	}
	return n, nil
}

// GetExpansionRequestByPayPalOrderID loads a request by its PayPal order ID.
func (q *Queries) GetExpansionRequestByPayPalOrderID(ctx context.Context, orderID string) (*models.ServerExpansionRequest, error) {
	row := q.db.QueryRowContext(ctx, `
		SELECT `+expansionRequestColumns+`
		FROM server_expansion_requests ser
		JOIN servers s ON s.id = ser.server_id
		JOIN users   u ON u.username = ser.username
		WHERE ser.paypal_order_id = $1
	`, orderID)
	r, err := scanExpansionRequest(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetExpansionRequestByPayPalOrderID: %w", err)
	}
	return r, nil
}

// MarkExpansionRequestCaptured sets paypal_capture_id and flips status to
// 'opened'. Returns true if this call made the change (idempotent on repeat).
func (q *Queries) MarkExpansionRequestCaptured(ctx context.Context, orderID, captureID string) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET paypal_capture_id = $2, status = 'opened'
		WHERE paypal_order_id   = $1
		  AND paypal_capture_id IS NULL
	`, orderID, captureID)
	if err != nil {
		return false, fmt.Errorf("MarkExpansionRequestCaptured: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ExpansionRequestFilter carries optional filters for ListExpansionRequests.
type ExpansionRequestFilter struct {
	Status   string    // "" = all
	ServerID uuid.UUID // zero = all
	From     time.Time // zero = unbounded
	To       time.Time // zero = unbounded
	IsCustom *bool     // nil = all; true = custom requests only; false = standard
	Search   string    // matches username, user email, server name, plan id, invoice number
	// Sort: "sla" (nearest active deadline first), "deposit" (largest deposit
	// first) or "" / "created" (newest first).
	Sort string
}

// ListExpansionRequests returns a filtered, searched, offset-paginated page of
// expansion requests plus the total row count for the filter. Each row carries
// its latest invoice summary (custom requests).
func (q *Queries) ListExpansionRequests(ctx context.Context, f ExpansionRequestFilter, limit, offset int) ([]models.ServerExpansionRequest, int, error) {
	limit = clampLimit(limit)
	if offset < 0 {
		offset = 0
	}

	args := []any{}
	where := "WHERE 1=1"
	add := func(cond string, v any) {
		args = append(args, v)
		where += fmt.Sprintf(" AND %s $%d", cond, len(args))
	}

	if f.Status != "" {
		add("ser.status =", f.Status)
	}
	if f.ServerID != (uuid.UUID{}) {
		add("ser.server_id =", f.ServerID)
	}
	if !f.From.IsZero() {
		add("ser.created_at >=", f.From)
	}
	if !f.To.IsZero() {
		add("ser.created_at <=", f.To)
	}
	if f.IsCustom != nil {
		add("ser.is_custom =", *f.IsCustom)
	}
	if f.Search != "" {
		args = append(args, "%"+f.Search+"%")
		n := len(args)
		where += fmt.Sprintf(` AND (ser.username ILIKE $%d OR u.email ILIKE $%d
			OR s.name ILIKE $%d OR ser.plan_id ILIKE $%d
			OR COALESCE(inv.invoice_number, '') ILIKE $%d)`, n, n, n, n, n)
	}

	// invJoin exposes the latest invoice per request for the custom tab.
	const invJoin = `
		LEFT JOIN LATERAL (
			SELECT ei.invoice_number, ei.status AS invoice_status,
			       ei.sent_at AS invoice_sent_at, ei.accept_due_at AS invoice_accept_due_at
			FROM expansion_invoices ei
			WHERE ei.request_id = ser.id
			ORDER BY ei.created_at DESC
			LIMIT 1
		) inv ON TRUE`

	var total int
	countQuery := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM server_expansion_requests ser
		JOIN servers s ON s.id = ser.server_id
		JOIN users   u ON u.username = ser.username
		%s
		%s
	`, invJoin, where)
	if err := q.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("ListExpansionRequests count: %w", err)
	}

	orderBy := "ser.created_at DESC"
	switch f.Sort {
	case "sla":
		// Nearest active deadline first: the deadline that currently applies
		// to the request's stage. Terminal states sort last.
		orderBy = `
			CASE WHEN ser.status IN ('completed','expired','refunded','rejected') THEN 1 ELSE 0 END ASC,
			COALESCE(
				CASE ser.status
					WHEN 'expanded'     THEN ser.payment_due_at + INTERVAL '30 days'
					WHEN 'approved'     THEN ser.expansion_due_at
					WHEN 'invoice_sent' THEN inv.invoice_accept_due_at
					ELSE COALESCE(ser.approval_due_at, ser.expires_at)
				END,
				ser.expires_at
			) ASC`
	case "deposit":
		orderBy = "ser.deposit_amount_cents DESC, ser.created_at DESC"
	}

	args = append(args, limit, offset)
	query := fmt.Sprintf(`
		SELECT %s,
		       inv.invoice_number, inv.invoice_status, inv.invoice_sent_at, inv.invoice_accept_due_at
		FROM server_expansion_requests ser
		JOIN servers s ON s.id = ser.server_id
		JOIN users   u ON u.username = ser.username
		%s
		%s
		ORDER BY %s
		LIMIT $%d OFFSET $%d
	`, expansionRequestColumns, invJoin, where, orderBy, len(args)-1, len(args))

	rows, err := q.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("ListExpansionRequests: %w", err)
	}
	defer rows.Close()

	var items []models.ServerExpansionRequest
	for rows.Next() {
		r, err := scanExpansionRequestWithInvoice(rows)
		if err != nil {
			return nil, 0, fmt.Errorf("ListExpansionRequests scan: %w", err)
		}
		items = append(items, *r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("ListExpansionRequests rows: %w", err)
	}
	return items, total, nil
}

// scanExpansionRequestWithInvoice scans a row produced by the admin listing
// query, which appends the latest-invoice summary columns.
func scanExpansionRequestWithInvoice(rows *sql.Rows) (*models.ServerExpansionRequest, error) {
	var r models.ServerExpansionRequest
	var captureID, refundID, reason sql.NullString
	var postQuota sql.NullInt64
	var completedAt, paymentDueAt, approvalDueAt, approvedAt, expansionDueAt, reminderSentAt sql.NullTime
	var invNumber, invStatus sql.NullString
	var invSentAt, invAcceptDueAt sql.NullTime
	err := rows.Scan(
		&r.ID, &r.Username, &r.ServerID, &r.PlanID, &r.StorageType,
		&r.BytesRequested, &r.DepositAmountCents, &r.FullPriceCents,
		&r.Currency, &r.PaymentMethod, &r.PayPalOrderID, &captureID,
		&r.Status, &r.IsCustom, &r.PreQuotaBytes, &postQuota,
		&r.ExpiresAt, &approvalDueAt, &approvedAt, &expansionDueAt,
		&r.CreatedAt, &completedAt,
		&refundID, &reason, &paymentDueAt, &reminderSentAt, &r.RemindersSent, &r.Environment,
		&r.ServerName, &r.ServerState, &r.UserEmail,
		&invNumber, &invStatus, &invSentAt, &invAcceptDueAt,
	)
	if err != nil {
		return nil, err
	}
	setNullString := func(dst **string, v sql.NullString) {
		if v.Valid {
			s := v.String
			*dst = &s
		}
	}
	setNullTime := func(dst **time.Time, v sql.NullTime) {
		if v.Valid {
			t := v.Time
			*dst = &t
		}
	}
	setNullString(&r.PayPalCaptureID, captureID)
	setNullString(&r.RefundID, refundID)
	setNullString(&r.CancellationReason, reason)
	if postQuota.Valid {
		v := postQuota.Int64
		r.PostQuotaBytes = &v
	}
	setNullTime(&r.CompletedAt, completedAt)
	setNullTime(&r.PaymentDueAt, paymentDueAt)
	setNullTime(&r.ApprovalDueAt, approvalDueAt)
	setNullTime(&r.ApprovedAt, approvedAt)
	setNullTime(&r.ExpansionDueAt, expansionDueAt)
	setNullTime(&r.ReminderSentAt, reminderSentAt)
	setNullString(&r.InvoiceNumber, invNumber)
	setNullString(&r.InvoiceStatus, invStatus)
	setNullTime(&r.InvoiceSentAt, invSentAt)
	setNullTime(&r.InvoiceAcceptDueAt, invAcceptDueAt)
	return &r, nil
}

// CancelExpansionRequest sets status='refunded' and records the refund ID and
// reason. Returns false if the request was not in a cancellable state.
func (q *Queries) CancelExpansionRequest(ctx context.Context, id uuid.UUID, refundID, reason string) (bool, error) {
	now := time.Now()
	res, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'refunded', refund_id = $2, cancellation_reason = $3, completed_at = $4
		WHERE id = $1 AND status IN ('opened','accepted','approved','expanded')
	`, id, refundID, reason, now)
	if err != nil {
		return false, fmt.Errorf("CancelExpansionRequest: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ExpireExpansionRequest marks a single request as 'expired' with a refund ID.
// Covers missed-approval ('opened'/'accepted'), missed-invoice-acceptance
// ('invoice_sent') and missed-expansion ('approved') SLAs.
func (q *Queries) ExpireExpansionRequest(ctx context.Context, id uuid.UUID, refundID string) error {
	now := time.Now()
	var refund any
	if refundID != "" {
		refund = refundID
	}
	_, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'expired', refund_id = $2, completed_at = $3
		WHERE id = $1 AND status IN ('opened','accepted','invoice_sent','approved')
	`, id, refund, now)
	if err != nil {
		return fmt.Errorf("ExpireExpansionRequest: %w", err)
	}
	return nil
}

// ApproveExpansionRequest transitions an 'opened' (standard) or 'accepted'
// (custom, invoice approved) request to 'approved', stamping approved_at and
// the expansion deadline (14 business days out). Returns false if the request
// was not in an approvable state.
func (q *Queries) ApproveExpansionRequest(ctx context.Context, id uuid.UUID, expansionDueAt time.Time) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'approved', approved_at = NOW(), expansion_due_at = $2
		WHERE id = $1 AND status IN ('opened','accepted')
	`, id, expansionDueAt)
	if err != nil {
		return false, fmt.Errorf("ApproveExpansionRequest: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ProvisionExpansionRequest transitions an 'approved' request (or a legacy
// 'opened' one) to 'expanded' after the quota has been provisioned. The
// remaining balance is due from this moment (payment_due_at = NOW());
// post_quota_bytes records the user's quota after provisioning. Returns false
// if not in an eligible state.
func (q *Queries) ProvisionExpansionRequest(ctx context.Context, id uuid.UUID, postQuotaBytes int64) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'expanded', payment_due_at = NOW(), post_quota_bytes = $2
		WHERE id = $1 AND status IN ('opened','approved')
	`, id, postQuotaBytes)
	if err != nil {
		return false, fmt.Errorf("ProvisionExpansionRequest: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// MarkExpansionRequestPaid completes an 'expanded' request once the remaining
// balance has been collected. Returns false when not in 'expanded' state.
func (q *Queries) MarkExpansionRequestPaid(ctx context.Context, id uuid.UUID) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'completed', completed_at = NOW()
		WHERE id = $1 AND status = 'expanded'
	`, id)
	if err != nil {
		return false, fmt.Errorf("MarkExpansionRequestPaid: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// MarkExpansionInvoiceSent flips a custom 'opened' request to 'invoice_sent'.
func (q *Queries) MarkExpansionInvoiceSent(ctx context.Context, id uuid.UUID) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'invoice_sent'
		WHERE id = $1 AND status IN ('opened','invoice_sent')
	`, id)
	if err != nil {
		return false, fmt.Errorf("MarkExpansionInvoiceSent: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// AcceptExpansionRequestInvoice records the user's invoice acceptance on the
// request: final pricing from the invoice, the deposit payment references, a
// fresh approval deadline for the admin, and status 'accepted'.
func (q *Queries) AcceptExpansionRequestInvoice(
	ctx context.Context, id uuid.UUID,
	depositCents, fullCents int64,
	paypalOrderID string, paypalCaptureID *string,
	approvalDueAt time.Time,
) (bool, error) {
	var captureID any
	if paypalCaptureID != nil {
		captureID = *paypalCaptureID
	}
	res, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'accepted',
		    deposit_amount_cents = $2,
		    full_price_cents = $3,
		    paypal_order_id = $4,
		    paypal_capture_id = COALESCE($5, paypal_capture_id),
		    approval_due_at = $6,
		    expires_at = $6
		WHERE id = $1 AND status = 'invoice_sent'
	`, id, depositCents, fullCents, paypalOrderID, captureID, approvalDueAt)
	if err != nil {
		return false, fmt.Errorf("AcceptExpansionRequestInvoice: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// RejectExpansionRequest declines a request that has not collected any money
// yet ('opened' custom or 'invoice_sent'). No refund is involved.
func (q *Queries) RejectExpansionRequest(ctx context.Context, id uuid.UUID, reason string) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'rejected', cancellation_reason = $2, completed_at = NOW()
		WHERE id = $1 AND status IN ('opened','invoice_sent') AND paypal_capture_id IS NULL
	`, id, reason)
	if err != nil {
		return false, fmt.Errorf("RejectExpansionRequest: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// MarkExpansionReminderSent records that the n-th remaining-balance reminder
// went out (n is the new total count). Guarded so a stale caller cannot move
// the counter backwards.
func (q *Queries) MarkExpansionReminderSent(ctx context.Context, id uuid.UUID, n int) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET reminder_sent_at = NOW(), reminders_sent = $2
		WHERE id = $1 AND status = 'expanded' AND reminders_sent < $2
	`, id, n)
	if err != nil {
		return fmt.Errorf("MarkExpansionReminderSent: %w", err)
	}
	return nil
}

// ListUnpaidExpandedRequests returns 'expanded' requests still awaiting their
// remaining balance. The caller applies the business-day reminder / 30-day
// revert deadlines in Go.
func (q *Queries) ListUnpaidExpandedRequests(ctx context.Context) ([]models.ServerExpansionRequest, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+expansionRequestColumns+`
		FROM server_expansion_requests ser
		JOIN servers s ON s.id = ser.server_id
		JOIN users   u ON u.username = ser.username
		WHERE ser.status = 'expanded'
	`)
	if err != nil {
		return nil, fmt.Errorf("ListUnpaidExpandedRequests: %w", err)
	}
	defer rows.Close()

	var out []models.ServerExpansionRequest
	for rows.Next() {
		r, err := scanExpansionRequest(rows)
		if err != nil {
			return nil, fmt.Errorf("ListUnpaidExpandedRequests scan: %w", err)
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// RevertExpansionRequest expires an 'expanded' request whose remaining
// balance was never collected. The provisioned quota has already been
// subtracted by the caller; the deposit is kept (no refund).
func (q *Queries) RevertExpansionRequest(ctx context.Context, id uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'expired', completed_at = NOW()
		WHERE id = $1 AND status = 'expanded'
	`, id)
	if err != nil {
		return fmt.Errorf("RevertExpansionRequest: %w", err)
	}
	return nil
}

// CountFailedExpansionRequests counts a user's cancelled, rejected, refunded
// or non-paid requests. Users with 3 or more are blocked from opening new
// expansion or custom requests. SLA-missed expirations (which carry a refund
// the admin issued automatically) do not count against the user.
func (q *Queries) CountFailedExpansionRequests(ctx context.Context, username string) (int, error) {
	var n int
	err := q.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM server_expansion_requests
		WHERE username = $1
		  AND (status IN ('refunded','rejected')
		       OR (status = 'expired' AND refund_id IS NULL))
	`, username).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("CountFailedExpansionRequests: %w", err)
	}
	return n, nil
}

// ListExpiredOpenRequests returns all 'opened' or 'accepted' requests whose
// approval deadline has passed. Used by the background expiry loop.
func (q *Queries) ListExpiredOpenRequests(ctx context.Context) ([]models.ServerExpansionRequest, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+expansionRequestColumns+`
		FROM server_expansion_requests ser
		JOIN servers s ON s.id = ser.server_id
		JOIN users   u ON u.username = ser.username
		WHERE ser.status IN ('opened','accepted')
		  AND COALESCE(ser.approval_due_at, ser.expires_at) < NOW()
	`)
	if err != nil {
		return nil, fmt.Errorf("ListExpiredOpenRequests: %w", err)
	}
	defer rows.Close()

	var out []models.ServerExpansionRequest
	for rows.Next() {
		r, err := scanExpansionRequest(rows)
		if err != nil {
			return nil, fmt.Errorf("ListExpiredOpenRequests scan: %w", err)
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// ListExpiredApprovedRequests returns 'approved' requests whose expansion
// deadline (14 business days after approval) has passed. Their deposits are
// refunded by the expiry loop.
func (q *Queries) ListExpiredApprovedRequests(ctx context.Context) ([]models.ServerExpansionRequest, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+expansionRequestColumns+`
		FROM server_expansion_requests ser
		JOIN servers s ON s.id = ser.server_id
		JOIN users   u ON u.username = ser.username
		WHERE ser.status = 'approved' AND ser.expansion_due_at < NOW()
	`)
	if err != nil {
		return nil, fmt.Errorf("ListExpiredApprovedRequests: %w", err)
	}
	defer rows.Close()

	var out []models.ServerExpansionRequest
	for rows.Next() {
		r, err := scanExpansionRequest(rows)
		if err != nil {
			return nil, fmt.Errorf("ListExpiredApprovedRequests scan: %w", err)
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// ListUserExpansionRequests returns the user's expansion requests, newest
// first. Backs the web profile page's request list.
func (q *Queries) ListUserExpansionRequests(ctx context.Context, username string) ([]models.ServerExpansionRequest, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+expansionRequestColumns+`
		FROM server_expansion_requests ser
		JOIN servers s ON s.id = ser.server_id
		JOIN users   u ON u.username = ser.username
		WHERE ser.username = $1
		ORDER BY ser.created_at DESC
		LIMIT 50
	`, username)
	if err != nil {
		return nil, fmt.Errorf("ListUserExpansionRequests: %w", err)
	}
	defer rows.Close()

	var out []models.ServerExpansionRequest
	for rows.Next() {
		r, err := scanExpansionRequest(rows)
		if err != nil {
			return nil, fmt.Errorf("ListUserExpansionRequests scan: %w", err)
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}
