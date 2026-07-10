package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const premiumSubscriptionColumns = `id, username, paypal_subscription_id, plan,
	status, environment, current_period_end, cancelled_at, created_at, updated_at,
	amount_cents, currency, payment_method, refund_id, refund_amount_cents, refunded_at,
	cancellation_reason`

// CreatePendingSubscription inserts an "approval_pending" subscription row
// immediately after PayPal returns a subscription id. Mirrors
// CreatePendingPayment's shape for the one-time flow. AmountCents/Currency/
// PaymentMethod must already be set on s by the caller (resolved from the
// chosen plan's configured price).
func (q *Queries) CreatePendingSubscription(ctx context.Context, s *models.PremiumSubscription) error {
	env := s.Environment
	if env == "" {
		env = "live"
	}
	currency := s.Currency
	if currency == "" {
		currency = "USD"
	}
	paymentMethod := s.PaymentMethod
	if paymentMethod == "" {
		paymentMethod = "paypal"
	}
	err := q.db.QueryRowContext(ctx, `
		INSERT INTO premium_subscriptions (
			username, paypal_subscription_id, plan, status, environment,
			amount_cents, currency, payment_method
		)
		VALUES ($1, $2, $3, 'approval_pending', $4, $5, $6, $7)
		RETURNING id, created_at, updated_at
	`, s.Username, s.PayPalSubscriptionID, s.Plan, env, s.AmountCents, currency, paymentMethod,
	).Scan(&s.ID, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		return fmt.Errorf("CreatePendingSubscription: %w", err)
	}
	s.Status = "approval_pending"
	s.Environment = env
	s.Currency = currency
	s.PaymentMethod = paymentMethod
	return nil
}

// ExpireStalePendingSubscriptions marks any of the user's existing
// approval_pending rows as "expired" — called right before creating a new
// subscription so an abandoned checkout never blocks a retry (the partial
// unique index only constrains active/suspended rows, so this is cleanup,
// not a conflict-avoidance requirement).
func (q *Queries) ExpireStalePendingSubscriptions(ctx context.Context, username string) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE premium_subscriptions
		SET status = 'expired', updated_at = NOW()
		WHERE username = $1 AND status = 'approval_pending'
	`, username)
	if err != nil {
		return fmt.Errorf("ExpireStalePendingSubscriptions %q: %w", username, err)
	}
	return nil
}

// MarkSubscriptionActive transitions a subscription to "active" and records
// its billing period end. Idempotent: returns applied=false (and the
// id/username lookup still succeeds) if the row was already active, so
// callers only run the one-time grant side effects once — mirrors
// MarkPaymentCaptured. id is the subscription's internal row id, for audit
// log linkage (the PayPal subscription id isn't a UUID).
func (q *Queries) MarkSubscriptionActive(ctx context.Context, paypalSubscriptionID string, periodEnd *time.Time, raw []byte) (id uuid.UUID, username string, applied bool, err error) {
	err = q.db.QueryRowContext(ctx, `
		UPDATE premium_subscriptions
		SET status             = 'active',
		    current_period_end = COALESCE($2, current_period_end),
		    updated_at         = NOW(),
		    raw_webhook        = COALESCE($3::jsonb, raw_webhook)
		WHERE paypal_subscription_id = $1
		  AND status != 'active'
		RETURNING id, username
	`, paypalSubscriptionID, periodEnd, rawWebhookOrNil(raw)).Scan(&id, &username)
	if errors.Is(err, sql.ErrNoRows) {
		// Either already active, or an unknown subscription id. Look up the
		// row separately so the caller still gets a definitive answer.
		lookupErr := q.db.QueryRowContext(ctx, `
			SELECT id, username FROM premium_subscriptions WHERE paypal_subscription_id = $1
		`, paypalSubscriptionID).Scan(&id, &username)
		if errors.Is(lookupErr, sql.ErrNoRows) {
			return uuid.Nil, "", false, nil
		}
		if lookupErr != nil {
			return uuid.Nil, "", false, fmt.Errorf("MarkSubscriptionActive %q: %w", paypalSubscriptionID, lookupErr)
		}
		return id, username, false, nil
	}
	if err != nil {
		return uuid.Nil, "", false, fmt.Errorf("MarkSubscriptionActive %q: %w", paypalSubscriptionID, err)
	}
	return id, username, true, nil
}

// UpdateSubscriptionPeriod bumps current_period_end on a renewal
// (PAYMENT.SALE.COMPLETED) without touching status.
func (q *Queries) UpdateSubscriptionPeriod(ctx context.Context, paypalSubscriptionID string, periodEnd *time.Time) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE premium_subscriptions
		SET current_period_end = COALESCE($2, current_period_end), updated_at = NOW()
		WHERE paypal_subscription_id = $1 AND status = 'active'
	`, paypalSubscriptionID, periodEnd)
	if err != nil {
		return fmt.Errorf("UpdateSubscriptionPeriod %q: %w", paypalSubscriptionID, err)
	}
	return nil
}

