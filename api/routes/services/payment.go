package services

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// GroupAdmin is the subset of *AuthService used by PaymentService for
// realm-group membership flips. Captured behind an interface so unit tests
// can stub the Keycloak round-trips.
type GroupAdmin interface {
	AddUserToGroupByName(ctx context.Context, username, groupName string) error
	RemoveUserFromGroupByName(ctx context.Context, username, groupName string) error
}

// Compile-time: AuthService satisfies GroupAdmin.
var _ GroupAdmin = (*AuthService)(nil)

// PaymentService coordinates the database, Keycloak group, and API key
// side-effects of a successful premium purchase. The PayPal HTTP calls
// themselves are issued by PayPalClient — this service is the orchestrator
// that lives between the handler and those primitives.
type PaymentService struct {
	queries *db.Queries
	kc      GroupAdmin
}

// NewPaymentService wires a PaymentService. kc may be nil during local
// development without Keycloak; the group flip is then skipped and only
// the DB flag is set.
func NewPaymentService(q *db.Queries, kc GroupAdmin) *PaymentService {
	return &PaymentService{queries: q, kc: kc}
}

// ApplyCapture is the single idempotent function that both the synchronous
// capture handler and the asynchronous webhook call after PayPal reports a
// successful capture. The (payments.paypal_capture_id UNIQUE) constraint is
// the idempotency anchor: MarkPaymentCaptured returns false (no rows
// updated) on a duplicate call, in which case this function exits early
// without re-running the side effects.
func (s *PaymentService) ApplyCapture(ctx context.Context, orderID, captureID string, rawWebhook []byte) error {
	applied, err := s.queries.MarkPaymentCaptured(ctx, orderID, captureID, rawWebhook)
	if err != nil {
		return fmt.Errorf("apply capture: mark: %w", err)
	}
	if !applied {
		// Already captured by a previous webhook or sync call. Idempotent.
		return nil
	}
	payment, err := s.queries.GetPaymentByOrderID(ctx, orderID)
	if err != nil {
		return fmt.Errorf("apply capture: load payment: %w", err)
	}
	if err := s.queries.SetUserPremium(ctx, payment.Username, true); err != nil {
		return fmt.Errorf("apply capture: set premium: %w", err)
	}
	if s.kc != nil {
		if err := s.kc.AddUserToGroupByName(ctx, payment.Username, "premium"); err != nil {
			// Log but do not roll back: the DB flag is the source of truth
			// for API key validation, and the next login will re-sync the
			// JWT role via the middleware. An operator alert via audit_log
			// is enough.
			log.Printf("apply capture: KC group add for %q: %v", payment.Username, err)
		}
	}
	action := "premium.granted"
	resourceType := "payment"
	resourceID := payment.ID
	resourceName := captureID
	if err := s.queries.InsertAuditLog(ctx, db.AuditInput{
		TargetUsername: payment.Username,
		ActorUsername:  payment.Username,
		Action:         action,
		ResourceType:   &resourceType,
		ResourceID:     &resourceID,
		ResourceName:   &resourceName,
	}); err != nil {
		log.Printf("apply capture: audit log: %v", err)
	}
	return nil
}

// revokePremiumEffects clears is_premium (unless the user is an admin, whose
// premium flag is implicit and gets resynced from is_admin on every JWT
// refresh regardless), removes KC premium-group membership, and revokes
// every API key the user holds. Shared by RevokePremium (real PayPal
// refund/dispute webhook) and RevokePremiumAllocation (admin sandbox
// allocation-revert path) — the two differ only in which payment/order
// bookkeeping they update around this call.
func (s *PaymentService) revokePremiumEffects(ctx context.Context, username string) error {
	user, err := s.queries.GetUserByUsername(ctx, username)
	if err != nil {
		return fmt.Errorf("revoke premium effects: load user: %w", err)
	}
	// Admins keep their implicit premium access — only clear the flag for
	// non-admin accounts. Admins also stay in the KC premium group if they
	// were explicitly added there, but the DB flag for them is recomputed
	// from is_admin on every JWT refresh, so leaving it alone is fine too.
	if !user.IsAdmin {
		if err := s.queries.SetUserPremium(ctx, username, false); err != nil {
			return fmt.Errorf("revoke premium effects: clear flag: %w", err)
		}
		if s.kc != nil {
			if err := s.kc.RemoveUserFromGroupByName(ctx, username, "premium"); err != nil {
				log.Printf("revoke premium effects: KC group remove for %q: %v", username, err)
			}
		}
	}
	if err := s.queries.RevokeAllAPIKeysForUser(ctx, username); err != nil {
		return fmt.Errorf("revoke premium effects: revoke api keys: %w", err)
	}
	return nil
}

