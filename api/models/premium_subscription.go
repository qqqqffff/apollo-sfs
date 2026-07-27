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
	// BillingMode is "paypal" (PayPal-managed Subscriptions v1 — the shopper
	// approves on PayPal's hosted page and PayPal drives the recurring
	// charges) or "self" (we bill a vaulted card/wallet ourselves over Orders
	// v2, because Subscriptions v1 can't be bound to those funding sources).
	// The fields below are meaningful only in "self" mode.
	BillingMode string `json:"billing_mode" db:"billing_mode"`
	// VaultID is the PayPal saved-payment-method token renewals charge
	// against; VaultSource records which funding source opened it ("card",
	// "apple_pay", "google_pay") for display — renewals always go through the
	// card payment source regardless, since wallets vault the underlying card.
	VaultID     *string `json:"-"            db:"vault_id"`
	VaultSource *string `json:"vault_source" db:"vault_source"`
	// NextChargeAt is when the renewal loop should next bill this
	// subscription. Equal to CurrentPeriodEnd on a healthy subscription;
	// pulled earlier by the retry backoff after a failed charge.
	NextChargeAt *time.Time `json:"next_charge_at" db:"next_charge_at"`
	// FailedChargeCount is the run of consecutive failed renewal attempts,
	// reset to 0 on every success. LastChargeError is the most recent failure
	// message, for the admin orders page and support.
	FailedChargeCount int     `json:"failed_charge_count" db:"failed_charge_count"`
	LastChargeError   *string `json:"last_charge_error"   db:"last_charge_error"`
	// LastCaptureID is the PayPal capture id of the most recent successful
	// charge (opening period or renewal). Self-billed subscriptions have no
	// PayPal subscription to list transactions against, so this is the only
	// handle the admin prorated-refund tooling has on the money that moved.
	LastCaptureID *string `json:"-" db:"last_capture_id"`
	// CancellationReason is set only by an admin Cancel action — nil for
	// subscriptions ended via the user's own self-service cancel or a
	// PayPal webhook. Surfaced to the cancelled user via a notification-bell
	// item (see routes/me.go gatherNotificationItems).
	CancellationReason *string `json:"cancellation_reason" db:"cancellation_reason"`
}
