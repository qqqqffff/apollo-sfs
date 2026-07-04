package models

import (
	"time"

	"github.com/google/uuid"
)

// InterestSubmission mirrors the `interest_submissions` table.
type InterestSubmission struct {
	ID               uuid.UUID `json:"id"`
	Name             string    `json:"name"`
	Email            string    `json:"email"`
	DesiredStorageGB int       `json:"desired_storage_gb"`
	UseCase          string    `json:"use_case"`
	IPAddress        string    `json:"ip_address"`
	// PlanID / StorageType identify the fixed storage plan requested (mirrors
	// billing.storagePlans — no custom/arbitrary amounts are accepted).
	PlanID             string     `json:"plan_id"`
	StorageType        string     `json:"storage_type"`
	FullPriceCents     int        `json:"full_price_cents"`
	DepositAmountCents int        `json:"deposit_amount_cents"`
	Currency           string     `json:"currency"`
	PaymentMethod      string     `json:"payment_method"`
	PayPalOrderID      *string    `json:"paypal_order_id"`
	PayPalCaptureID    *string    `json:"paypal_capture_id"`
	DeniedAt           *time.Time `json:"denied_at"`
	RefundID           *string    `json:"refund_id"`
	CreatedAt          time.Time  `json:"created_at"`
	ProvisionedAt      *time.Time `json:"provisioned_at"`
	InvitationID       *uuid.UUID `json:"invitation_id"`
}

// InterestDepositOrder mirrors the `interest_deposit_orders` table: a PayPal
// deposit captured against a fixed plan/storage-type before the visitor has
// submitted the rest of the interest form. Consumed exactly once by
// SubmitInterestForm.
type InterestDepositOrder struct {
	OrderID            string     `json:"order_id"`
	PlanID             string     `json:"plan_id"`
	StorageType        string     `json:"storage_type"`
	FullPriceCents     int        `json:"full_price_cents"`
	DepositAmountCents int        `json:"deposit_amount_cents"`
	Currency           string     `json:"currency"`
	PaymentMethod      string     `json:"payment_method"`
	PayPalCaptureID    *string    `json:"paypal_capture_id"`
	CapturedAt         *time.Time `json:"captured_at"`
	ConsumedAt         *time.Time `json:"consumed_at"`
	CreatedAt          time.Time  `json:"created_at"`
}

// InterestFormSettings mirrors the `interest_form_settings` table (single row).
type InterestFormSettings struct {
	DailyCap  int       `json:"daily_cap"`
	UpdatedAt time.Time `json:"updated_at"`
}
