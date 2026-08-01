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

// ExpireAdminGrantedPremium revokes premium access for every user whose
// admin-granted Premium trial (users.premium_expires_at, set by the admin
// Users page's role editor) has lapsed. Real PayPal subscriptions are never
// touched here — ListExpiredPremiumGrants excludes anyone with an
// active/suspended subscription row of their own. Errors for one user are
// logged and do not stop the sweep from continuing to the next.
func (s *PaymentService) ExpireAdminGrantedPremium(ctx context.Context) error {
	usernames, err := s.queries.ListExpiredPremiumGrants(ctx, time.Now())
	if err != nil {
		return fmt.Errorf("expire admin granted premium: list: %w", err)
	}
	for _, username := range usernames {
		if err := s.RevokePremiumAllocation(ctx, username); err != nil {
			log.Printf("expire admin granted premium: revoke %q: %v", username, err)
			continue
		}
		if err := s.queries.SetPremiumExpiry(ctx, username, nil); err != nil {
			log.Printf("expire admin granted premium: clear expiry %q: %v", username, err)
		}
		if err := s.queries.InsertRoleChangeNotification(ctx, db.InsertRoleChangeNotificationParams{
			Username: username, ChangedBy: "system", PreviousRole: "premium", NewRole: "user",
			Reason: "Premium trial expired",
		}); err != nil {
			log.Printf("expire admin granted premium: notification %q: %v", username, err)
		}
	}
	return nil
}

// PremiumExpiryLoop runs ExpireAdminGrantedPremium on a fixed interval until
// ctx is cancelled. Started once from main.go next to the other periodic
// background loops (allocation revert, reconciliation).
func (s *PaymentService) PremiumExpiryLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.ExpireAdminGrantedPremium(ctx); err != nil {
				log.Printf("PremiumExpiryLoop: %v", err)
			}
		}
	}
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

// ActivateSelfBilledSubscription records a subscription funded by a vaulted
// card or wallet and grants premium. The opening period has already been
// captured by the time this runs, so unlike the PayPal-managed flow there is
// no approval-pending step and no activation webhook to wait for — this is the
// grant.
//
// Returns db.ErrSubscriptionExists if the user already holds a live
// subscription; the caller should refund the charge it just took, since no
// access is granted for it.
func (s *PaymentService) ActivateSelfBilledSubscription(ctx context.Context, sub *models.PremiumSubscription) error {
	if err := s.queries.CreateSelfBilledSubscription(ctx, sub); err != nil {
		return err
	}
	if err := s.queries.SetUserPremium(ctx, sub.Username, true); err != nil {
		return fmt.Errorf("activate self-billed subscription: set premium: %w", err)
	}
	if s.kc != nil {
		if err := s.kc.AddUserToGroupByName(ctx, sub.Username, "premium"); err != nil {
			log.Printf("activate self-billed subscription: KC group add for %q: %v", sub.Username, err)
		}
	}
	resourceType := "premium_subscription"
	resourceName := sub.PayPalSubscriptionID
	if err := s.queries.InsertAuditLog(ctx, db.AuditInput{
		TargetUsername: sub.Username,
		ActorUsername:  sub.Username,
		Action:         "premium.granted",
		ResourceType:   &resourceType,
		ResourceID:     &sub.ID,
		ResourceName:   &resourceName,
	}); err != nil {
		log.Printf("activate self-billed subscription: audit log: %v", err)
	}
	return nil
}

// ── Self-billed renewals ─────────────────────────────────────────────────────

// Renewal policy for self-billed subscriptions. PayPal isn't billing these, so
// the whole dunning cycle is ours: a declined card gets a few spaced retries
// with access left intact, then access is revoked and the subscription
// cancelled outright rather than left in limbo.
const (
	// selfBilledRenewalBatch caps how many subscriptions one pass will try, so
	// a backlog is worked through over several ticks instead of one long burst
	// of PayPal calls.
	selfBilledRenewalBatch = 50
	// selfBilledMaxAttempts is the total number of charge attempts for one
	// period, the first included. After the last one fails, access is revoked.
	selfBilledMaxAttempts = 4
)