// MarkSubscriptionStatus transitions a subscription to a terminal status
// (cancelled/expired/suspended) and returns the row's internal id + owning
// username so the caller can apply revocation side effects and log the audit
// entry (the PayPal subscription id isn't a UUID).
func (q *Queries) MarkSubscriptionStatus(ctx context.Context, paypalSubscriptionID, status string) (id uuid.UUID, username string, err error) {
	err = q.db.QueryRowContext(ctx, `
		UPDATE premium_subscriptions
		SET status       = $2,
		    cancelled_at = CASE WHEN $2 IN ('cancelled', 'expired') THEN NOW() ELSE cancelled_at END,
		    updated_at   = NOW()
		WHERE paypal_subscription_id = $1
		RETURNING id, username
	`, paypalSubscriptionID, status).Scan(&id, &username)
	if errors.Is(err, sql.ErrNoRows) {
		return uuid.Nil, "", nil
	}
	if err != nil {
		return uuid.Nil, "", fmt.Errorf("MarkSubscriptionStatus %q: %w", paypalSubscriptionID, err)
	}
	return id, username, nil
}

// GetSubscriptionByPayPalID loads a subscription row by its PayPal id.
// Returns sql.ErrNoRows if no such subscription exists.
func (q *Queries) GetSubscriptionByPayPalID(ctx context.Context, paypalSubscriptionID string) (*models.PremiumSubscription, error) {
	return scanPremiumSubscription(q.db.QueryRowContext(ctx, `
		SELECT `+premiumSubscriptionColumns+`
		FROM premium_subscriptions WHERE paypal_subscription_id = $1
	`, paypalSubscriptionID))
}

// GetSubscriptionByID loads a subscription row by its internal id — used by
// the admin Orders page's Subscriptions tab actions (cancel/revert), which
// address rows by the same id ListAdminSubscriptions returns. Returns
// sql.ErrNoRows if no such subscription exists.
func (q *Queries) GetSubscriptionByID(ctx context.Context, id uuid.UUID) (*models.PremiumSubscription, error) {
	return scanPremiumSubscription(q.db.QueryRowContext(ctx, `
		SELECT `+premiumSubscriptionColumns+`
		FROM premium_subscriptions WHERE id = $1
	`, id))
}

