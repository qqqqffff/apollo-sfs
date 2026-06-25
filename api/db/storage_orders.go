package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const storageOrderColumns = `id, username, plan_id, storage_type, bytes_added,
	amount_cents, currency, payment_method, status,
	paypal_order_id, paypal_capture_id, raw_response, created_at, captured_at`

// CreateStorageOrder inserts a new storage order. For wallet (PayPal redirect)
// orders, only paypal_order_id is set and status is "created". For direct
// charges (card / Apple Pay / Google Pay), both paypal_order_id and
// paypal_capture_id are set and status is "captured".
func (q *Queries) CreateStorageOrder(ctx context.Context, o *models.StorageOrder) error {
	var captureID any
	if o.PayPalCaptureID != nil {
		captureID = *o.PayPalCaptureID
	}
	err := q.db.QueryRowContext(ctx, `
		INSERT INTO storage_orders
		    (username, plan_id, storage_type, bytes_added, amount_cents, currency,
		     payment_method, status, paypal_order_id, paypal_capture_id, raw_response,
		     captured_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
		RETURNING id, created_at
	`,
		o.Username, o.PlanID, o.StorageType, o.BytesAdded, o.AmountCents, o.Currency,
		o.PaymentMethod, o.Status, o.PayPalOrderID, captureID,
		rawWebhookOrNil(o.RawResponse), capturedAtOrNil(o.CapturedAt),
	).Scan(&o.ID, &o.CreatedAt)
	if err != nil {
		return fmt.Errorf("CreateStorageOrder: %w", err)
	}
	return nil
}

// GetStorageOrderByPayPalOrderID loads a storage order by its PayPal order ID.
// Returns sql.ErrNoRows if not found.
func (q *Queries) GetStorageOrderByPayPalOrderID(ctx context.Context, orderID string) (*models.StorageOrder, error) {
	return scanStorageOrder(q.db.QueryRowContext(ctx, `
		SELECT `+storageOrderColumns+`
		FROM storage_orders WHERE paypal_order_id = $1
	`, orderID))
}

// MarkStorageOrderCaptured transitions a "created" wallet order to "captured"
// and records the PayPal capture ID + raw response. Returns true if this call
// actually flipped the row (caller should apply quota); false if already
// captured (idempotent duplicate).
func (q *Queries) MarkStorageOrderCaptured(ctx context.Context, orderID, captureID string, raw []byte) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE storage_orders
		SET paypal_capture_id = $2,
		    status            = 'captured',
		    captured_at       = NOW(),
		    raw_response      = COALESCE($3::jsonb, raw_response)
		WHERE paypal_order_id   = $1
		  AND paypal_capture_id IS NULL
	`, orderID, captureID, rawWebhookOrNil(raw))
	if err != nil {
		return false, fmt.Errorf("MarkStorageOrderCaptured: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// AddUserQuota atomically adds bytesAdded to the user's storage_quota_bytes
// and returns the new total. Used after a successful storage order capture.
func (q *Queries) AddUserQuota(ctx context.Context, username string, bytesAdded int64) (int64, error) {
	var newQuota int64
	err := q.db.QueryRowContext(ctx, `
		UPDATE users
		SET storage_quota_bytes = storage_quota_bytes + $2
		WHERE username = $1
		RETURNING storage_quota_bytes
	`, username, bytesAdded).Scan(&newQuota)
	if err != nil {
		return 0, fmt.Errorf("AddUserQuota: %w", err)
	}
	return newQuota, nil
}

// UserStorageBreakdown holds the user's actual used bytes split by drive type.
type UserStorageBreakdown struct {
	NVMEBytes int64
	HDDBytes  int64
}

// GetUserStorageBreakdown sums the user's actual used bytes by the type of drive
// each file lives on (NVMe "fast" vs HDD "standard"). Earlier this summed
// purchased add-on quota from storage_orders, which read 0 whenever the quota
// came from the initial allocation; joining files→drives reports real usage.
// username is the Keycloak subject, stored verbatim as files.user_id (UUID).
func (q *Queries) GetUserStorageBreakdown(ctx context.Context, username string) (UserStorageBreakdown, error) {
	var b UserStorageBreakdown
	err := q.db.QueryRowContext(ctx, `
		SELECT
			COALESCE(SUM(f.size_bytes) FILTER (WHERE d.drive_type = 'nvme'), 0),
			COALESCE(SUM(f.size_bytes) FILTER (WHERE d.drive_type = 'hdd'), 0)
		FROM files f
		JOIN drives d ON d.id = f.drive_id
		WHERE f.user_id = $1::uuid
	`, username).Scan(&b.NVMEBytes, &b.HDDBytes)
	if err != nil {
		return b, fmt.Errorf("GetUserStorageBreakdown: %w", err)
	}
	return b, nil
}

func scanStorageOrder(row *sql.Row) (*models.StorageOrder, error) {
	var o models.StorageOrder
	var captureID sql.NullString
	var rawResp []byte
	var capturedAt sql.NullTime
	if err := row.Scan(
		&o.ID, &o.Username, &o.PlanID, &o.StorageType, &o.BytesAdded,
		&o.AmountCents, &o.Currency, &o.PaymentMethod, &o.Status,
		&o.PayPalOrderID, &captureID, &rawResp, &o.CreatedAt, &capturedAt,
	); err != nil {
		return nil, err
	}
	if captureID.Valid {
		s := captureID.String
		o.PayPalCaptureID = &s
	}
	if len(rawResp) > 0 {
		o.RawResponse = rawResp
	}
	if capturedAt.Valid {
		t := capturedAt.Time
		o.CapturedAt = &t
	}
	return &o, nil
}

func capturedAtOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}

// Compile-time anti-unused checks.
var (
	_ = uuid.UUID{}
	_ = time.Time{}
)
