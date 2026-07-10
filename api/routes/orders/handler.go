// Package orders serves the admin Orders page: a combined, searchable view of
// premium payments and storage add-on purchases, with a 90-day refund action.
package orders

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// PremiumRevoker is the subset of *services.PaymentService used to tear down
// premium access (KC group, API keys) when an order's or subscription's
// allocation is undone. Captured behind an interface so it stays
// swappable/testable independent of the concrete payment-service wiring.
type PremiumRevoker interface {
	RevokePremiumAllocation(ctx context.Context, username string) error
	RevokeSubscription(ctx context.Context, subscriptionID, status, reason string) error
	RevertSubscriptionAllocation(ctx context.Context, subscriptionID, actorUsername string) error
}

// refundWindowDays is how long after capture an order stays refundable.
const refundWindowDays = 90

// allocationRevertDays is how long a captured sandbox order can carry its
// quota/premium grant before the background loop (StartAllocationRevertLoop)
// reverts it automatically. The manual "Revert allocation" button has no
// window of its own — this is just the backstop for orders nobody clicked.
const allocationRevertDays = 7

// Querier is the subset of *db.Queries used by the orders handler.
type Querier interface {
	ListAdminOrders(ctx context.Context, search, sort string, limit, offset int) ([]db.AdminOrder, int, error)
	GetAdminOrder(ctx context.Context, orderType string, id uuid.UUID) (*db.AdminOrder, error)
	MarkPaymentRefundedByID(ctx context.Context, id uuid.UUID, refundID string) (bool, error)
	MarkStorageOrderRefunded(ctx context.Context, id uuid.UUID, refundID string) (bool, error)
	AddUserQuota(ctx context.Context, username string, bytesAdded int64) (int64, error)
	MarkPaymentAllocationReverted(ctx context.Context, id uuid.UUID) (bool, error)
	MarkStorageOrderAllocationReverted(ctx context.Context, id uuid.UUID) (bool, error)
	ListSandboxOrdersDueForAutoRevert(ctx context.Context, cutoff time.Time) ([]db.AdminOrder, error)
	InsertAuditLog(ctx context.Context, in db.AuditInput) error
	ListAdminSubscriptions(ctx context.Context, search, sort string, limit, offset int) ([]db.AdminSubscription, int, error)
	GetSubscriptionByID(ctx context.Context, id uuid.UUID) (*models.PremiumSubscription, error)
	MarkSubscriptionRefunded(ctx context.Context, id uuid.UUID, refundID string, refundAmountCents int) error
	MarkSubscriptionCancellationReason(ctx context.Context, id uuid.UUID, reason string) error
}

// Compile-time checks.
var _ Querier = (*db.Queries)(nil)
var _ PremiumRevoker = (*services.PaymentService)(nil)

// Handler wires the /api/v1/admin/orders endpoints.
type Handler struct {
	paypal     services.PayPalClients
	queries    Querier
	paymentSvc PremiumRevoker
}

func NewHandler(paypal services.PayPalClients, q Querier, paymentSvc PremiumRevoker) *Handler {
	return &Handler{paypal: paypal, queries: q, paymentSvc: paymentSvc}
}

// List returns searched, sorted, offset-paginated combined orders.
// GET /api/v1/admin/orders?search=&sort=&page=&page_size=
// sort: "date" (default) | "amount".
func (h *Handler) List(c *gin.Context) {
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "25"))
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}

	items, total, err := h.queries.ListAdminOrders(
		c.Request.Context(),
		strings.TrimSpace(c.Query("search")),
		c.Query("sort"),
		pageSize, (page-1)*pageSize,
	)
	if err != nil {
		log.Printf("orders List: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	if items == nil {
		items = []db.AdminOrder{}
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "total": total, "page": page, "page_size": pageSize})
}

// ListSubscriptions returns searched, sorted, offset-paginated premium
// subscriptions across all users — the admin Orders page's Subscriptions tab.
// GET /api/v1/admin/subscriptions?search=&sort=&page=&page_size=
// sort: "date" (default) | "amount".
func (h *Handler) ListSubscriptions(c *gin.Context) {
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "25"))
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}

	items, total, err := h.queries.ListAdminSubscriptions(
		c.Request.Context(),
		strings.TrimSpace(c.Query("search")),
		c.Query("sort"),
		pageSize, (page-1)*pageSize,
	)
	if err != nil {
		log.Printf("orders ListSubscriptions: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	if items == nil {
		items = []db.AdminSubscription{}
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "total": total, "page": page, "page_size": pageSize})
}

