package payments

import (
	"io"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/middleware"
	"apollo-sfs.com/api/routes/services"
)

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

// Config holds the price + payment-page URLs needed to construct PayPal
// orders. AppBaseURL is used to derive return/cancel URLs.
type Config struct {
	AmountCents int
	Currency    string
	AppBaseURL  string
}

// NewHandler constructs a payments Handler. paypal.Live/svc may be nil during
// local dev without PayPal credentials; the create-order endpoint then
// returns 503 (not configured).
func NewHandler(paypal services.PayPalClients, svc *services.PaymentService, q Querier, cfg Config) *Handler {
	return &Handler{paypal: paypal, svc: svc, queries: q, cfg: cfg}
}

// resolveOrderClient validates that the caller isn't already premium and
// returns the PayPal client + environment string to create a new order
// against. Shared by CreateOrder (single funding source, chosen up front) and
// CreateWalletOrder (generic, funding source chosen at approval time).
// Admins are treated as already premium too, UNLESS their sandbox-payments
// toggle is on, in which case the premium checkout is deliberately left
// testable. Writes the error response itself and returns ok=false on
// failure; callers should return immediately.
func (h *Handler) resolveOrderClient(c *gin.Context, user *models.User) (client *services.PayPalClient, env string, ok bool) {
	sandbox := middleware.SandboxEnabled(c)
	if user.IsPremium || (user.IsAdmin && !sandbox) {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "already premium"})
		return nil, "", false
	}
	env = services.PayPalEnvLive
	if sandbox {
		env = services.PayPalEnvSandbox
	}
	client = h.paypal.For(env)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return nil, "", false
	}
	return client, env, true
}