// MarkSubscriptionCancellationReason records the admin's reason for a Cancel
// action — set unconditionally (regardless of whether a refund was issued),
// so the cancelled user's notification always has a reason to show even when
// nothing was refunded.
func (q *Queries) MarkSubscriptionCancellationReason(ctx context.Context, id uuid.UUID, reason string) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE premium_subscriptions
		SET cancellation_reason = $2, updated_at = NOW()
		WHERE id = $1
	`, id, reason)
	if err != nil {
		return fmt.Errorf("MarkSubscriptionCancellationReason %s: %w", id, err)
	}
	return nil
}

// ListRecentAdminCancelledSubscriptionsForUser returns the user's
// subscriptions that were cancelled by an admin (cancellation_reason set,
// which the ordinary self-service cancel and PayPal webhooks never set)
// within the notification window — backs the "subscription_cancelled"
// notification-bell item (see routes/me.go gatherNotificationItems).
func (q *Queries) ListRecentAdminCancelledSubscriptionsForUser(ctx context.Context, username string, since time.Time) ([]models.PremiumSubscription, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+premiumSubscriptionColumns+`
		FROM premium_subscriptions
		WHERE username = $1 AND cancellation_reason IS NOT NULL AND cancelled_at >= $2
		ORDER BY cancelled_at DESC
	`, username, since)
	if err != nil {
		return nil, fmt.Errorf("ListRecentAdminCancelledSubscriptionsForUser %q: %w", username, err)
	}
	defer rows.Close()
	var out []models.PremiumSubscription
	for rows.Next() {
		s, err := scanPremiumSubscriptionRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListRecentAdminCancelledSubscriptionsForUser scan: %w", err)
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

// MarkSubscriptionRefunded records a completed admin prorated refund. Doesn't
// touch status — the caller separately transitions the subscription to
// 'cancelled' via MarkSubscriptionStatus (through RevokeSubscription).
func (q *Queries) MarkSubscriptionRefunded(ctx context.Context, id uuid.UUID, refundID string, refundAmountCents int) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE premium_subscriptions
		SET refund_id = $2, refund_amount_cents = $3, refunded_at = NOW(), updated_at = NOW()
		WHERE id = $1
	`, id, refundID, refundAmountCents)
	if err != nil {
		return fmt.Errorf("MarkSubscriptionRefunded %s: %w", id, err)
	}
	return nil
}

// GetActiveSubscriptionForUser returns the user's active or suspended
// subscription, or nil if they have none — used by GET /me to surface the
// sandbox badge, plan, and next-billing date.
func (q *Queries) GetActiveSubscriptionForUser(ctx context.Context, username string) (*models.PremiumSubscription, error) {
	sub, err := scanPremiumSubscription(q.db.QueryRowContext(ctx, `
		SELECT `+premiumSubscriptionColumns+`
		FROM premium_subscriptions
		WHERE username = $1 AND status IN ('active', 'suspended')
		ORDER BY created_at DESC
		LIMIT 1
	`, username))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetActiveSubscriptionForUser %q: %w", username, err)
	}
	return sub, nil
}

