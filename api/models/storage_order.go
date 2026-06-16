package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// StorageOrder mirrors the storage_orders table. One row per storage add-on
// purchase. paypal_capture_id UNIQUE is the idempotency key for the
// wallet-redirect two-step flow; direct charges (card/Apple Pay/Google Pay)
// insert with both IDs already populated.
type StorageOrder struct {
	ID               uuid.UUID       `json:"id"`
	Username         string          `json:"username"`
	PlanID           string          `json:"plan_id"`
	StorageType      string          `json:"storage_type"`
	BytesAdded       int64           `json:"bytes_added"`
	AmountCents      int             `json:"amount_cents"`
	Currency         string          `json:"currency"`
	PaymentMethod    string          `json:"payment_method"`
	Status           string          `json:"status"`
	PayPalOrderID    string          `json:"paypal_order_id"`
	PayPalCaptureID  *string         `json:"paypal_capture_id"`
	RawResponse      json.RawMessage `json:"-"`
	CreatedAt        time.Time       `json:"created_at"`
	CapturedAt       *time.Time      `json:"captured_at"`
}