// CreateOrder is POST /api/v1/payments/orders. Body: {payment_method}.
// Locks the resulting order to a single funding source chosen up front —
// used by the legacy full-page-redirect premium checkout (/premium route).
// Refuses to create a new order if the user is already premium — avoids
// double-charging from a stale browser tab.
func (h *Handler) CreateOrder(c *gin.Context) {
	if h.svc == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	user, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	client, env, ok := h.resolveOrderClient(c, user)
	if !ok {
		return
	}
	var req struct {
		PaymentMethod string `json:"payment_method" binding:"required,oneof=apple_pay card"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	order, err := client.CreateOrder(c.Request.Context(), services.CreateOrderInput{
		AmountCents:   h.cfg.AmountCents,
		Currency:      h.cfg.Currency,
		PaymentMethod: req.PaymentMethod,
		ReturnURL:     h.cfg.AppBaseURL + "/premium?status=approved",
		CancelURL:     h.cfg.AppBaseURL + "/premium?status=cancelled",
	})
	if err != nil {
		log.Printf("payments CreateOrder paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal error"})
		return
	}
	pending := &models.Payment{
		Username:      user.Username,
		PayPalOrderID: order.OrderID,
		AmountCents:   h.cfg.AmountCents,
		Currency:      h.cfg.Currency,
		PaymentMethod: req.PaymentMethod,
		Environment:   env,
	}
	if err := h.svc.CreatePending(c.Request.Context(), pending); err != nil {
		log.Printf("payments CreateOrder persist: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "persist pending payment"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"order_id":    order.OrderID,
		"approve_url": order.ApproveURL,
	})
}

// CreateWalletOrder is POST /api/v1/payments/orders/wallet. No body — unlike
// CreateOrder, the resulting order carries no payment_source restriction, so
// it works with the PayPal wallet button, Google Pay, and hosted card fields
// against the same order (mirrors billing.CreateWalletOrder, used for
// storage add-ons). Backs the embedded premium checkout modal. Capture goes
// through the existing CaptureOrder endpoint below, which is agnostic to how
// the order was created.
func (h *Handler) CreateWalletOrder(c *gin.Context) {
	if h.svc == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	user, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	client, env, ok := h.resolveOrderClient(c, user)
	if !ok {
		return
	}
	order, err := client.CreateWalletOrder(
		c.Request.Context(), h.cfg.AmountCents, h.cfg.Currency,
		h.cfg.AppBaseURL+"/premium?status=approved", h.cfg.AppBaseURL+"/premium?status=cancelled",
	)
	if err != nil {
		log.Printf("payments CreateWalletOrder paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal error"})
		return
	}
	pending := &models.Payment{
		Username:      user.Username,
		PayPalOrderID: order.OrderID,
		AmountCents:   h.cfg.AmountCents,
		Currency:      h.cfg.Currency,
		PaymentMethod: "paypal",
		Environment:   env,
	}
	if err := h.svc.CreatePending(c.Request.Context(), pending); err != nil {
		log.Printf("payments CreateWalletOrder persist: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "persist pending payment"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"order_id":    order.OrderID,
		"approve_url": order.ApproveURL,
	})
}

// CaptureOrder is POST /api/v1/payments/orders/:order_id/capture.
// Calls PayPal CaptureOrder and applies the side effects atomically.
func (h *Handler) CaptureOrder(c *gin.Context) {
	if h.svc == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	_, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	orderID := c.Param("order_id")
	if orderID == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "order_id required"})
		return
	}
	// Verify the payment row belongs to this user before talking to PayPal —
	// don't let one user capture another user's pending order via a stolen
	// order_id.
	payment, err := h.svc.GetByOrderID(c.Request.Context(), orderID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	if payment.Username != c.GetString("username") {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "order does not belong to user"})
		return
	}

	// Use the environment the order was actually created against, not the
	// caller's current toggle state — they could differ if the toggle was
	// flipped between create and capture.
	client := h.paypal.For(payment.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	cap, err := client.CaptureOrder(c.Request.Context(), orderID)
	if err != nil {
		log.Printf("payments CaptureOrder paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal capture failed"})
		return
	}
	if err := h.svc.ApplyCapture(c.Request.Context(), cap.OrderID, cap.CaptureID, cap.Raw); err != nil {
		log.Printf("payments CaptureOrder apply: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "apply capture"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"order_id":   cap.OrderID,
		"capture_id": cap.CaptureID,
		"status":     cap.Status,
	})
}

// Webhook is POST /api/v1/payments/webhook. NO auth middleware — the
// caller is PayPal. Authenticity is enforced by verify-webhook-signature,
// tried against the live client first and the sandbox client as a fallback
// (each carries its own PAYPAL_WEBHOOK_ID / PAYPAL_SANDBOX_WEBHOOK_ID) so
// both live traffic and an admin's sandbox testing verify correctly against
// the same public endpoint. Handles PAYMENT.CAPTURE.COMPLETED (idempotent
// premium grant) and PAYMENT.CAPTURE.REFUNDED / .REVERSED / .DENIED (revoke).
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
			ID                string `json:"id"`
			SupplementaryData struct {
				RelatedIDs struct {
					OrderID string `json:"order_id"`
				} `json:"related_ids"`
			} `json:"supplementary_data"`
		} `json:"resource"`
	}
	if err := decodeJSON(raw, &envelope); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "bad event payload"})
		return
	}
	switch envelope.EventType {
	case "PAYMENT.CAPTURE.COMPLETED":
		// resource.id = capture_id; related_ids.order_id = order_id.
		orderID := envelope.Resource.SupplementaryData.RelatedIDs.OrderID
		if orderID == "" {
			log.Printf("payments Webhook: COMPLETED without order_id")
			c.Status(http.StatusOK)
			return
		}
		if err := h.svc.ApplyCapture(c.Request.Context(), orderID, envelope.Resource.ID, raw); err != nil {
			log.Printf("payments Webhook ApplyCapture: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "apply"})
			return
		}
	case "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED", "PAYMENT.CAPTURE.DENIED":
		if err := h.svc.RevokePremium(c.Request.Context(), envelope.Resource.ID, envelope.EventType); err != nil {
			log.Printf("payments Webhook RevokePremium: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "revoke"})
			return
		}
	default:
		// Unhandled event types are ack'd to stop PayPal from retrying.
	}
	c.Status(http.StatusOK)
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