// RevokePremium is the inverse of ApplyCapture: called from the webhook
// handler when PayPal reports a refund or dispute. Marks the payment
// refunded, then applies revokePremiumEffects.
//
// Idempotent: safe to call repeatedly.
func (s *PaymentService) RevokePremium(ctx context.Context, captureID, reason string) error {
	payment, err := s.queries.GetPaymentByCaptureID(ctx, captureID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// Refund for an unknown capture — likely a duplicate webhook
			// or test event; nothing to revoke.
			return nil
		}
		return fmt.Errorf("revoke premium: load payment: %w", err)
	}
	if err := s.queries.MarkPaymentRefunded(ctx, captureID, nil); err != nil {
		return fmt.Errorf("revoke premium: mark refunded: %w", err)
	}
	if err := s.revokePremiumEffects(ctx, payment.Username); err != nil {
		return fmt.Errorf("revoke premium: %w", err)
	}
	action := "premium.revoked"
	resourceType := "payment"
	resourceID := payment.ID
	resourceName := reason
	if err := s.queries.InsertAuditLog(ctx, db.AuditInput{
		TargetUsername: payment.Username,
		ActorUsername:  payment.Username,
		Action:         action,
		ResourceType:   &resourceType,
		ResourceID:     &resourceID,
		ResourceName:   &resourceName,
	}); err != nil {
		log.Printf("revoke premium: audit log: %v", err)
	}
	return nil
}

// RevokePremiumAllocation applies the same premium-teardown side effects as
// RevokePremium (clear is_premium, remove the KC premium group, revoke API
// keys) without touching payment refund bookkeeping. Used by the admin
// "revert allocation" / sandbox-order refund paths in routes/orders, where
// the order stays 'captured' — sandbox money was never real, so there's
// nothing to mark refunded — and MarkPayment{Refunded,AllocationReverted}
// already record the accounting state separately.
func (s *PaymentService) RevokePremiumAllocation(ctx context.Context, username string) error {
	return s.revokePremiumEffects(ctx, username)
}

// CreatePending records a new "created" payments row. Returns the row so
// the caller can echo back the order_id to the frontend.
func (s *PaymentService) CreatePending(ctx context.Context, p *models.Payment) error {
	return s.queries.CreatePendingPayment(ctx, p)
}

// GetByOrderID fetches a payment row. Used by the capture handler to look
// up the username and amount before calling ApplyCapture.
func (s *PaymentService) GetByOrderID(ctx context.Context, orderID string) (*models.Payment, error) {
	return s.queries.GetPaymentByOrderID(ctx, orderID)
}

// ApplySubscriptionActivated is the subscription equivalent of ApplyCapture:
// called both by the post-approval-redirect confirm endpoint and the
// asynchronous BILLING.SUBSCRIPTION.ACTIVATED webhook. MarkSubscriptionActive
// is the idempotency anchor (status transition guard), so both callers can
// fire without double-granting premium.
func (s *PaymentService) ApplySubscriptionActivated(ctx context.Context, subscriptionID string, nextBillingTime *time.Time, rawWebhook []byte) error {
	id, username, applied, err := s.queries.MarkSubscriptionActive(ctx, subscriptionID, nextBillingTime, rawWebhook)
	if err != nil {
		return fmt.Errorf("apply subscription activated: mark: %w", err)
	}
	if id == uuid.Nil {
		// Unknown subscription id — nothing to grant.
		return nil
	}
	if !applied {
		// Already active by a previous webhook or confirm call. Idempotent.
		return nil
	}
	if err := s.queries.SetUserPremium(ctx, username, true); err != nil {
		return fmt.Errorf("apply subscription activated: set premium: %w", err)
	}
	if s.kc != nil {
		if err := s.kc.AddUserToGroupByName(ctx, username, "premium"); err != nil {
			log.Printf("apply subscription activated: KC group add for %q: %v", username, err)
		}
	}
	action := "premium.granted"
	resourceType := "premium_subscription"
	resourceName := subscriptionID
	if err := s.queries.InsertAuditLog(ctx, db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         action,
		ResourceType:   &resourceType,
		ResourceID:     &id,
		ResourceName:   &resourceName,
	}); err != nil {
		log.Printf("apply subscription activated: audit log: %v", err)
	}
	return nil
}

