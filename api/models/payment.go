package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Payment mirrors the payments table. One row per PayPal Orders v2 checkout
// attempt. paypal_capture_id UNIQUE is the idempotency key shared between
// the synchronous capture handler and the asynchronous webhook.
type Payment struct {
	ID               uuid.UUID       `json:"id"                db:"id"`
	Username         string          `json:"username"          db:"username"`
	PayPalOrderID    string          `json:"paypal_order_id"   db:"paypal_order_id"`
	PayPalCaptureID  *string         `json:"paypal_capture_id" db:"paypal_capture_id"`
	AmountCents      int             `json:"amount_cents"      db:"amount_cents"`
	Currency         string          `json:"currency"          db:"currency"`
	Status           string          `json:"status"            db:"status"`
	PaymentMethod    string          `json:"payment_method"    db:"payment_method"`
	CreatedAt        time.Time       `json:"created_at"        db:"created_at"`
	CapturedAt       *time.Time      `json:"captured_at"       db:"captured_at"`
	RawWebhook       json.RawMessage `json:"-"                 db:"raw_webhook"`
}
