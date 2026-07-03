package models

import (
	"time"

	"github.com/google/uuid"
)

// ServerExpansionRequest represents a user's request to expand a server's
// capacity so they can purchase a storage tier that is currently unavailable.
// A 50% deposit is collected up-front; it is either applied on fulfilment or
// refunded on cancellation / expiry.
type ServerExpansionRequest struct {
	ID                 uuid.UUID  `json:"id"`
	Username           string     `json:"username"`
	ServerID           uuid.UUID  `json:"server_id"`
	PlanID             string     `json:"plan_id"`
	StorageType        string     `json:"storage_type"`
	BytesRequested     int64      `json:"bytes_requested"`
	DepositAmountCents int        `json:"deposit_amount_cents"`
	FullPriceCents     int        `json:"full_price_cents"`
	Currency           string     `json:"currency"`
	PaymentMethod      string     `json:"payment_method"`
	PayPalOrderID      string     `json:"paypal_order_id"`
	PayPalCaptureID    *string    `json:"paypal_capture_id"`
	Status             string     `json:"status"`
	PreQuotaBytes      int64      `json:"pre_quota_bytes"`
	PostQuotaBytes     *int64     `json:"post_quota_bytes"`
	ExpiresAt          time.Time  `json:"expires_at"`
	CreatedAt          time.Time  `json:"created_at"`
	CompletedAt        *time.Time `json:"completed_at"`
	RefundID           *string    `json:"refund_id"`
	CancellationReason *string    `json:"cancellation_reason"`
	PaymentDueAt       *time.Time `json:"payment_due_at"`

	// Populated by JOIN queries.
	ServerName  string `json:"server_name"`
	ServerState string `json:"server_state"`
	UserEmail   string `json:"user_email"`
}