// ExtendSubscriptionPeriod bumps a subscription's current_period_end on a
// recurring renewal charge (PAYMENT.SALE.COMPLETED). No grant/revoke side
// effects — the user is already premium and stays that way.
func (s *PaymentService) ExtendSubscriptionPeriod(ctx context.Context, subscriptionID string, nextBillingTime *time.Time) error {
	if err := s.queries.UpdateSubscriptionPeriod(ctx, subscriptionID, nextBillingTime); err != nil {
		return fmt.Errorf("extend subscription period: %w", err)
	}
	return nil
}

// RevokeSubscription marks a subscription cancelled/suspended/expired and
// applies the same revocation effects as a one-time-purchase refund
// (revokePremiumEffects) — used by the user-initiated cancel endpoint and by
// BILLING.SUBSCRIPTION.CANCELLED/.SUSPENDED/.EXPIRED webhooks. status must be
// one of premium_subscriptions' CHECK-constrained values.
func (s *PaymentService) RevokeSubscription(ctx context.Context, subscriptionID, status, reason string) error {
	id, username, err := s.queries.MarkSubscriptionStatus(ctx, subscriptionID, status)
	if err != nil {
		return fmt.Errorf("revoke subscription: mark status: %w", err)
	}
	if id == uuid.Nil {
		// Unknown subscription id — likely a duplicate/test webhook event.
		return nil
	}
	if err := s.revokePremiumEffects(ctx, username); err != nil {
		return fmt.Errorf("revoke subscription: %w", err)
	}
	action := "premium.revoked"
	resourceType := "premium_subscription"
	resourceName := reason
	if err := s.queries.InsertAuditLog(ctx, db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         action,
		ResourceType:   &resourceType,
		ResourceID:     &id,
		ResourceName:   &resourceName,
	}); err != nil {
		log.Printf("revoke subscription: audit log: %v", err)
	}
	return nil
}

// RevertSubscriptionAllocation undoes a sandbox subscription's local premium
// grant (revokePremiumEffects) without any PayPal call — the recurring
// counterpart to RevokePremiumAllocation for one-time sandbox orders: sandbox
// charges move fake money, so there's nothing to refund, only the local grant
// to undo. The subscription row is marked 'expired' locally; the PayPal-side
// sandbox subscription is left running (harmless — it isn't real money, and
// once the row is no longer active/suspended, ExtendSubscriptionPeriod's
// status guard makes future renewal webhooks for it silent no-ops instead of
// re-granting access).
//
// Logged as "premium_subscription.allocation_reverted", distinct from
// RevokeSubscription's "premium.revoked", so admin reverts stay
// distinguishable from real cancellations in the audit trail — mirrors
// applyAllocationRevert's own distinct action for one-time orders.
func (s *PaymentService) RevertSubscriptionAllocation(ctx context.Context, subscriptionID, actorUsername string) error {
	id, username, err := s.queries.MarkSubscriptionStatus(ctx, subscriptionID, "expired")
	if err != nil {
		return fmt.Errorf("revert subscription allocation: mark status: %w", err)
	}
	if id == uuid.Nil {
		// Unknown subscription id.
		return nil
	}
	if err := s.revokePremiumEffects(ctx, username); err != nil {
		return fmt.Errorf("revert subscription allocation: %w", err)
	}
	action := "premium_subscription.allocation_reverted"
	resourceType := "premium_subscription"
	resourceName := "manual"
	if err := s.queries.InsertAuditLog(ctx, db.AuditInput{
		TargetUsername: username,
		ActorUsername:  actorUsername,
		Action:         action,
		ResourceType:   &resourceType,
		ResourceID:     &id,
		ResourceName:   &resourceName,
	}); err != nil {
		log.Printf("revert subscription allocation: audit log: %v", err)
	}
	return nil
}
