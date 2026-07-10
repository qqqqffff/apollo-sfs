package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// PremiumSubscription mirrors the premium_subscriptions table. One row per
// PayPal Subscriptions v1 subscription a user has created. Bookkeeping/billing
// metadata only — actual access control stays on users.is_premium + the
// Keycloak "premium" group, exactly as before subscriptions existed.
type PremiumSubscription struct {
	ID                   uuid.UUID       `json:"id"                     db:"id"`
	Username             string          `json:"username"               db:"username"`
	PayPalSubscriptionID string          `json:"paypal_subscription_id" db:"paypal_subscription_id"`
	Plan                 string          `json:"plan"                   db:"plan"`
	Status               string          `json:"status"                 db:"status"`
	Environment          string          `json:"environment"            db:"environment"`
	CurrentPeriodEnd     *time.Time      `json:"current_period_end"     db:"current_period_end"`
	CancelledAt          *time.Time      `json:"cancelled_at"           db:"cancelled_at"`
	CreatedAt            time.Time       `json:"created_at"             db:"created_at"`
	UpdatedAt            time.Time       `json:"updated_at"             db:"updated_at"`
	RawWebhook           json.RawMessage `json:"-"                      db:"raw_webhook"`
	// AmountCents/Currency/PaymentMethod are stamped at creation from the
	// resolved plan price — mirrors Payment/StorageOrder's shape so the
	// client orders page can list subscriptions the same way.
	AmountCents   int    `json:"amount_cents"   db:"amount_cents"`
	Currency      string `json:"currency"       db:"currency"`
	PaymentMethod string `json:"payment_method" db:"payment_method"`
	// RefundID/RefundAmountCents/RefundedAt are set by an admin-initiated
	// prorated cancellation (see orders.Handler.CancelSubscription) — nil
	// for subscriptions that were never refunded, including ones ended via
	// the ordinary user-initiated cancel (which revokes access but issues
	// no refund) or a PayPal webhook.
	RefundID          *string    `json:"refund_id"           db:"refund_id"`
	RefundAmountCents *int       `json:"refund_amount_cents" db:"refund_amount_cents"`
	RefundedAt        *time.Time `json:"refunded_at"         db:"refunded_at"`
	// CancellationReason is set only by an admin Cancel action — nil for
	// subscriptions ended via the user's own self-service cancel or a
	// PayPal webhook. Surfaced to the cancelled user via a notification-bell
	// item (see routes/me.go gatherNotificationItems).
	CancellationReason *string `json:"cancellation_reason" db:"cancellation_reason"`
}
