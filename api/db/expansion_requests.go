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
	ser.status, ser.pre_quota_bytes, ser.post_quota_bytes,
	ser.expires_at, ser.created_at, ser.completed_at,
	ser.refund_id, ser.cancellation_reason, ser.payment_due_at,
	s.name AS server_name, s.state AS server_state,
	u.email AS user_email`

func scanExpansionRequest(rows interface {
	Scan(...any) error
}) (*models.ServerExpansionRequest, error) {
	var r models.ServerExpansionRequest
	var captureID, refundID, reason sql.NullString
	var postQuota sql.NullInt64
	var completedAt, paymentDueAt sql.NullTime
	err := rows.Scan(
		&r.ID, &r.Username, &r.ServerID, &r.PlanID, &r.StorageType,
		&r.BytesRequested, &r.DepositAmountCents, &r.FullPriceCents,
		&r.Currency, &r.PaymentMethod, &r.PayPalOrderID, &captureID,
		&r.Status, &r.PreQuotaBytes, &postQuota,
		&r.ExpiresAt, &r.CreatedAt, &completedAt,
		&refundID, &reason, &paymentDueAt,
		&r.ServerName, &r.ServerState, &r.UserEmail,
	)
	if err != nil {
		return nil, err
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
	PreQuotaBytes      int64
	ExpiresAt          time.Time
}

// CreateExpansionRequest inserts a new server expansion request.
func (q *Queries) CreateExpansionRequest(ctx context.Context, p CreateExpansionRequestParams) (*models.ServerExpansionRequest, error) {
	var captureID any
	if p.PayPalCaptureID != nil {
		captureID = *p.PayPalCaptureID
	}
	row := q.db.QueryRowContext(ctx, `
		INSERT INTO server_expansion_requests
			(username, server_id, plan_id, storage_type, bytes_requested,
			 deposit_amount_cents, full_price_cents, currency, payment_method,
			 paypal_order_id, paypal_capture_id, status, pre_quota_bytes, expires_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
		RETURNING id, created_at
	`,
		p.Username, p.ServerID, p.PlanID, p.StorageType, p.BytesRequested,
		p.DepositAmountCents, p.FullPriceCents, p.Currency, p.PaymentMethod,
		p.PayPalOrderID, captureID, p.Status, p.PreQuotaBytes, p.ExpiresAt,
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
		WHERE username = $1 AND status IN ('opened', 'expanded')
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
}

// ListExpansionRequests returns a paginated list of expansion requests, newest
// first, with optional status / server / date-range filters.
func (q *Queries) ListExpansionRequests(ctx context.Context, f ExpansionRequestFilter, in PageInput) (*PageResult[models.ServerExpansionRequest], error) {
	if in.Skip {
		return &PageResult[models.ServerExpansionRequest]{}, nil
	}
	limit := clampLimit(in.Limit)

	var afterTime time.Time
	if in.Cursor != "" {
		t, err := decodeTimeCursor(in.Cursor)
		if err == nil {
			afterTime = t
		}
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
	if !afterTime.IsZero() {
		add("ser.created_at <", afterTime)
	}

	args = append(args, limit+1)
	query := fmt.Sprintf(`
		SELECT %s
		FROM server_expansion_requests ser
		JOIN servers s ON s.id = ser.server_id
		JOIN users   u ON u.username = ser.username
		%s
		ORDER BY ser.created_at DESC
		LIMIT $%d
	`, expansionRequestColumns, where, len(args))

	rows, err := q.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("ListExpansionRequests: %w", err)
	}
	defer rows.Close()

	var items []models.ServerExpansionRequest
	for rows.Next() {
		r, err := scanExpansionRequest(rows)
		if err != nil {
			return nil, fmt.Errorf("ListExpansionRequests scan: %w", err)
		}
		items = append(items, *r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListExpansionRequests rows: %w", err)
	}

	var nextToken string
	if len(items) > limit {
		items = items[:limit]
		nextToken = encodeTimeCursor(items[len(items)-1].CreatedAt)
	}
	return &PageResult[models.ServerExpansionRequest]{Items: items, NextToken: nextToken}, nil
}

// FulfillExpansionRequest sets status='completed', records post_quota_bytes and
// completed_at. Returns false if the request was not in 'opened' state.
func (q *Queries) FulfillExpansionRequest(ctx context.Context, id uuid.UUID, postQuotaBytes int64) (bool, error) {
	now := time.Now()
	res, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'completed', post_quota_bytes = $2, completed_at = $3
		WHERE id = $1 AND status IN ('opened','expanded')
	`, id, postQuotaBytes, now)
	if err != nil {
		return false, fmt.Errorf("FulfillExpansionRequest: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// CancelExpansionRequest sets status='refunded' and records the refund ID and
// reason. Returns false if the request was not in a cancellable state.
func (q *Queries) CancelExpansionRequest(ctx context.Context, id uuid.UUID, refundID, reason string) (bool, error) {
	now := time.Now()
	res, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'refunded', refund_id = $2, cancellation_reason = $3, completed_at = $4
		WHERE id = $1 AND status IN ('opened','expanded')
	`, id, refundID, reason, now)
	if err != nil {
		return false, fmt.Errorf("CancelExpansionRequest: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ExpireExpansionRequest marks a single request as 'expired' with a refund ID.
func (q *Queries) ExpireExpansionRequest(ctx context.Context, id uuid.UUID, refundID string) error {
	now := time.Now()
	_, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'expired', refund_id = $2, completed_at = $3
		WHERE id = $1 AND status = 'opened'
	`, id, refundID, now)
	if err != nil {
		return fmt.Errorf("ExpireExpansionRequest: %w", err)
	}
	return nil
}

// MarkExpansionRequestExpanded transitions an 'opened' request to 'expanded',
// indicating the server capacity is ready and the user must pay the remaining
// balance within paymentWindowDays days. Returns false if not in 'opened' state.
func (q *Queries) MarkExpansionRequestExpanded(ctx context.Context, id uuid.UUID, paymentWindowDays int) (bool, error) {
	due := time.Now().AddDate(0, 0, paymentWindowDays)
	res, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'expanded', payment_due_at = $2
		WHERE id = $1 AND status = 'opened'
	`, id, due)
	if err != nil {
		return false, fmt.Errorf("MarkExpansionRequestExpanded: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ForfeitExpansionRequest marks an 'expanded' request as 'expired' WITHOUT
// issuing a refund. Used when the user fails to pay the remaining balance
// within the payment window.
func (q *Queries) ForfeitExpansionRequest(ctx context.Context, id uuid.UUID) error {
	now := time.Now()
	_, err := q.db.ExecContext(ctx, `
		UPDATE server_expansion_requests
		SET status = 'expired', completed_at = $2
		WHERE id = $1 AND status = 'expanded'
	`, id, now)
	if err != nil {
		return fmt.Errorf("ForfeitExpansionRequest: %w", err)
	}
	return nil
}

// ListExpiredExpandedRequests returns 'expanded' requests whose payment_due_at
// has passed. These are forfeited without a refund.
func (q *Queries) ListExpiredExpandedRequests(ctx context.Context) ([]models.ServerExpansionRequest, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+expansionRequestColumns+`
		FROM server_expansion_requests ser
		JOIN servers s ON s.id = ser.server_id
		JOIN users   u ON u.username = ser.username
		WHERE ser.status = 'expanded' AND ser.payment_due_at < NOW()
	`)
	if err != nil {
		return nil, fmt.Errorf("ListExpiredExpandedRequests: %w", err)
	}
	defer rows.Close()

	var out []models.ServerExpansionRequest
	for rows.Next() {
		r, err := scanExpansionRequest(rows)
		if err != nil {
			return nil, fmt.Errorf("ListExpiredExpandedRequests scan: %w", err)
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

// ListExpiredOpenRequests returns all 'opened' requests whose expires_at has
// passed. Used by the background expiry loop.
func (q *Queries) ListExpiredOpenRequests(ctx context.Context) ([]models.ServerExpansionRequest, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+expansionRequestColumns+`
		FROM server_expansion_requests ser
		JOIN servers s ON s.id = ser.server_id
		JOIN users   u ON u.username = ser.username
		WHERE ser.status = 'opened' AND ser.expires_at < NOW()
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
