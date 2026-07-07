package billing

import (
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/middleware"
	"apollo-sfs.com/api/routes/services"
)

// maxAllocatedPct is the allocation threshold above which direct purchases on
// a server are blocked; the user must file a capacity expansion request
// (50% deposit) instead.
const maxAllocatedPct = 90

// Config holds URL templates used for the PayPal wallet redirect flow.
// ReturnURL and CancelURL are deep-link scheme URIs that the mobile app
// detects via AppState when the user returns from the PayPal browser.
type Config struct {
	Currency  string
	ReturnURL string // e.g. "apollosfs://billing/storage/complete"
	CancelURL string // e.g. "apollosfs://billing/storage/cancel"
	// ClientID / Environment are exposed to the web frontend via GET
	// /billing/config so the PayPal JS SDK can be initialised without
	// baking credentials into the frontend build.
	ClientID    string
	Environment string // "sandbox" | "live"
	// SandboxClientID is returned instead of ClientID when the calling
	// admin's sandbox-payments toggle is on (see GetConfig).
	SandboxClientID string
}

// Handler wires the /api/v1/billing/storage/* endpoints.
type Handler struct {
	paypal  services.PayPalClients
	queries Querier
	cfg     Config
}

// NewHandler constructs a billing Handler. paypal.Live may be nil during
// local dev without PayPal credentials; all endpoints then return 503.
func NewHandler(paypal services.PayPalClients, q Querier, cfg Config) *Handler {
	return &Handler{paypal: paypal, queries: q, cfg: cfg}
}

// ── GET /api/v1/billing/config ────────────────────────────────────────────────

