package services

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"

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

// RevokePremium is the inverse: called from the webhook handler when
// PayPal reports a refund or dispute. Flips users.is_premium false,
// removes the user from the KC premium group, and revokes every active
// API key the user owned (which would otherwise outlive their premium
// status and continue authorising SFS requests).
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
	user, err := s.queries.GetUserByUsername(ctx, payment.Username)
	if err != nil {
		return fmt.Errorf("revoke premium: load user: %w", err)
	}
	// Admins keep their implicit premium access — only clear the flag for
	// non-admin accounts. Admins also stay in the KC premium group if they
	// were explicitly added there, but the DB flag for them is recomputed
	// from is_admin on every JWT refresh, so leaving it alone is fine too.
	if !user.IsAdmin {
		if err := s.queries.SetUserPremium(ctx, payment.Username, false); err != nil {
			return fmt.Errorf("revoke premium: clear flag: %w", err)
		}
		if s.kc != nil {
			if err := s.kc.RemoveUserFromGroupByName(ctx, payment.Username, "premium"); err != nil {
				log.Printf("revoke premium: KC group remove for %q: %v", payment.Username, err)
			}
		}
	}
	if err := s.queries.RevokeAllAPIKeysForUser(ctx, payment.Username); err != nil {
		return fmt.Errorf("revoke premium: revoke api keys: %w", err)
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