// nextRenewalAttempt decides what happens after a declined renewal, given how
// many consecutive failures the subscription has now had (this one included).
// Retries are spaced roughly a day, then three, then five — long enough for an
// expired card to be replaced or a balance topped up, without leaving unpaid
// access open for weeks. Once the attempts are exhausted the caller revokes.
func nextRenewalAttempt(failedCount int) (delay time.Duration, giveUp bool) {
	if failedCount >= selfBilledMaxAttempts {
		return 0, true
	}
	switch failedCount {
	case 1:
		return 24 * time.Hour, false
	case 2:
		return 72 * time.Hour, false
	default:
		return 120 * time.Hour, false
	}
}

// renewalPeriodStart is when the period being renewed should be measured from.
// Normally that's the period that just ended, not the moment the charge
// happens — otherwise a renewal retried three days late would push the billing
// date three days later every time it hiccuped, and a subscription that failed
// a few times a year would drift off its anniversary.
//
// The exception is a period end so far in the past that extending from it
// wouldn't even reach the present (a subscription resurrected after a long
// outage): billing from `now` avoids handing out a period that has already
// elapsed.
func renewalPeriodStart(plan string, periodEnd *time.Time, now time.Time) time.Time {
	if periodEnd == nil {
		return now
	}
	if PlanPeriodEnd(plan, *periodEnd).Before(now) {
		return now
	}
	return *periodEnd
}

// PlanPeriodEnd returns when a plan's period starting at `from` ends. Self-
// billed subscriptions have no PayPal-side schedule, so this is the only
// source of truth for when the next charge is due.
func PlanPeriodEnd(plan string, from time.Time) time.Time {
	if plan == "annual" {
		return from.AddDate(1, 0, 0)
	}
	return from.AddDate(0, 1, 0)
}

// PayPalChargeClient is the slice of PayPalClient the renewal loop needs,
// behind an interface so tests can drive the dunning cycle without HTTP.
type PayPalChargeClient interface {
	ChargeVaulted(ctx context.Context, vaultID string, amountCents int, currency string) (*CaptureOrderResult, error)
}

// PayPalChargeClients resolves the charge client for a subscription's
// environment — the live/sandbox split, same as PayPalClients.For.
type PayPalChargeClients interface {
	ChargeClientFor(env string) PayPalChargeClient
}

// SubscriptionRenewalLoop charges due self-billed subscriptions on a fixed
// interval until ctx is cancelled. Started from main.go alongside the other
// background loops.
//
// The interval only sets how often the loop looks for work; what makes a
// subscription due is its own next_charge_at, so a missed tick (restart,
// downtime) delays a renewal rather than skipping it.
func (s *PaymentService) SubscriptionRenewalLoop(ctx context.Context, clients PayPalChargeClients, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.RunDueRenewals(ctx, clients); err != nil {
				log.Printf("subscription renewal loop: %v", err)
			}
		}
	}
}

// RunDueRenewals charges every self-billed subscription whose next charge is
// due. One subscription's failure never stops the pass.
func (s *PaymentService) RunDueRenewals(ctx context.Context, clients PayPalChargeClients) error {
	due, err := s.queries.ListDueSelfBilledSubscriptions(ctx, time.Now().UTC(), selfBilledRenewalBatch)
	if err != nil {
		return fmt.Errorf("list due renewals: %w", err)
	}
	for i := range due {
		if err := s.renewOne(ctx, clients, &due[i]); err != nil {
			log.Printf("renew subscription %s (user %s): %v", due[i].ID, due[i].Username, err)
		}
	}
	return nil
}