// HasActivePremiumSubscription reports whether username has a genuinely
// active/suspended subscription of their own — as opposed to users.is_premium,
// which is also true for every admin regardless of whether they ever
// subscribed. Replaces the old one-time-purchase HasActivePremiumPurchase.
func (q *Queries) HasActivePremiumSubscription(ctx context.Context, username string) (bool, error) {
	var subscribed bool
	err := q.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM premium_subscriptions
			WHERE username = $1 AND status IN ('active', 'suspended')
		)
	`, username).Scan(&subscribed)
	if err != nil {
		return false, fmt.Errorf("HasActivePremiumSubscription %q: %w", username, err)
	}
	return subscribed, nil
}

// ListPastDueActiveSubscriptions returns "active" subscriptions whose
// current_period_end is older than cutoff — candidates for the reconciliation
// loop to re-check against PayPal directly (missed-webhook safety net).
func (q *Queries) ListPastDueActiveSubscriptions(ctx context.Context, cutoff time.Time) ([]models.PremiumSubscription, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+premiumSubscriptionColumns+`
		FROM premium_subscriptions
		WHERE status = 'active' AND current_period_end IS NOT NULL AND current_period_end < $1
	`, cutoff)
	if err != nil {
		return nil, fmt.Errorf("ListPastDueActiveSubscriptions: %w", err)
	}
	defer rows.Close()
	var out []models.PremiumSubscription
	for rows.Next() {
		s, err := scanPremiumSubscriptionRow(rows)
		if err != nil {
			return nil, fmt.Errorf("ListPastDueActiveSubscriptions scan: %w", err)
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

// rowScanner is satisfied by both *sql.Row and *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanPremiumSubscription(row rowScanner) (*models.PremiumSubscription, error) {
	var s models.PremiumSubscription
	var periodEnd, cancelledAt, refundedAt sql.NullTime
	var refundID, cancellationReason sql.NullString
	var refundAmountCents sql.NullInt64
	if err := row.Scan(
		&s.ID, &s.Username, &s.PayPalSubscriptionID, &s.Plan,
		&s.Status, &s.Environment, &periodEnd, &cancelledAt, &s.CreatedAt, &s.UpdatedAt,
		&s.AmountCents, &s.Currency, &s.PaymentMethod,
		&refundID, &refundAmountCents, &refundedAt,
		&cancellationReason,
	); err != nil {
		return nil, err
	}
	if periodEnd.Valid {
		s.CurrentPeriodEnd = &periodEnd.Time
	}
	if cancelledAt.Valid {
		s.CancelledAt = &cancelledAt.Time
	}
	if refundID.Valid {
		s.RefundID = &refundID.String
	}
	if refundAmountCents.Valid {
		v := int(refundAmountCents.Int64)
		s.RefundAmountCents = &v
	}
	if refundedAt.Valid {
		s.RefundedAt = &refundedAt.Time
	}
	if cancellationReason.Valid {
		s.CancellationReason = &cancellationReason.String
	}
	return &s, nil
}

func scanPremiumSubscriptionRow(rows *sql.Rows) (*models.PremiumSubscription, error) {
	return scanPremiumSubscription(rows)
}

// SubscriptionOrderSummary pairs a subscription with an invoice-style
// display reference, mirroring AdminOrder's invoice_number for
// payments/storage_orders — used only by the client orders page.
type SubscriptionOrderSummary struct {
	models.PremiumSubscription
	Reference string
}

// ListSubscriptionsForUser returns every subscription the user has ever
// created (including cancelled/expired/abandoned ones), newest first — backs
// the "Premium" tab on the client orders page alongside ListUserOrders'
// payments/storage_orders rows.
func (q *Queries) ListSubscriptionsForUser(ctx context.Context, username string) ([]SubscriptionOrderSummary, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT `+premiumSubscriptionColumns+`,
		       'SUB-' || to_char(created_at, 'YYMMDD') || '-' || upper(left(replace(id::text, '-', ''), 6)) AS reference
		FROM premium_subscriptions
		WHERE username = $1
		ORDER BY created_at DESC
	`, username)
	if err != nil {
		return nil, fmt.Errorf("ListSubscriptionsForUser %q: %w", username, err)
	}
	defer rows.Close()
	var out []SubscriptionOrderSummary
	for rows.Next() {
		var s models.PremiumSubscription
		var periodEnd, cancelledAt, refundedAt sql.NullTime
		var refundID, cancellationReason sql.NullString
		var refundAmountCents sql.NullInt64
		var reference string
		if err := rows.Scan(
			&s.ID, &s.Username, &s.PayPalSubscriptionID, &s.Plan,
			&s.Status, &s.Environment, &periodEnd, &cancelledAt, &s.CreatedAt, &s.UpdatedAt,
			&s.AmountCents, &s.Currency, &s.PaymentMethod,
			&refundID, &refundAmountCents, &refundedAt,
			&cancellationReason, &reference,
		); err != nil {
			return nil, fmt.Errorf("ListSubscriptionsForUser scan: %w", err)
		}
		if periodEnd.Valid {
			s.CurrentPeriodEnd = &periodEnd.Time
		}
		if cancelledAt.Valid {
			s.CancelledAt = &cancelledAt.Time
		}
		if refundID.Valid {
			s.RefundID = &refundID.String
		}
		if refundAmountCents.Valid {
			v := int(refundAmountCents.Int64)
			s.RefundAmountCents = &v
		}
		if refundedAt.Valid {
			s.RefundedAt = &refundedAt.Time
		}
		if cancellationReason.Valid {
			s.CancellationReason = &cancellationReason.String
		}
		out = append(out, SubscriptionOrderSummary{PremiumSubscription: s, Reference: reference})
	}
	return out, rows.Err()
}