// CancelSubscription cancels an active/suspended subscription on PayPal's
// side and refunds the prorated remainder of its current billing period —
// the fraction of time left until current_period_end, valued against the
// subscription's per-cycle price. Stronger than the ordinary user-initiated
// self-service cancel (routes/payments), which stops future billing but
// issues no refund. Works for both live and sandbox subscriptions: a sandbox
// refund just moves fake money through the sandbox PayPal app, same as the
// Refund action above for one-time sandbox orders — see RevertSubscription-
// Allocation below for the no-PayPal-call sandbox alternative.
// The admin-supplied reason is required — it's persisted on the subscription
// row and, combined with the refund amount, surfaced to the cancelled user
// as a notification-bell item (see routes/me.go gatherNotificationItems).
// POST /api/v1/admin/subscriptions/:id/cancel
func (h *Handler) CancelSubscription(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	var body struct {
		Reason string `json:"reason" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "reason is required"})
		return
	}
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "reason is required"})
		return
	}

	sub, err := h.queries.GetSubscriptionByID(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "subscription not found"})
			return
		}
		log.Printf("orders CancelSubscription load: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load subscription"})
		return
	}
	if sub.Status != "active" && sub.Status != "suspended" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "subscription is not active"})
		return
	}

	// Use the environment the subscription was created against, not the
	// acting admin's own toggle state — cancellation/refund must land in the
	// same PayPal instance the money actually moved through.
	client := h.paypal.For(sub.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}

	var refundID string
	var refundCents int
	if sub.CurrentPeriodEnd != nil {
		refundCents = prorateRefundCents(sub.Plan, sub.AmountCents, *sub.CurrentPeriodEnd, time.Now())
		if refundCents > 0 {
			periodStart := subscriptionPeriodStart(sub.Plan, *sub.CurrentPeriodEnd)
			txs, txErr := client.ListSubscriptionTransactions(c.Request.Context(), sub.PayPalSubscriptionID, periodStart.Add(-48*time.Hour), time.Now())
			if txErr != nil {
				log.Printf("orders CancelSubscription list transactions: %v", txErr)
			}
			if saleID := latestCompletedSaleID(txs); saleID != "" {
				refund, err := client.RefundSale(c.Request.Context(), saleID, refundCents, sub.Currency)
				if err != nil {
					log.Printf("orders CancelSubscription paypal refund: %v", err)
					c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "refund failed"})
					return
				}
				refundID = refund.RefundID
			} else {
				// No completed billing-period transaction found (e.g. the
				// PayPal transactions API had nothing to report) — proceed
				// with cancellation but skip the refund rather than blocking
				// the admin's primary intent of stopping the subscription.
				log.Printf("orders CancelSubscription: no completed transaction found for %s, cancelling without refund", sub.PayPalSubscriptionID)
				refundCents = 0
			}
		}
	}

	if err := client.CancelSubscription(c.Request.Context(), sub.PayPalSubscriptionID, reason); err != nil {
		log.Printf("orders CancelSubscription paypal cancel: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "cancel failed"})
		return
	}

	if err := h.queries.MarkSubscriptionCancellationReason(c.Request.Context(), sub.ID, reason); err != nil {
		log.Printf("orders CancelSubscription mark reason: %v", err)
	}
	if refundID != "" {
		if err := h.queries.MarkSubscriptionRefunded(c.Request.Context(), sub.ID, refundID, refundCents); err != nil {
			log.Printf("orders CancelSubscription mark refunded: %v", err)
		}
	}

	auditReason := fmt.Sprintf("admin cancel: %s", reason)
	if refundID != "" {
		auditReason = fmt.Sprintf("admin cancel: %s (refunded $%d.%02d %s)", reason, refundCents/100, refundCents%100, sub.Currency)
	}
	if err := h.paymentSvc.RevokeSubscription(c.Request.Context(), sub.PayPalSubscriptionID, "cancelled", auditReason); err != nil {
		log.Printf("orders CancelSubscription revoke: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "revoke subscription"})
		return
	}

	var refundIDResp *string
	if refundID != "" {
		refundIDResp = &refundID
	}
	c.JSON(http.StatusOK, gin.H{"refund_id": refundIDResp, "refund_amount_cents": refundCents})
}

// RevertSubscriptionAllocation undoes the local premium grant of a sandbox
// subscription without contacting PayPal — mirrors RevertAllocation for
// one-time sandbox orders (sandbox charges move fake money, so there's
// nothing to refund, only the local grant to undo). Only available for
// sandbox subscriptions; live subscriptions must go through
// CancelSubscription, which issues a real prorated refund.
// POST /api/v1/admin/subscriptions/:id/revert-allocation
func (h *Handler) RevertSubscriptionAllocation(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	sub, err := h.queries.GetSubscriptionByID(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "subscription not found"})
			return
		}
		log.Printf("orders RevertSubscriptionAllocation load: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load subscription"})
		return
	}
	if sub.Environment != "sandbox" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "only sandbox subscriptions can have their allocation reverted"})
		return
	}
	if sub.Status != "active" && sub.Status != "suspended" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "subscription is not active"})
		return
	}

	actor := c.GetString("username")
	if err := h.paymentSvc.RevertSubscriptionAllocation(c.Request.Context(), sub.PayPalSubscriptionID, actor); err != nil {
		log.Printf("orders RevertSubscriptionAllocation: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "revert allocation"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// subscriptionPeriodStart estimates when the subscription's current billing
// period began, given its plan and PayPal-reported period end. Subscriptions
// only track current_period_end (PayPal's next_billing_time) — the period
// start isn't stored separately, so it's derived from the plan's fixed
// cadence (monthly/annual), which holds as long as the price/interval hasn't
// changed mid-subscription (true for this app's fixed plan pricing).
func subscriptionPeriodStart(plan string, periodEnd time.Time) time.Time {
	if plan == "annual" {
		return periodEnd.AddDate(-1, 0, 0)
	}
	return periodEnd.AddDate(0, -1, 0)
}

// prorateRefundCents computes an admin cancellation's refund: the fraction of
// the current billing period still remaining (now → current_period_end)
// times the subscription's per-cycle price, rounded to the nearest cent and
// clamped to [0, amountCents].
func prorateRefundCents(plan string, amountCents int, periodEnd, now time.Time) int {
	if !periodEnd.After(now) {
		return 0
	}
	periodStart := subscriptionPeriodStart(plan, periodEnd)
	total := periodEnd.Sub(periodStart)
	if total <= 0 {
		return 0
	}
	remaining := periodEnd.Sub(now)
	if remaining > total {
		remaining = total
	}
	cents := int(math.Round(float64(remaining) / float64(total) * float64(amountCents)))
	if cents > amountCents {
		cents = amountCents
	}
	if cents < 0 {
		cents = 0
	}
	return cents
}

// latestCompletedSaleID picks the most recent COMPLETED transaction from a
// ListSubscriptionTransactions result — the sale an admin cancellation's
// prorated refund is issued against. Returns "" if none completed (e.g. all
// declined/pending).
func latestCompletedSaleID(txs []services.SubscriptionTransaction) string {
	var latest services.SubscriptionTransaction
	found := false
	for _, t := range txs {
		if t.Status != "COMPLETED" {
			continue
		}
		if !found || t.Time.After(latest.Time) {
			latest = t
			found = true
		}
	}
	if !found {
		return ""
	}
	return latest.ID
}

// Refund refunds a captured order in full via PayPal. Premium refunds revoke
// the premium flag; storage refunds subtract the purchased quota. The refund
// window closes 90 days after capture.
// POST /api/v1/admin/orders/:type/:id/refund
func (h *Handler) Refund(c *gin.Context) {
	orderType := c.Param("type")
	if orderType != "premium" && orderType != "storage" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "type must be premium or storage"})
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	order, err := h.queries.GetAdminOrder(c.Request.Context(), orderType, id)
	if err != nil {
		log.Printf("orders Refund load: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load order"})
		return
	}
	if order == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	if order.Status != "captured" || order.PayPalCaptureID == nil {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "order is not refundable"})
		return
	}
	if order.CapturedAt == nil || time.Since(*order.CapturedAt) > refundWindowDays*24*time.Hour {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{
			"error": "refund window has closed (90 days after capture)",
		})
		return
	}

	// Use the environment the order was created against, not the acting
	// admin's own toggle state — refunds must land in the same PayPal
	// instance the money actually moved through.
	client := h.paypal.For(order.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	refund, err := client.RefundCapture(c.Request.Context(), *order.PayPalCaptureID, int(order.AmountCents), order.Currency)
	if err != nil {
		log.Printf("orders Refund paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "refund failed"})
		return
	}

	var applied bool
	if orderType == "premium" {
		applied, err = h.queries.MarkPaymentRefundedByID(c.Request.Context(), id, refund.RefundID)
	} else {
		applied, err = h.queries.MarkStorageOrderRefunded(c.Request.Context(), id, refund.RefundID)
	}
	if err != nil {
		log.Printf("orders Refund persist: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "record refund"})
		return
	}
	if applied {
		if orderType == "premium" {
			if err := h.paymentSvc.RevokePremiumAllocation(c.Request.Context(), order.Username); err != nil {
				log.Printf("orders Refund revoke premium: %v", err)
			}
		} else if order.BytesAdded > 0 {
			if _, err := h.queries.AddUserQuota(c.Request.Context(), order.Username, -order.BytesAdded); err != nil {
				log.Printf("orders Refund revert quota: %v", err)
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"refund_id": refund.RefundID})
}

// RevertAllocation undoes the storage/premium grant of a captured sandbox
// order without touching PayPal — sandbox captures move fake money, so
// there's nothing to refund, only the local allocation to undo. Deliberately
// kept separate from Refund (which issues a real PayPal refund) so the two
// stay independently triggerable. Orders nobody reverts manually are swept
// up by the 7-day auto-revert loop (see StartAllocationRevertLoop).
// POST /api/v1/admin/orders/:type/:id/revert-allocation
func (h *Handler) RevertAllocation(c *gin.Context) {
	orderType := c.Param("type")
	if orderType != "premium" && orderType != "storage" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "type must be premium or storage"})
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	order, err := h.queries.GetAdminOrder(c.Request.Context(), orderType, id)
	if err != nil {
		log.Printf("orders RevertAllocation load: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load order"})
		return
	}
	if order == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	if order.Environment != "sandbox" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "only sandbox orders can have their allocation reverted"})
		return
	}
	if order.Status != "captured" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "order is not captured"})
		return
	}
	if order.AllocationRevertedAt != nil {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "allocation already reverted"})
		return
	}

	actor := c.GetString("username")
	if err := h.applyAllocationRevert(c.Request.Context(), order, actor, "manual"); err != nil {
		log.Printf("orders RevertAllocation: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "revert allocation"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// applyAllocationRevert undoes a captured sandbox order's local grant —
// subtracting quota for a storage order, revoking premium for a payment —
// and records an audit entry. Used by both RevertAllocation (trigger
// "manual") and the auto-revert loop (trigger "auto:7-day") so the two are
// distinguishable in the user's audit history. Idempotent: if the order is
// no longer an eligible captured/unreverted sandbox row (already reverted by
// a concurrent call), the Mark* query reports no rows affected and this is a
// silent no-op.
func (h *Handler) applyAllocationRevert(ctx context.Context, order *db.AdminOrder, actorUsername, trigger string) error {
	var applied bool
	var err error
	if order.Type == "premium" {
		applied, err = h.queries.MarkPaymentAllocationReverted(ctx, order.ID)
	} else {
		applied, err = h.queries.MarkStorageOrderAllocationReverted(ctx, order.ID)
	}
	if err != nil {
		return err
	}
	if !applied {
		return nil
	}

	if order.Type == "premium" {
		if err := h.paymentSvc.RevokePremiumAllocation(ctx, order.Username); err != nil {
			log.Printf("orders applyAllocationRevert revoke premium: %v", err)
		}
	} else if order.BytesAdded > 0 {
		if _, err := h.queries.AddUserQuota(ctx, order.Username, -order.BytesAdded); err != nil {
			log.Printf("orders applyAllocationRevert subtract quota: %v", err)
		}
	}

	action := order.Type + ".allocation_reverted"
	resourceType := order.Type
	resourceID := order.ID
	resourceName := trigger
	if err := h.queries.InsertAuditLog(ctx, db.AuditInput{
		TargetUsername: order.Username,
		ActorUsername:  actorUsername,
		Action:         action,
		ResourceType:   &resourceType,
		ResourceID:     &resourceID,
		ResourceName:   &resourceName,
	}); err != nil {
		log.Printf("orders applyAllocationRevert audit log: %v", err)
	}
	return nil
}

// ── Background auto-revert loop ───────────────────────────────────────────────

// StartAllocationRevertLoop spawns a goroutine that, once an hour, auto-
// reverts any captured sandbox order whose allocation is still standing 7
// calendar days after capture — sandbox test purchases are expected to be
// cleaned up rather than left granting real quota/premium indefinitely.
// Mirrors expansion.Handler.StartExpiryLoop.
func (h *Handler) StartAllocationRevertLoop(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		log.Printf("orders: allocation-revert loop started")
		for {
			select {
			case <-ctx.Done():
				log.Printf("orders: allocation-revert loop stopped")
				return
			case <-ticker.C:
				h.processDueAllocationReverts(ctx)
			}
		}
	}()
}

// processDueAllocationReverts auto-reverts every captured sandbox order
// captured more than allocationRevertDays calendar days ago that hasn't
// already been reverted. The acting audit "actor" is the order's own owner,
// matching this codebase's convention for system-triggered reverts (e.g.
// expansion.processUnpaidBalances) — there is no admin behind the action.
func (h *Handler) processDueAllocationReverts(ctx context.Context) {
	cutoff := time.Now().AddDate(0, 0, -allocationRevertDays)
	due, err := h.queries.ListSandboxOrdersDueForAutoRevert(ctx, cutoff)
	if err != nil {
		log.Printf("orders: list due allocation reverts: %v", err)
		return
	}
	for i := range due {
		o := &due[i]
		if err := h.applyAllocationRevert(ctx, o, o.Username, "auto:7-day"); err != nil {
			log.Printf("orders: auto-revert %s %s: %v", o.Type, o.ID, err)
		}
	}
}