// renewOne charges one subscription's next period, applying the dunning policy
// on failure.
func (s *PaymentService) renewOne(ctx context.Context, clients PayPalChargeClients, sub *models.PremiumSubscription) error {
	if sub.VaultID == nil || *sub.VaultID == "" {
		// The schema forbids this, so treat it as data corruption rather than
		// retrying forever against a token that doesn't exist.
		return s.failRenewalTerminally(ctx, sub, "subscription has no saved payment method")
	}
	client := clients.ChargeClientFor(sub.Environment)
	if client == nil {
		// Credentials for this environment are missing right now (e.g. the
		// sandbox app is unconfigured). Leave the row due and try next tick
		// rather than counting it against the shopper's retry budget.
		return fmt.Errorf("no paypal client for environment %q", sub.Environment)
	}

	capture, err := client.ChargeVaulted(ctx, *sub.VaultID, sub.AmountCents, sub.Currency)
	if err != nil {
		return s.handleRenewalFailure(ctx, sub, err.Error())
	}
	if capture.Status != "COMPLETED" {
		return s.handleRenewalFailure(ctx, sub, "charge status "+capture.Status)
	}

	from := renewalPeriodStart(sub.Plan, sub.CurrentPeriodEnd, time.Now().UTC())
	if err := s.queries.RecordSelfBilledRenewal(ctx, sub.ID, PlanPeriodEnd(sub.Plan, from), capture.CaptureID); err != nil {
		// The money is taken but the period wasn't extended — the next tick
		// would charge again, so this must be loud.
		return fmt.Errorf("CHARGED %s BUT FAILED TO RECORD RENEWAL: %w", capture.CaptureID, err)
	}
	// A subscription suspended by earlier failures is live again, so restore
	// the access those failures revoked.
	if sub.Status == "suspended" {
		if err := s.queries.SetUserPremium(ctx, sub.Username, true); err != nil {
			log.Printf("renew: restore premium for %q: %v", sub.Username, err)
		}
		if s.kc != nil {
			if err := s.kc.AddUserToGroupByName(ctx, sub.Username, "premium"); err != nil {
				log.Printf("renew: KC group add for %q: %v", sub.Username, err)
			}
		}
	}
	return nil
}

// handleRenewalFailure books a declined renewal and either schedules another
// attempt or gives up and revokes access.
func (s *PaymentService) handleRenewalFailure(ctx context.Context, sub *models.PremiumSubscription, reason string) error {
	failed := sub.FailedChargeCount + 1
	delay, giveUp := nextRenewalAttempt(failed)
	if giveUp {
		return s.failRenewalTerminally(ctx, sub, reason)
	}
	retryAt := time.Now().UTC().Add(delay)
	if _, err := s.queries.RecordSelfBilledChargeFailure(ctx, sub.ID, reason, &retryAt); err != nil {
		return err
	}
	log.Printf("renewal declined for %s (attempt %d/%d): %s — retrying %s",
		sub.Username, failed, selfBilledMaxAttempts, reason, retryAt.Format(time.RFC3339))
	return nil
}

// failRenewalTerminally ends a subscription that has exhausted its retries:
// the row is cancelled (which clears next_charge_at, so the loop drops it) and
// premium is revoked exactly as an ordinary cancellation would.
func (s *PaymentService) failRenewalTerminally(ctx context.Context, sub *models.PremiumSubscription, reason string) error {
	if _, err := s.queries.RecordSelfBilledChargeFailure(ctx, sub.ID, reason, nil); err != nil {
		return err
	}
	if err := s.queries.MarkSelfBilledStatus(ctx, sub.ID, "cancelled"); err != nil {
		return err
	}
	if err := s.revokePremiumEffects(ctx, sub.Username); err != nil {
		return fmt.Errorf("revoke after failed renewals: %w", err)
	}
	log.Printf("subscription %s cancelled for %s after %d failed renewals: %s",
		sub.ID, sub.Username, selfBilledMaxAttempts, reason)
	resourceType := "premium_subscription"
	resourceName := sub.PayPalSubscriptionID
	if err := s.queries.InsertAuditLog(ctx, db.AuditInput{
		TargetUsername: sub.Username,
		ActorUsername:  sub.Username,
		Action:         "premium.revoked",
		ResourceType:   &resourceType,
		ResourceID:     &sub.ID,
		ResourceName:   &resourceName,
	}); err != nil {
		log.Printf("failed renewal: audit log: %v", err)
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
