package payments

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/middleware"
	"apollo-sfs.com/api/routes/services"
)

// subscriptionReconcileGraceDays is how far past a subscription's cached
// current_period_end the reconciliation loop waits before re-checking it
// against PayPal directly — a missed-webhook safety net, not the primary
// grant/revoke path.
const subscriptionReconcileGraceDays = 3

// Handler wires the /api/v1/payments/* endpoints. Held separately from the
// main routes Handler because the payments concern is fully self-contained
// (PayPal client, payment service, KC admin) and doesn't need to share
// state with the rest of the routes package.
type Handler struct {
	paypal  services.PayPalClients
	svc     *services.PaymentService
	queries Querier
	cfg     Config
}

// Config holds the plan ids + prices + payment-page URL needed to create
// PayPal subscriptions. AppBaseURL is used to derive return/cancel URLs.
// PlanIDs carries the live PayPal Billing Plan id per plan name
// ("monthly"|"annual"); SandboxPlanIDs carries the sandbox app's
// counterparts, selected when the caller's sandbox-payments toggle is on —
// mirrors the live/sandbox client split in services.PayPalClients. PlanPrices
// is display/record-keeping only (stamped onto the premium_subscriptions row
// for the orders page) — the actual charge amount is whatever the PayPal
// Plan itself was configured with; keep these in sync (see docs/paypal_setup.md).
type Config struct {
	AppBaseURL     string
	PlanIDs        map[string]string
	SandboxPlanIDs map[string]string
	PlanPrices     map[string]int
	Currency       string
	// GooglePaySubscriptionsEnabled allows google_pay as a self-billed
	// subscription funding source. Off by default: PayPal doesn't vault the
	// google_pay payment source (verified — Orders v2 ignores
	// payment_source.google_pay.attributes.vault), so the capture would come
	// back with no vault id and ConfirmSelfBilledOrder would refund it. The
	// frontend already hides the button; this stops a stale or hand-rolled
	// client taking a charge that can only ever be given back.
	// See docs/paypal_setup.md §10.
	GooglePaySubscriptionsEnabled bool
}

// PlanID resolves the PayPal Billing Plan id to use for the given plan name
// and environment. Returns "" if that plan/environment combination isn't
// configured.
func (c Config) PlanID(plan, env string) string {
	ids := c.PlanIDs
	if env == services.PayPalEnvSandbox {
		ids = c.SandboxPlanIDs
	}
	if ids == nil {
		return ""
	}
	return ids[plan]
}

// NewHandler constructs a payments Handler. paypal.Live/svc may be nil during
// local dev without PayPal credentials; the create-subscription endpoint then
// returns 503 (not configured).
func NewHandler(paypal services.PayPalClients, svc *services.PaymentService, q Querier, cfg Config) *Handler {
	return &Handler{paypal: paypal, svc: svc, queries: q, cfg: cfg}
}

