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
	IsCustom           bool       `json:"is_custom"`
	PreQuotaBytes      int64      `json:"pre_quota_bytes"`
	PostQuotaBytes     *int64     `json:"post_quota_bytes"`
	ExpiresAt          time.Time  `json:"expires_at"`
	ApprovalDueAt      *time.Time `json:"approval_due_at"`
	ApprovedAt         *time.Time `json:"approved_at"`
	ExpansionDueAt     *time.Time `json:"expansion_due_at"`
	CreatedAt          time.Time  `json:"created_at"`
	CompletedAt        *time.Time `json:"completed_at"`
	RefundID           *string    `json:"refund_id"`
	CancellationReason *string    `json:"cancellation_reason"`
	PaymentDueAt       *time.Time `json:"payment_due_at"`
	// ReminderSentAt is when the most recent remaining-balance reminder went
	// out; RemindersSent counts them (3 total: due+7d, 7 days before the
	// revert, 1 day before the revert).
	ReminderSentAt *time.Time `json:"reminder_sent_at"`
	RemindersSent  int        `json:"reminders_sent"`
	// Environment is which PayPal instance ("sandbox" | "live") this request's
	// orders were created against — set from the admin sandbox-payments toggle
	// at creation.
	Environment string `json:"environment"`

	// Populated by JOIN queries.
	ServerName  string `json:"server_name"`
	ServerState string `json:"server_state"`
	UserEmail   string `json:"user_email"`

	// Latest invoice summary, populated by the admin listing query and the
	// user's own listing query, for custom requests.
	InvoiceNumber      *string    `json:"invoice_number,omitempty"`
	InvoiceStatus      *string    `json:"invoice_status,omitempty"`
	InvoiceSentAt      *time.Time `json:"invoice_sent_at,omitempty"`
	InvoiceAcceptDueAt *time.Time `json:"invoice_accept_due_at,omitempty"`
	// InvoiceReviewToken lets the owning user's own orders page link straight
	// to the token-gated /invoice/:token review page in-app, instead of
	// relying on the emailed link. Only set when the invoice was created with
	// IncludeReviewLink=true.
	InvoiceReviewToken *string `json:"invoice_review_token,omitempty"`
}