// GetConfig returns the public PayPal configuration the web frontend needs to
// load the PayPal JS SDK (react-paypal-js). The client ID is public by design.
// Returns the sandbox client ID/environment when the caller is an admin with
// the sandbox-payments toggle on, so every PayPalScriptProvider surface
// (storage add-ons, expansion deposits, premium, invoices) initialises
// against the matching PayPal environment automatically.
func (h *Handler) GetConfig(c *gin.Context) {
	if middleware.SandboxEnabled(c) {
		c.JSON(http.StatusOK, gin.H{
			"paypal_client_id": h.cfg.SandboxClientID,
			"currency":         h.currencyOrDefault(),
			"environment":      services.PayPalEnvSandbox,
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"paypal_client_id": h.cfg.ClientID,
		"currency":         h.currencyOrDefault(),
		"environment":      h.cfg.Environment,
	})
}

// ── GET /api/v1/billing/orders ────────────────────────────────────────────────

// ListMyOrders returns the calling user's combined orders (premium payments +
// storage purchases), newest first. Backs the user-facing orders page.
func (h *Handler) ListMyOrders(c *gin.Context) {
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}
	items, err := h.queries.ListUserOrders(c.Request.Context(), username)
	if err != nil {
		log.Printf("billing ListMyOrders: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	if items == nil {
		items = []db.AdminOrder{}
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// ── POST /api/v1/billing/storage/order ───────────────────────────────────────

// CreateWalletOrder creates a PayPal wallet order for a storage add-on.
// Body: { plan_id, storage_type }.
// Returns { order_id, approval_url }.
func (h *Handler) CreateWalletOrder(c *gin.Context) {
	client, env := h.resolveClient(c)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	var req struct {
		PlanID      string `json:"plan_id"      binding:"required"`
		StorageType string `json:"storage_type" binding:"required,oneof=nvme hdd"`
		ServerID    string `json:"server_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	pl, amountCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType)
	if !ok {
		return
	}

	serverID, ok := h.validatePurchaseServer(c, req.ServerID, req.StorageType, pl.BytesAdded)
	if !ok {
		return
	}

	currency := h.cfg.Currency
	if currency == "" {
		currency = "USD"
	}

	result, err := client.CreateStorageWalletOrder(
		c.Request.Context(), amountCents, currency, h.cfg.ReturnURL, h.cfg.CancelURL,
	)
	if err != nil {
		log.Printf("billing CreateWalletOrder paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal error"})
		return
	}

	order := &models.StorageOrder{
		Username:      username,
		PlanID:        req.PlanID,
		StorageType:   req.StorageType,
		BytesAdded:    pl.BytesAdded,
		AmountCents:   amountCents,
		Currency:      currency,
		PaymentMethod: "paypal",
		Status:        "created",
		PayPalOrderID: result.OrderID,
		ServerID:      serverID,
		Environment:   env,
	}
	if err := h.queries.CreateStorageOrder(c.Request.Context(), order); err != nil {
		log.Printf("billing CreateWalletOrder persist: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "persist order"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"order_id":     result.OrderID,
		"approval_url": result.ApproveURL,
	})
}

// ── POST /api/v1/billing/storage/order/:order_id/capture ─────────────────────

// CaptureWalletOrder captures an approved PayPal wallet order and adds the
// purchased storage to the account.
// Returns { new_quota_bytes }.
func (h *Handler) CaptureWalletOrder(c *gin.Context) {
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	orderID := c.Param("order_id")
	if orderID == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "order_id required"})
		return
	}

	// Verify ownership before talking to PayPal.
	existing, err := h.queries.GetStorageOrderByPayPalOrderID(c.Request.Context(), orderID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	if existing.Username != username {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "order does not belong to user"})
		return
	}

	// Use the environment the order was created against, not the caller's
	// current toggle state.
	client := h.paypal.For(existing.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	cap, err := client.CaptureOrder(c.Request.Context(), orderID)
	if err != nil {
		log.Printf("billing CaptureWalletOrder paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal capture failed"})
		return
	}

	if err := h.checkDriveCapacity(c, username, existing.BytesAdded); err != nil {
		return
	}

	applied, err := h.queries.MarkStorageOrderCaptured(c.Request.Context(), cap.OrderID, cap.CaptureID, cap.Raw)
	if err != nil {
		log.Printf("billing CaptureWalletOrder mark captured: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "record capture"})
		return
	}

	if !applied {
		// Already captured (duplicate call / race). Return current quota without
		// adding bytes again.
		user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load user"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"new_quota_bytes": user.StorageQuotaBytes})
		return
	}

	newQuota, err := h.queries.AddUserQuota(c.Request.Context(), username, existing.BytesAdded)
	if err != nil {
		log.Printf("billing CaptureWalletOrder add quota: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "apply quota"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"new_quota_bytes": newQuota})
}

// ── POST /api/v1/billing/storage/hosted-card ─────────────────────────────────

// CaptureHostedCard captures a PayPal order that was created client-side via
// PayPal's hosted fields JS SDK. The order ID is produced by actions.order.create()
// in the WebView; we verify the captured amount matches the expected plan price
// before applying the quota.
// Body: { plan_id, storage_type, order_id }.
// Returns { new_quota_bytes }.
func (h *Handler) CaptureHostedCard(c *gin.Context) {
	client, env := h.resolveClient(c)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	var req struct {
		PlanID      string `json:"plan_id"      binding:"required"`
		StorageType string `json:"storage_type" binding:"required,oneof=nvme hdd"`
		OrderID     string `json:"order_id"     binding:"required"`
		ServerID    string `json:"server_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	pl, expectedCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType)
	if !ok {
		return
	}

	serverID, ok := h.validatePurchaseServer(c, req.ServerID, req.StorageType, pl.BytesAdded)
	if !ok {
		return
	}

	cap, err := client.CaptureOrder(c.Request.Context(), req.OrderID)
	if err != nil {
		log.Printf("billing CaptureHostedCard paypal capture: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal capture failed"})
		return
	}

	if cap.AmountCents != expectedCents {
		log.Printf("billing CaptureHostedCard amount mismatch: got %d, expected %d", cap.AmountCents, expectedCents)
		c.AbortWithStatusJSON(http.StatusUnprocessableEntity, gin.H{"error": "payment amount does not match plan price"})
		return
	}

	newQuota, err := h.persistDirectCapture(c, username, req.PlanID, req.StorageType, "hosted_card", pl, serverID, cap, env)
	if err != nil {
		return
	}
	c.JSON(http.StatusOK, gin.H{"new_quota_bytes": newQuota})
}

// ── POST /api/v1/billing/storage/card ────────────────────────────────────────

// ChargeCard processes a card payment via PayPal ACDC and immediately applies
// the storage to the account.
// Body: { plan_id, storage_type, card: { number, expiry_month, expiry_year, cvv, name } }.
// Returns { new_quota_bytes }.
func (h *Handler) ChargeCard(c *gin.Context) {
	client, env := h.resolveClient(c)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	var req struct {
		PlanID      string `json:"plan_id"      binding:"required"`
		StorageType string `json:"storage_type" binding:"required,oneof=nvme hdd"`
		ServerID    string `json:"server_id"`
		Card        struct {
			Number      string `json:"number"       binding:"required"`
			ExpiryMonth string `json:"expiry_month" binding:"required"`
			ExpiryYear  string `json:"expiry_year"  binding:"required"`
			CVV         string `json:"cvv"          binding:"required"`
			Name        string `json:"name"         binding:"required"`
		} `json:"card" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	pl, amountCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType)
	if !ok {
		return
	}

	serverID, ok := h.validatePurchaseServer(c, req.ServerID, req.StorageType, pl.BytesAdded)
	if !ok {
		return
	}

	cap, err := client.DirectChargeCard(c.Request.Context(), services.CardOrderInput{
		AmountCents: amountCents,
		Currency:    h.currencyOrDefault(),
		Number:      req.Card.Number,
		ExpiryMonth: req.Card.ExpiryMonth,
		ExpiryYear:  req.Card.ExpiryYear,
		CVV:         req.Card.CVV,
		Name:        req.Card.Name,
	})
	if err != nil {
		log.Printf("billing ChargeCard paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": err.Error()})
		return
	}

	newQuota, err := h.persistDirectCapture(c, username, req.PlanID, req.StorageType, "card", pl, serverID, cap, env)
	if err != nil {
		return
	}
	c.JSON(http.StatusOK, gin.H{"new_quota_bytes": newQuota})
}

// ── POST /api/v1/billing/storage/apple-pay ───────────────────────────────────

// ChargeApplePay processes an Apple Pay token via PayPal and immediately
// applies the storage to the account.
// Body: { plan_id, storage_type, apple_pay_token: { version, data, signature, header, network, displayName } }.
// Returns { new_quota_bytes }.
func (h *Handler) ChargeApplePay(c *gin.Context) {
	client, env := h.resolveClient(c)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	var req struct {
		PlanID      string `json:"plan_id"      binding:"required"`
		StorageType string `json:"storage_type" binding:"required,oneof=nvme hdd"`
		ServerID    string `json:"server_id"`
		Token       struct {
			Version     string         `json:"version"     binding:"required"`
			Data        string         `json:"data"        binding:"required"`
			Signature   string         `json:"signature"   binding:"required"`
			Header      map[string]any `json:"header"      binding:"required"`
			Network     string         `json:"network"     binding:"required"`
			DisplayName string         `json:"displayName" binding:"required"`
		} `json:"apple_pay_token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	pl, amountCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType)
	if !ok {
		return
	}

	serverID, ok := h.validatePurchaseServer(c, req.ServerID, req.StorageType, pl.BytesAdded)
	if !ok {
		return
	}

	cap, err := client.DirectChargeApplePay(c.Request.Context(), services.ApplePayTokenInput{
		AmountCents: amountCents,
		Currency:    h.currencyOrDefault(),
		Version:     req.Token.Version,
		Data:        req.Token.Data,
		Signature:   req.Token.Signature,
		Header:      req.Token.Header,
		Network:     req.Token.Network,
		DisplayName: req.Token.DisplayName,
	})
	if err != nil {
		log.Printf("billing ChargeApplePay paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": err.Error()})
		return
	}

	newQuota, err := h.persistDirectCapture(c, username, req.PlanID, req.StorageType, "apple_pay", pl, serverID, cap, env)
	if err != nil {
		return
	}
	c.JSON(http.StatusOK, gin.H{"new_quota_bytes": newQuota})
}

// ── POST /api/v1/billing/storage/google-pay ──────────────────────────────────

// ChargeGooglePay processes a Google Pay token via PayPal and immediately
// applies the storage to the account.
// Body: { plan_id, storage_type, google_pay_token: "<JSON string>" }.
// Returns { new_quota_bytes }.
func (h *Handler) ChargeGooglePay(c *gin.Context) {
	client, env := h.resolveClient(c)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	var req struct {
		PlanID         string `json:"plan_id"         binding:"required"`
		StorageType    string `json:"storage_type"    binding:"required,oneof=nvme hdd"`
		ServerID       string `json:"server_id"`
		GooglePayToken string `json:"google_pay_token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	pl, amountCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType)
	if !ok {
		return
	}

	serverID, ok := h.validatePurchaseServer(c, req.ServerID, req.StorageType, pl.BytesAdded)
	if !ok {
		return
	}

	cap, err := client.DirectChargeGooglePay(
		c.Request.Context(), amountCents, h.currencyOrDefault(), req.GooglePayToken,
	)
	if err != nil {
		log.Printf("billing ChargeGooglePay paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": err.Error()})
		return
	}

	newQuota, err := h.persistDirectCapture(c, username, req.PlanID, req.StorageType, "google_pay", pl, serverID, cap, env)
	if err != nil {
		return
	}
	c.JSON(http.StatusOK, gin.H{"new_quota_bytes": newQuota})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// validatePurchaseServer enforces the direct-purchase rules for a selected
// server: it must exist and be active, offer the requested storage type, be
// under 90% allocated, and have enough unallocated capacity for the plan.
// Violations respond 409 with requires_expansion=true so the client can steer
// the user into the expansion request flow. serverIDStr may be empty (legacy
// mobile clients) in which case no server check is performed.
func (h *Handler) validatePurchaseServer(c *gin.Context, serverIDStr, storageType string, bytes int64) (*uuid.UUID, bool) {
	if serverIDStr == "" {
		return nil, true
	}
	id, err := uuid.Parse(serverIDStr)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid server_id"})
		return nil, false
	}
	capa, err := h.queries.GetServerCapacity(c.Request.Context(), id, storageType)
	if err != nil {
		log.Printf("billing validatePurchaseServer: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "check server capacity"})
		return nil, false
	}
	if capa == nil {
		// Either the server doesn't exist, or it exists but has no active
		// drives of the requested tier — tell those two cases apart so a
		// server that's fast-only (or standard-only) reports "wrong type"
		// rather than a misleading 404.
		srv, err := h.queries.GetServer(c.Request.Context(), id)
		if err != nil {
			log.Printf("billing validatePurchaseServer: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "check server capacity"})
			return nil, false
		}
		if srv == nil || !srv.IsActive {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "server not found"})
			return nil, false
		}
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{
			"error":              "server does not offer the requested storage type",
			"requires_expansion": true,
		})
		return nil, false
	}
	if capa.TotalCapacityBytes > 0 {
		allocated := capa.TotalCapacityBytes - capa.AvailableBytes
		if allocated*100 >= int64(maxAllocatedPct)*capa.TotalCapacityBytes {
			c.AbortWithStatusJSON(http.StatusConflict, gin.H{
				"error":              "server is at or above 90% allocated capacity — submit an expansion request instead",
				"requires_expansion": true,
				"available_bytes":    capa.AvailableBytes,
			})
			return nil, false
		}
	}
	if capa.AvailableBytes < bytes {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{
			"error":              "server lacks capacity for this plan — submit an expansion request instead",
			"requires_expansion": true,
			"available_bytes":    capa.AvailableBytes,
			"requested_bytes":    bytes,
		})
		return nil, false
	}
	return &id, true
}

// checkDriveCapacity returns an error response and non-nil error if the user's
// drive lacks sufficient unallocated space for bytesAdded. Callers should return
// immediately on non-nil error.
func (h *Handler) checkDriveCapacity(c *gin.Context, username string, bytesAdded int64) error {
	alloc, err := h.queries.GetUserDrive(c.Request.Context(), username)
	if err != nil || alloc == nil {
		// User has no drive yet — allocation happens at purchase; skip check.
		return nil
	}
	avail, err := h.queries.GetDriveAvailableBytes(c.Request.Context(), alloc.DriveID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "check drive capacity"})
		return err
	}
	if avail < bytesAdded {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{
			"error":           "insufficient drive capacity",
			"available_bytes": avail,
			"requested_bytes": bytesAdded,
		})
		return fmt.Errorf("drive full: %d available, %d requested", avail, bytesAdded)
	}
	return nil
}

// persistDirectCapture inserts a completed storage_order row and adds the
// purchased bytes to the user's quota. Returns the new quota on success, or
// writes an error response and returns a non-nil error so the caller can return
// immediately.
func (h *Handler) persistDirectCapture(
	c *gin.Context,
	username, planID, storageType, paymentMethod string,
	pl Plan,
	serverID *uuid.UUID,
	cap *services.CaptureOrderResult,
	environment string,
) (int64, error) {
	if err := h.checkDriveCapacity(c, username, pl.BytesAdded); err != nil {
		return 0, err
	}
	now := time.Now()
	order := &models.StorageOrder{
		Username:        username,
		PlanID:          planID,
		StorageType:     storageType,
		BytesAdded:      pl.BytesAdded,
		AmountCents:     cap.AmountCents,
		Currency:        cap.Currency,
		PaymentMethod:   paymentMethod,
		Status:          "captured",
		PayPalOrderID:   cap.OrderID,
		PayPalCaptureID: &cap.CaptureID,
		ServerID:        serverID,
		RawResponse:     cap.Raw,
		Environment:     environment,
		CapturedAt:      &now,
	}
	if err := h.queries.CreateStorageOrder(c.Request.Context(), order); err != nil {
		log.Printf("billing %s persist: %v", paymentMethod, err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "persist order"})
		return 0, err
	}

	newQuota, err := h.queries.AddUserQuota(c.Request.Context(), username, pl.BytesAdded)
	if err != nil {
		log.Printf("billing %s add quota: %v", paymentMethod, err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "apply quota"})
		return 0, err
	}
	return newQuota, nil
}

// resolveClient picks the PayPal client for the calling user's current
// sandbox-payments toggle state, along with the environment string to stamp
// on newly created orders. Returns a nil client when that environment isn't
// configured (callers 503).
func (h *Handler) resolveClient(c *gin.Context) (*services.PayPalClient, string) {
	env := services.PayPalEnvLive
	if middleware.SandboxEnabled(c) {
		env = services.PayPalEnvSandbox
	}
	return h.paypal.For(env), env
}

func (h *Handler) currentUsername(c *gin.Context) (string, bool) {
	username := c.GetString("username")
	if username == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return "", false
	}
	return username, true
}

func (h *Handler) resolvePlan(c *gin.Context, planID, storageType string) (Plan, int, bool) {
	pl, found := lookupPlan(planID)
	if !found {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "unknown plan_id"})
		return Plan{}, 0, false
	}
	amountCents, ok := pl.PriceCents[storageType]
	if !ok {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "unknown storage_type for plan"})
		return Plan{}, 0, false
	}
	return pl, amountCents, true
}

func (h *Handler) currencyOrDefault() string {
	if h.cfg.Currency != "" {
		return h.cfg.Currency
	}
	return "USD"
}