// CreateSubscription is POST /api/v1/payments/subscriptions. Body: {plan:
// "monthly"|"annual"}. Refuses to create a new subscription if the caller
// already has one active/suspended, or is an admin with the sandbox-payments
// toggle off (their premium is implicit — same rule the old one-time flow
// used, now expressed against HasActivePremiumSubscription instead of the
// admin-always-true IsPremium flag).
func (h *Handler) CreateSubscription(c *gin.Context) {
	if h.svc == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	user, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	sandbox := middleware.SandboxEnabled(c)

	if user.PremiumPurchaseBlocked {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "premium purchases are restricted on this account"})
		return
	}

	subscribed, err := h.queries.HasActivePremiumSubscription(ctx, user.Username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "check subscription"})
		return
	}
	if subscribed || (user.IsAdmin && !sandbox) {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "already premium"})
		return
	}

	var req struct {
		Plan string `json:"plan" binding:"required,oneof=monthly annual"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	env := services.PayPalEnvLive
	if sandbox {
		env = services.PayPalEnvSandbox
	}
	client := h.paypal.For(env)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	planID := h.cfg.PlanID(req.Plan, env)
	if planID == "" {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "plan not configured"})
		return
	}

	// Clear out any abandoned checkout so it never blocks a retry.
	if err := h.queries.ExpireStalePendingSubscriptions(ctx, user.Username); err != nil {
		log.Printf("payments CreateSubscription expire stale: %v", err)
	}

	result, err := client.CreateSubscription(ctx, services.CreateSubscriptionInput{
		PlanID:    planID,
		ReturnURL: h.cfg.AppBaseURL + "/premium?status=approved",
		CancelURL: h.cfg.AppBaseURL + "/premium?status=cancelled",
	})
	if err != nil {
		log.Printf("payments CreateSubscription paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal error"})
		return
	}

	pending := &models.PremiumSubscription{
		Username:             user.Username,
		PayPalSubscriptionID: result.SubscriptionID,
		Plan:                 req.Plan,
		Environment:          env,
		AmountCents:          h.cfg.PlanPrices[req.Plan],
		Currency:             h.cfg.Currency,
		PaymentMethod:        "paypal",
	}
	if err := h.queries.CreatePendingSubscription(ctx, pending); err != nil {
		log.Printf("payments CreateSubscription persist: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "persist pending subscription"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"subscription_id": result.SubscriptionID,
		"approve_url":     result.ApproveURL,
	})
}

// ── Self-billed subscriptions (card / Apple Pay / Google Pay) ────────────────

// PayPal Subscriptions v1 can only ever be approved with the PayPal wallet —
// POST /v1/billing/subscriptions ignores `payment_source` outright, so a card
// or wallet cannot be bound to one. Those funding sources instead open a
// subscription we bill ourselves: an ordinary Orders v2 purchase for the first
// period that also vaults the payment method, after which
// SubscriptionRenewalLoop charges the saved token each period.
//
// The two endpoints below mirror the storage add-ons' create/capture pair,
// because every web payment surface works the same way — the server creates
// the order, the shopper's browser confirms it against PayPal (Apple Pay
// sheet, Google Pay sheet, or hosted card fields), and the server captures.
// No card data ever reaches us.

// CreateSelfBilledOrder is POST /api/v1/payments/subscriptions/wallet/order.
// Body: {plan: "monthly"|"annual", source: "card"|"apple_pay"|"google_pay"}.
// Creates the vaulting order for the first period and returns its PayPal order
// id for the browser to confirm. Nothing is granted or persisted here — the
// subscription only exists once ConfirmSelfBilledOrder captures.
func (h *Handler) CreateSelfBilledOrder(c *gin.Context) {
	if h.svc == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	user, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	var req struct {
		Plan   string `json:"plan" binding:"required,oneof=monthly annual"`
		Source string `json:"source" binding:"required,oneof=card apple_pay google_pay"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if h.rejectUnsupportedSource(c, req.Source) {
		return
	}
	ctx := c.Request.Context()
	client, env, ok := h.subscriptionPreflight(c, user)
	if !ok {
		return
	}
	price := h.cfg.PlanPrices[req.Plan]
	if price <= 0 {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "plan not configured"})
		return
	}
	result, err := client.CreateOrder(ctx, services.CreateOrderInput{
		AmountCents:   price,
		Currency:      h.cfg.Currency,
		PaymentMethod: req.Source,
		ReturnURL:     h.cfg.AppBaseURL + "/premium?status=approved",
		CancelURL:     h.cfg.AppBaseURL + "/premium?status=cancelled",
		Vault:         true,
	})
	if err != nil {
		log.Printf("payments CreateSelfBilledOrder paypal (env=%s): %v", env, err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal error"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"order_id":     result.OrderID,
		"amount_cents": price,
		"currency":     h.cfg.Currency,
	})
}

