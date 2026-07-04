package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// InvoiceLineItem is one priced line on a custom expansion invoice.
type InvoiceLineItem struct {
	Description string `json:"description"`
	AmountCents int64  `json:"amount_cents"`
}

// ExpansionInvoice mirrors the expansion_invoices table. Custom capacity
// requests show an estimated price at submission; the final amount is
// invoiced by an admin after manual review. The user has 14 business days to
// accept (paying the deposit when one is listed) before the request expires.
type ExpansionInvoice struct {
	ID                uuid.UUID       `json:"id"`
	RequestID         uuid.UUID       `json:"request_id"`
	InvoiceNumber     string          `json:"invoice_number"`
	LineItemsRaw      json.RawMessage `json:"-"`
	LineItems         []InvoiceLineItem `json:"line_items"`
	TotalCents        int64           `json:"total_cents"`
	DepositCents      int64           `json:"deposit_cents"`
	Disclosures       string          `json:"disclosures"`
	Notes             string          `json:"notes"`
	IncludeReviewLink bool            `json:"include_review_link"`
	ReviewToken       *string         `json:"review_token,omitempty"`
	Status            string          `json:"status"` // sent | accepted | expired | cancelled
	PayPalOrderID     *string         `json:"paypal_order_id"`
	PayPalCaptureID   *string         `json:"paypal_capture_id"`
	SentAt            time.Time       `json:"sent_at"`
	AcceptDueAt       time.Time       `json:"accept_due_at"`
	AcceptedAt        *time.Time      `json:"accepted_at"`
	CreatedAt         time.Time       `json:"created_at"`
}