// ConfirmSelfBilledOrder is POST /api/v1/payments/subscriptions/wallet/confirm.
// Body: {order_id, plan, source}. Captures the first period, then opens the
// subscription against the payment method PayPal vaulted during that capture.
//
// A capture with no vault id is refunded rather than granted: the charge would
// otherwise buy a subscription that can never renew, silently expiring at the
// end of the first period.
func (h *Handler) ConfirmSelfBilledOrder(c *gin.Context) {
	if h.svc == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	user, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	var req struct {
		OrderID string `json:"order_id" binding:"required"`
		Plan    string `json:"plan" binding:"required,oneof=monthly annual"`
		Source  string `json:"source" binding:"required,oneof=card apple_pay google_pay"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if h.rejectUnsupportedSource(c, req.Source) {
		return
	}
	ctx := c.Request.Context()
	client, env, ok := h.subscriptionPreflight(c, user)
	if !ok {
		return
	}

	capture, err := client.CaptureOrder(ctx, req.OrderID)
	if err != nil {
		log.Printf("payments ConfirmSelfBilledOrder capture (env=%s): %v", env, err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "could not complete payment"})
		return
	}
	if capture.VaultID == "" {
		log.Printf("payments ConfirmSelfBilledOrder: capture %s has no vault id, refunding", capture.CaptureID)
		h.refundUngrantedCharge(ctx, client, capture, "no vault id returned")
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{
			"error": "your payment method could not be saved for renewals — it has been refunded, please try another method",
		})
		return
	}

	now := time.Now().UTC()
	periodEnd := services.PlanPeriodEnd(req.Plan, now)
	sub := &models.PremiumSubscription{
		Username:         user.Username,
		Plan:             req.Plan,
		Environment:      env,
		AmountCents:      capture.AmountCents,
		Currency:         capture.Currency,
		PaymentMethod:    req.Source,
		VaultID:          &capture.VaultID,
		VaultSource:      &req.Source,
		CurrentPeriodEnd: &periodEnd,
		LastCaptureID:    &capture.CaptureID,
	}
	if err := h.svc.ActivateSelfBilledSubscription(ctx, sub); err != nil {
		if errors.Is(err, db.ErrSubscriptionExists) {
			// Lost a race with another checkout (double-submit, second tab).
			// The charge bought nothing, so it goes straight back.
			h.refundUngrantedCharge(ctx, client, capture, "duplicate subscription")
			c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "already premium — the duplicate charge has been refunded"})
			return
		}
		log.Printf("payments ConfirmSelfBilledOrder activate: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "could not activate subscription"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"status":             "active",
		"subscription_id":    sub.PayPalSubscriptionID,
		"current_period_end": periodEnd,
	})
}

// refundUngrantedCharge returns money taken for a subscription that was never
// opened. Best-effort and logged loudly on failure — a stuck charge here needs
// a human, but the request it belongs to has already failed either way.
func (h *Handler) refundUngrantedCharge(ctx context.Context, client *services.PayPalClient, capture *services.CaptureOrderResult, reason string) {
	if _, err := client.RefundCapture(ctx, capture.CaptureID, capture.AmountCents, capture.Currency); err != nil {
		log.Printf("payments: REFUND FAILED for ungranted capture %s (%s): %v — needs manual refund",
			capture.CaptureID, reason, err)
	}
}

// subscriptionPreflight applies the checks every subscription-opening request
// shares — purchase not blocked, no existing live subscription, a configured
// PayPal client for the caller's environment — and resolves that client.
// Mirrors CreateSubscription's guards so the self-billed path can't be used to
// sidestep them.
// rejectUnsupportedSource blocks funding sources that can't back a self-billed
// subscription, before any money moves.
func (h *Handler) rejectUnsupportedSource(c *gin.Context, source string) bool {
	if source == services.VaultSourceGooglePay && !h.cfg.GooglePaySubscriptionsEnabled {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
			"error": "google pay is not available for subscriptions — please use another payment method",
		})
		return true
	}
	return false
}

func (h *Handler) subscriptionPreflight(c *gin.Context, user *models.User) (*services.PayPalClient, string, bool) {
	ctx := c.Request.Context()
	sandbox := middleware.SandboxEnabled(c)

	if user.PremiumPurchaseBlocked {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "premium purchases are restricted on this account"})
		return nil, "", false
	}
	subscribed, err := h.queries.HasActivePremiumSubscription(ctx, user.Username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "check subscription"})
		return nil, "", false
	}
	if subscribed || (user.IsAdmin && !sandbox) {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "already premium"})
		return nil, "", false
	}
	env := services.PayPalEnvLive
	if sandbox {
		env = services.PayPalEnvSandbox
	}
	client := h.paypal.For(env)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return nil, "", false
	}
	return client, env, true
}

// ConfirmSubscription is POST /api/v1/payments/subscriptions/:id/confirm.
// Called by the frontend right after the PayPal approval redirect, as a
// latency shortcut — BILLING.SUBSCRIPTION.ACTIVATED is the durable source of
// truth and will also apply the grant if this call is missed entirely, since
// ApplySubscriptionActivated is idempotent.
func (h *Handler) ConfirmSubscription(c *gin.Context) {
	if h.svc == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username := c.GetString("username")
	if username == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	subID := c.Param("id")
	if subID == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "subscription id required"})
		return
	}
	ctx := c.Request.Context()
	sub, err := h.queries.GetSubscriptionByPayPalID(ctx, subID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "subscription not found"})
		return
	}
	if sub.Username != username {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "subscription does not belong to user"})
		return
	}
	client := h.paypal.For(sub.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	details, err := client.GetSubscription(ctx, subID)
	if err != nil {
		log.Printf("payments ConfirmSubscription paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal error"})
		return
	}
	if details.Status == "ACTIVE" {
		if err := h.svc.ApplySubscriptionActivated(ctx, subID, details.NextBillingTime, nil); err != nil {
			log.Printf("payments ConfirmSubscription apply: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "apply subscription"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"status": details.Status})
}

// CancelSubscription is POST /api/v1/payments/subscriptions/cancel. Cancels
// the caller's own active/suspended subscription — no body. Per product
// decision, cancelling immediately triggers the same revocation as a natural
// expiration (API keys, file-server links, Keycloak group) rather than
// running out the remaining paid period.
func (h *Handler) CancelSubscription(c *gin.Context) {
	if h.svc == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username := c.GetString("username")
	if username == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	ctx := c.Request.Context()
	sub, err := h.queries.GetActiveSubscriptionForUser(ctx, username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load subscription"})
		return
	}
	if sub == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "no active subscription"})
		return
	}
	client := h.paypal.For(sub.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	// A self-billed subscription has no PayPal subscription to cancel — the
	// recurring charge is our renewal loop, and clearing next_charge_at (via
	// the revoke below) is what stops it. The saved payment method is left in
	// PayPal's vault: deleting it needs the Vault API, which isn't enabled on
	// the app (see docs/paypal_setup.md §9). It is never charged again.
	if sub.BillingMode != "self" {
		if err := client.CancelSubscription(ctx, sub.PayPalSubscriptionID, "user requested cancellation"); err != nil {
			log.Printf("payments CancelSubscription paypal: %v", err)
			c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal error"})
			return
		}
	}
	if err := h.svc.RevokeSubscription(ctx, sub.PayPalSubscriptionID, "cancelled", "user requested cancellation"); err != nil {
		log.Printf("payments CancelSubscription revoke: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "revoke subscription"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "cancelled"})
}

// subscriptionOrderResponse is one item of ListMySubscriptions' response —
// shaped like billing.AdminOrder's fields (amount_cents, currency,
// payment_method, reference/invoice-style string, environment) so the client
// orders page can render subscriptions the same way as payments/storage
// orders, plus the subscription-specific current_period_end.
type subscriptionOrderResponse struct {
	ID               string     `json:"id"`
	Plan             string     `json:"plan"`
	Status           string     `json:"status"`
	Environment      string     `json:"environment"`
	AmountCents      int        `json:"amount_cents"`
	Currency         string     `json:"currency"`
	PaymentMethod    string     `json:"payment_method"`
	Reference        string     `json:"reference"`
	CurrentPeriodEnd *time.Time `json:"current_period_end"`
	CancelledAt      *time.Time `json:"cancelled_at"`
	CreatedAt        time.Time  `json:"created_at"`
}

// ListMySubscriptions is GET /api/v1/payments/subscriptions. Returns every
// subscription the caller has ever created (including cancelled/expired/
// abandoned ones), newest first — backs the "Premium" tab on the client
// orders page.
func (h *Handler) ListMySubscriptions(c *gin.Context) {
	username := c.GetString("username")
	if username == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	subs, err := h.queries.ListSubscriptionsForUser(c.Request.Context(), username)
	if err != nil {
		log.Printf("payments ListMySubscriptions: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list subscriptions"})
		return
	}
	items := make([]subscriptionOrderResponse, 0, len(subs))
	for _, s := range subs {
		items = append(items, subscriptionOrderResponse{
			ID:               s.ID.String(),
			Plan:             s.Plan,
			Status:           s.Status,
			Environment:      s.Environment,
			AmountCents:      s.AmountCents,
			Currency:         s.Currency,
			PaymentMethod:    s.PaymentMethod,
			Reference:        s.Reference,
			CurrentPeriodEnd: s.CurrentPeriodEnd,
			CancelledAt:      s.CancelledAt,
			CreatedAt:        s.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// Webhook is POST /api/v1/payments/webhook. NO auth middleware — the
// caller is PayPal. Authenticity is enforced by verify-webhook-signature,
// tried against the live client first and the sandbox client as a fallback
// (each carries its own PAYPAL_WEBHOOK_ID / PAYPAL_SANDBOX_WEBHOOK_ID) so
// both live traffic and an admin's sandbox testing verify correctly against
// the same public endpoint.
//
// Handles both the legacy one-time Orders v2 events (PAYMENT.CAPTURE.* —
// still used by storage add-ons' payments/storage_orders flow, which shares
// this endpoint) and the premium subscription events
// (BILLING.SUBSCRIPTION.ACTIVATED/.CANCELLED/.SUSPENDED/.EXPIRED,
// PAYMENT.SALE.COMPLETED for renewals).
func (h *Handler) Webhook(c *gin.Context) {
	if (h.paypal.Live == nil && h.paypal.Sandbox == nil) || h.svc == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "read body"})
		return
	}
	var ok bool
	if h.paypal.Live != nil {
		ok, err = h.paypal.Live.VerifyWebhook(c.Request.Context(), c.Request.Header, raw)
	}
	if (!ok || err != nil) && h.paypal.Sandbox != nil {
		ok, err = h.paypal.Sandbox.VerifyWebhook(c.Request.Context(), c.Request.Header, raw)
	}
	if err != nil || !ok {
		log.Printf("payments Webhook verify: ok=%v err=%v", ok, err)
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "webhook signature invalid"})
		return
	}
	var envelope struct {
		EventType string `json:"event_type"`
		Resource  struct {
			ID                 string `json:"id"`
			BillingAgreementID string `json:"billing_agreement_id"` // PAYMENT.SALE.COMPLETED
			SupplementaryData  struct {
				RelatedIDs struct {
					OrderID string `json:"order_id"`
				} `json:"related_ids"`
			} `json:"supplementary_data"`
			BillingInfo struct {
				NextBillingTime *time.Time `json:"next_billing_time"`
			} `json:"billing_info"` // BILLING.SUBSCRIPTION.ACTIVATED
		} `json:"resource"`
	}
	if err := decodeJSON(raw, &envelope); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "bad event payload"})
		return
	}
	ctx := c.Request.Context()
	switch envelope.EventType {
	case "PAYMENT.CAPTURE.COMPLETED":
		// resource.id = capture_id; related_ids.order_id = order_id. Only
		// matches a row when it's a storage-order-era premium purchase —
		// harmless no-op for storage_orders-backed captures (see ApplyCapture).
		orderID := envelope.Resource.SupplementaryData.RelatedIDs.OrderID
		if orderID == "" {
			log.Printf("payments Webhook: COMPLETED without order_id")
			c.Status(http.StatusOK)
			return
		}
		if err := h.svc.ApplyCapture(ctx, orderID, envelope.Resource.ID, raw); err != nil {
			log.Printf("payments Webhook ApplyCapture: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "apply"})
			return
		}
	case "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "PAYMENT.CAPTURE.DENIED":
		if err := h.svc.RevokePremium(ctx, envelope.Resource.ID, envelope.EventType); err != nil {
			log.Printf("payments Webhook RevokePremium: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "revoke"})
			return
		}
	case "BILLING.SUBSCRIPTION.ACTIVATED":
		subID := envelope.Resource.ID
		if err := h.svc.ApplySubscriptionActivated(ctx, subID, envelope.Resource.BillingInfo.NextBillingTime, raw); err != nil {
			log.Printf("payments Webhook ApplySubscriptionActivated: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "apply"})
			return
		}
	case "PAYMENT.SALE.COMPLETED":
		// Renewal charge. Re-fetch the subscription from PayPal for its fresh
		// next_billing_time rather than trusting anything in this payload.
		subID := envelope.Resource.BillingAgreementID
		if subID == "" {
			c.Status(http.StatusOK)
			return
		}
		sub, err := h.queries.GetSubscriptionByPayPalID(ctx, subID)
		if err != nil {
			log.Printf("payments Webhook: SALE.COMPLETED for unknown subscription %q: %v", subID, err)
			c.Status(http.StatusOK)
			return
		}
		client := h.paypal.For(sub.Environment)
		if client == nil {
			c.Status(http.StatusOK)
			return
		}
		details, err := client.GetSubscription(ctx, subID)
		if err != nil {
			log.Printf("payments Webhook: get subscription %q after renewal: %v", subID, err)
			c.Status(http.StatusOK)
			return
		}
		if err := h.svc.ExtendSubscriptionPeriod(ctx, subID, details.NextBillingTime); err != nil {
			log.Printf("payments Webhook ExtendSubscriptionPeriod: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "extend"})
			return
		}
	case "BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.SUSPENDED", "BILLING.SUBSCRIPTION.EXPIRED":
		status := map[string]string{
			"BILLING.SUBSCRIPTION.CANCELLED": "cancelled",
			"BILLING.SUBSCRIPTION.SUSPENDED": "suspended",
			"BILLING.SUBSCRIPTION.EXPIRED":   "expired",
		}[envelope.EventType]
		if err := h.svc.RevokeSubscription(ctx, envelope.Resource.ID, status, envelope.EventType); err != nil {
			log.Printf("payments Webhook RevokeSubscription: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "revoke"})
			return
		}
	default:
		// Unhandled event types are ack'd to stop PayPal from retrying.
	}
	c.Status(http.StatusOK)
}

// ── Background reconciliation loop ───────────────────────────────────────────

// StartSubscriptionReconcileLoop spawns a goroutine that, once an hour,
// re-checks "active" subscriptions whose cached current_period_end is more
// than subscriptionReconcileGraceDays past due directly against PayPal — a
// safety net for a missed BILLING.SUBSCRIPTION.* or PAYMENT.SALE.COMPLETED
// webhook delivery. Mirrors orders.Handler.StartAllocationRevertLoop.
func (h *Handler) StartSubscriptionReconcileLoop(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		log.Printf("payments: subscription-reconcile loop started")
		for {
			select {
			case <-ctx.Done():
				log.Printf("payments: subscription-reconcile loop stopped")
				return
			case <-ticker.C:
				h.reconcilePastDueSubscriptions(ctx)
			}
		}
	}()
}

func (h *Handler) reconcilePastDueSubscriptions(ctx context.Context) {
	cutoff := time.Now().AddDate(0, 0, -subscriptionReconcileGraceDays)
	due, err := h.queries.ListPastDueActiveSubscriptions(ctx, cutoff)
	if err != nil {
		log.Printf("payments: list past-due subscriptions: %v", err)
		return
	}
	for i := range due {
		sub := &due[i]
		client := h.paypal.For(sub.Environment)
		if client == nil {
			continue
		}
		details, err := client.GetSubscription(ctx, sub.PayPalSubscriptionID)
		if err != nil {
			log.Printf("payments: reconcile %q: %v", sub.PayPalSubscriptionID, err)
			continue
		}
		switch details.Status {
		case "ACTIVE":
			// A renewal webhook was likely missed but the subscription is
			// still genuinely active on PayPal's side — self-heal the period.
			if err := h.svc.ExtendSubscriptionPeriod(ctx, sub.PayPalSubscriptionID, details.NextBillingTime); err != nil {
				log.Printf("payments: reconcile extend %q: %v", sub.PayPalSubscriptionID, err)
			}
		case "CANCELLED", "SUSPENDED", "EXPIRED":
			status := map[string]string{"CANCELLED": "cancelled", "SUSPENDED": "suspended", "EXPIRED": "expired"}[details.Status]
			if err := h.svc.RevokeSubscription(ctx, sub.PayPalSubscriptionID, status, "reconcile:missed-webhook"); err != nil {
				log.Printf("payments: reconcile revoke %q: %v", sub.PayPalSubscriptionID, err)
			}
		}
	}
}

// loadCurrentUser pulls the username from the gin context (set by
// RequireAuth) and fetches the user row via Querier.GetUserByUsername.
func (h *Handler) loadCurrentUser(c *gin.Context) (*models.User, bool) {
	username := c.GetString("username")
	if username == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return nil, false
	}
	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load user"})
		return nil, false
	}
	return user, true
}

// decodeJSON wraps json.Unmarshal so the import is local to this file.
func decodeJSON(raw []byte, dst any) error {
	return jsonUnmarshal(raw, dst)
}
