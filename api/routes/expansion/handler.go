package expansion

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/billing"
	"apollo-sfs.com/api/routes/services"
)

const (
	// paymentWindowDays is how long the user has to pay the remaining balance
	// after the admin marks the server capacity as expanded.
	paymentWindowDays = 3
)

// Config holds URL templates used for the PayPal wallet redirect flow.
type Config struct {
	Currency  string
	ReturnURL string // e.g. "apollosfs://billing/expansion/complete"
	CancelURL string // e.g. "apollosfs://billing/expansion/cancel"
	// AppURL is used to build the payment deep-link sent in the payment-due email.
	// e.g. "https://files.example.com" — the email links to apollosfs://expansion/pay/{id}
	AppURL string
}

// Handler serves expansion-request endpoints for both users and admins.
type Handler struct {
	paypal   *services.PayPalClient
	emailSvc *services.EmailService
	queries  Querier
	cfg      Config
}

// NewHandler constructs an expansion Handler.
func NewHandler(paypal *services.PayPalClient, email *services.EmailService, q Querier, cfg Config) *Handler {
	return &Handler{paypal: paypal, emailSvc: email, queries: q, cfg: cfg}
}

// ── User deposit endpoints ─────────────────────────────────────────────────────

// CreateWalletOrder creates a PayPal wallet order for a 50% expansion deposit.
// POST /api/v1/billing/storage/expansion/order
// Body: { plan_id, storage_type, server_id }
// Returns: { order_id, approval_url, deposit_cents, full_price_cents }
func (h *Handler) CreateWalletOrder(c *gin.Context) {
	if h.paypal == nil {
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
		ServerID    string `json:"server_id"    binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	serverID, err := uuid.Parse(req.ServerID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid server_id"})
		return
	}

	pl, fullCents, depositCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType)
	if !ok {
		return
	}

	currency := h.currencyOrDefault()
	result, err := h.paypal.CreateStorageWalletOrder(
		c.Request.Context(), depositCents, currency, h.cfg.ReturnURL, h.cfg.CancelURL,
	)
	if err != nil {
		log.Printf("expansion CreateWalletOrder paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal error"})
		return
	}

	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil || user == nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load user"})
		return
	}

	_, err = h.queries.CreateExpansionRequest(c.Request.Context(), db.CreateExpansionRequestParams{
		Username:           username,
		ServerID:           serverID,
		PlanID:             req.PlanID,
		StorageType:        req.StorageType,
		BytesRequested:     pl.BytesAdded,
		DepositAmountCents: depositCents,
		FullPriceCents:     fullCents,
		Currency:           currency,
		PaymentMethod:      "paypal",
		PayPalOrderID:      result.OrderID,
		Status:             "opened",
		PreQuotaBytes:      user.StorageQuotaBytes,
		ExpiresAt:          expiryAt(time.Now()),
	})
	if err != nil {
		log.Printf("expansion CreateWalletOrder persist: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "persist order"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"order_id":         result.OrderID,
		"approval_url":     result.ApproveURL,
		"deposit_cents":    depositCents,
		"full_price_cents": fullCents,
	})
}

// CaptureWalletOrder captures an approved PayPal expansion deposit.
// POST /api/v1/billing/storage/expansion/order/:order_id/capture
// Returns: { expansion_request_id, expires_at }
func (h *Handler) CaptureWalletOrder(c *gin.Context) {
	if h.paypal == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	orderID := c.Param("order_id")
	if orderID == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "order_id required"})
		return
	}

	existing, err := h.queries.GetExpansionRequestByPayPalOrderID(c.Request.Context(), orderID)
	if err != nil || existing == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	if existing.Username != username {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "order does not belong to user"})
		return
	}

	cap, err := h.paypal.CaptureOrder(c.Request.Context(), orderID)
	if err != nil {
		log.Printf("expansion CaptureWalletOrder paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal capture failed"})
		return
	}

	_, err = h.queries.MarkExpansionRequestCaptured(c.Request.Context(), cap.OrderID, cap.CaptureID)
	if err != nil {
		log.Printf("expansion CaptureWalletOrder mark captured: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "record capture"})
		return
	}

	h.notifyAdmins(c.Request.Context(), existing)

	c.JSON(http.StatusOK, gin.H{
		"expansion_request_id": existing.ID,
		"expires_at":           existing.ExpiresAt,
	})
}

// ChargeCardExpansion processes a card deposit payment.
// POST /api/v1/billing/storage/expansion/card
func (h *Handler) ChargeCardExpansion(c *gin.Context) {
	if h.paypal == nil {
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
		ServerID    string `json:"server_id"    binding:"required"`
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

	serverID, err := uuid.Parse(req.ServerID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid server_id"})
		return
	}

	pl, fullCents, depositCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType)
	if !ok {
		return
	}

	cap, err := h.paypal.DirectChargeCard(c.Request.Context(), services.CardOrderInput{
		AmountCents: depositCents,
		Currency:    h.currencyOrDefault(),
		Number:      req.Card.Number,
		ExpiryMonth: req.Card.ExpiryMonth,
		ExpiryYear:  req.Card.ExpiryYear,
		CVV:         req.Card.CVV,
		Name:        req.Card.Name,
	})
	if err != nil {
		log.Printf("expansion ChargeCard paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": err.Error()})
		return
	}

	r, ok := h.persistDirectExpansion(c, username, serverID, req.PlanID, req.StorageType, "card", pl, fullCents, depositCents, cap)
	if !ok {
		return
	}
	h.notifyAdmins(c.Request.Context(), r)
	c.JSON(http.StatusCreated, gin.H{"expansion_request_id": r.ID, "expires_at": r.ExpiresAt})
}

// ChargeApplePayExpansion processes an Apple Pay deposit.
// POST /api/v1/billing/storage/expansion/apple-pay
func (h *Handler) ChargeApplePayExpansion(c *gin.Context) {
	if h.paypal == nil {
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
		ServerID    string `json:"server_id"    binding:"required"`
		Token       struct {
			Version     string         `json:"version"      binding:"required"`
			Data        string         `json:"data"         binding:"required"`
			Signature   string         `json:"signature"    binding:"required"`
			Header      map[string]any `json:"header"       binding:"required"`
			Network     string         `json:"network"      binding:"required"`
			DisplayName string         `json:"displayName"  binding:"required"`
		} `json:"apple_pay_token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	serverID, err := uuid.Parse(req.ServerID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid server_id"})
		return
	}

	pl, fullCents, depositCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType)
	if !ok {
		return
	}

	cap, err := h.paypal.DirectChargeApplePay(c.Request.Context(), services.ApplePayTokenInput{
		AmountCents: depositCents,
		Currency:    h.currencyOrDefault(),
		Version:     req.Token.Version,
		Data:        req.Token.Data,
		Signature:   req.Token.Signature,
		Header:      req.Token.Header,
		Network:     req.Token.Network,
		DisplayName: req.Token.DisplayName,
	})
	if err != nil {
		log.Printf("expansion ChargeApplePay paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": err.Error()})
		return
	}

	r, ok := h.persistDirectExpansion(c, username, serverID, req.PlanID, req.StorageType, "apple_pay", pl, fullCents, depositCents, cap)
	if !ok {
		return
	}
	h.notifyAdmins(c.Request.Context(), r)
	c.JSON(http.StatusCreated, gin.H{"expansion_request_id": r.ID, "expires_at": r.ExpiresAt})
}

// ChargeGooglePayExpansion processes a Google Pay deposit.
// POST /api/v1/billing/storage/expansion/google-pay
func (h *Handler) ChargeGooglePayExpansion(c *gin.Context) {
	if h.paypal == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	var req struct {
		PlanID         string `json:"plan_id"          binding:"required"`
		StorageType    string `json:"storage_type"     binding:"required,oneof=nvme hdd"`
		ServerID       string `json:"server_id"        binding:"required"`
		GooglePayToken string `json:"google_pay_token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	serverID, err := uuid.Parse(req.ServerID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid server_id"})
		return
	}

	pl, fullCents, depositCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType)
	if !ok {
		return
	}

	cap, err := h.paypal.DirectChargeGooglePay(
		c.Request.Context(), depositCents, h.currencyOrDefault(), req.GooglePayToken,
	)
	if err != nil {
		log.Printf("expansion ChargeGooglePay paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": err.Error()})
		return
	}

	r, ok := h.persistDirectExpansion(c, username, serverID, req.PlanID, req.StorageType, "google_pay", pl, fullCents, depositCents, cap)
	if !ok {
		return
	}
	h.notifyAdmins(c.Request.Context(), r)
	c.JSON(http.StatusCreated, gin.H{"expansion_request_id": r.ID, "expires_at": r.ExpiresAt})
}

// ── User pay-remaining endpoints ──────────────────────────────────────────────
// These are reached after the admin marks the request as expanded.
// The user pays the remaining 50% balance; on success the quota is added.

// PayRemainingWalletOrder creates a PayPal wallet order for the remaining balance.
// POST /api/v1/billing/storage/expansion/:id/pay-remaining/order
// Returns: { order_id, approval_url }
func (h *Handler) PayRemainingWalletOrder(c *gin.Context) {
	if h.paypal == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	req, ok := h.loadExpandedRequest(c, username)
	if !ok {
		return
	}
	remainingCents := req.FullPriceCents - req.DepositAmountCents

	result, err := h.paypal.CreateStorageWalletOrder(
		c.Request.Context(), remainingCents, req.Currency, h.cfg.ReturnURL, h.cfg.CancelURL,
	)
	if err != nil {
		log.Printf("expansion PayRemainingWallet paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal error"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"order_id":        result.OrderID,
		"approval_url":    result.ApproveURL,
		"remaining_cents": remainingCents,
	})
}

// CapturePayRemainingWallet captures the remaining-balance PayPal order and adds quota.
// POST /api/v1/billing/storage/expansion/:id/pay-remaining/order/:order_id/capture
// Returns: { new_quota_bytes }
func (h *Handler) CapturePayRemainingWallet(c *gin.Context) {
	if h.paypal == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	req, ok := h.loadExpandedRequest(c, username)
	if !ok {
		return
	}

	orderID := c.Param("order_id")
	if orderID == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "order_id required"})
		return
	}

	cap, err := h.paypal.CaptureOrder(c.Request.Context(), orderID)
	if err != nil {
		log.Printf("expansion CapturePayRemaining paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal capture failed"})
		return
	}

	newQuota, ok2 := h.applyRemainingPayment(c, req, cap.CaptureID)
	if !ok2 {
		return
	}
	c.JSON(http.StatusOK, gin.H{"new_quota_bytes": newQuota})
}

// PayRemainingCard charges the remaining balance by card and adds quota.
// POST /api/v1/billing/storage/expansion/:id/pay-remaining/card
func (h *Handler) PayRemainingCard(c *gin.Context) {
	if h.paypal == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	req, ok := h.loadExpandedRequest(c, username)
	if !ok {
		return
	}

	var body struct {
		Card struct {
			Number      string `json:"number"       binding:"required"`
			ExpiryMonth string `json:"expiry_month" binding:"required"`
			ExpiryYear  string `json:"expiry_year"  binding:"required"`
			CVV         string `json:"cvv"          binding:"required"`
			Name        string `json:"name"         binding:"required"`
		} `json:"card" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	remainingCents := req.FullPriceCents - req.DepositAmountCents
	cap, err := h.paypal.DirectChargeCard(c.Request.Context(), services.CardOrderInput{
		AmountCents: remainingCents,
		Currency:    req.Currency,
		Number:      body.Card.Number,
		ExpiryMonth: body.Card.ExpiryMonth,
		ExpiryYear:  body.Card.ExpiryYear,
		CVV:         body.Card.CVV,
		Name:        body.Card.Name,
	})
	if err != nil {
		log.Printf("expansion PayRemainingCard paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": err.Error()})
		return
	}

	newQuota, ok2 := h.applyRemainingPayment(c, req, cap.CaptureID)
	if !ok2 {
		return
	}
	c.JSON(http.StatusOK, gin.H{"new_quota_bytes": newQuota})
}

// PayRemainingApplePay charges the remaining balance via Apple Pay.
// POST /api/v1/billing/storage/expansion/:id/pay-remaining/apple-pay
func (h *Handler) PayRemainingApplePay(c *gin.Context) {
	if h.paypal == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	req, ok := h.loadExpandedRequest(c, username)
	if !ok {
		return
	}

	var body struct {
		Token struct {
			Version     string         `json:"version"      binding:"required"`
			Data        string         `json:"data"         binding:"required"`
			Signature   string         `json:"signature"    binding:"required"`
			Header      map[string]any `json:"header"       binding:"required"`
			Network     string         `json:"network"      binding:"required"`
			DisplayName string         `json:"displayName"  binding:"required"`
		} `json:"apple_pay_token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	remainingCents := req.FullPriceCents - req.DepositAmountCents
	cap, err := h.paypal.DirectChargeApplePay(c.Request.Context(), services.ApplePayTokenInput{
		AmountCents: remainingCents,
		Currency:    req.Currency,
		Version:     body.Token.Version,
		Data:        body.Token.Data,
		Signature:   body.Token.Signature,
		Header:      body.Token.Header,
		Network:     body.Token.Network,
		DisplayName: body.Token.DisplayName,
	})
	if err != nil {
		log.Printf("expansion PayRemainingApplePay paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": err.Error()})
		return
	}

	newQuota, ok2 := h.applyRemainingPayment(c, req, cap.CaptureID)
	if !ok2 {
		return
	}
	c.JSON(http.StatusOK, gin.H{"new_quota_bytes": newQuota})
}

// PayRemainingGooglePay charges the remaining balance via Google Pay.
// POST /api/v1/billing/storage/expansion/:id/pay-remaining/google-pay
func (h *Handler) PayRemainingGooglePay(c *gin.Context) {
	if h.paypal == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	req, ok := h.loadExpandedRequest(c, username)
	if !ok {
		return
	}

	var body struct {
		GooglePayToken string `json:"google_pay_token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	remainingCents := req.FullPriceCents - req.DepositAmountCents
	cap, err := h.paypal.DirectChargeGooglePay(
		c.Request.Context(), remainingCents, req.Currency, body.GooglePayToken,
	)
	if err != nil {
		log.Printf("expansion PayRemainingGooglePay paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": err.Error()})
		return
	}

	newQuota, ok2 := h.applyRemainingPayment(c, req, cap.CaptureID)
	if !ok2 {
		return
	}
	c.JSON(http.StatusOK, gin.H{"new_quota_bytes": newQuota})
}

// ── Admin endpoints ───────────────────────────────────────────────────────────

// ListRequests returns paginated expansion requests with optional filters.
// GET /api/v1/admin/expansion-requests
func (h *Handler) ListRequests(c *gin.Context) {
	f := db.ExpansionRequestFilter{}
	if s := c.Query("status"); s != "" {
		f.Status = s
	}
	if sid := c.Query("server_id"); sid != "" {
		if id, err := uuid.Parse(sid); err == nil {
			f.ServerID = id
		}
	}
	if from := c.Query("from"); from != "" {
		if t, err := time.Parse(time.RFC3339, from); err == nil {
			f.From = t
		}
	}
	if to := c.Query("to"); to != "" {
		if t, err := time.Parse(time.RFC3339, to); err == nil {
			f.To = t
		}
	}

	result, err := h.queries.ListExpansionRequests(c.Request.Context(), f, db.PageInput{
		Cursor: c.Query("cursor"),
		Limit:  db.DefaultPageLimit,
	})
	if err != nil {
		log.Printf("expansion ListRequests: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": result.Items, "next_token": result.NextToken})
}

// MarkExpanded verifies the server has capacity, sets status='expanded', and
// emails the user to pay the remaining balance within 3 days.
// POST /api/v1/admin/expansion-requests/:id/fulfill
func (h *Handler) MarkExpanded(c *gin.Context) {
	id, ok := h.parseID(c)
	if !ok {
		return
	}

	req, err := h.queries.GetExpansionRequestByID(c.Request.Context(), id)
	if err != nil || req == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if req.Status != "opened" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "request must be in 'opened' state"})
		return
	}
	if req.PayPalCaptureID == nil {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "deposit not yet captured"})
		return
	}

	// Verify the server's drive has enough free space.
	drive, err := h.queries.GetUserDrive(c.Request.Context(), req.Username)
	if err != nil || drive == nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load user drive"})
		return
	}
	available, err := h.queries.GetDriveAvailableBytes(c.Request.Context(), drive.DriveID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "check capacity"})
		return
	}
	if available < req.BytesRequested {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{
			"error":           "server still lacks capacity",
			"available_bytes": available,
		})
		return
	}

	updated, err := h.queries.MarkExpansionRequestExpanded(c.Request.Context(), id, paymentWindowDays)
	if err != nil {
		log.Printf("expansion MarkExpanded: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "update status"})
		return
	}
	if !updated {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "concurrent modification"})
		return
	}

	// Build a deep-link the user taps from the email to open the payment UI in the app.
	paymentURL := fmt.Sprintf("apollosfs://expansion/pay/%s", id)
	remainingCents := req.FullPriceCents - req.DepositAmountCents
	dueAt := time.Now().AddDate(0, 0, paymentWindowDays)

	if err := h.emailSvc.SendExpansionPaymentDue(
		c.Request.Context(),
		req.UserEmail,
		req.ServerName,
		planLabel(req.PlanID, req.StorageType),
		formatCents(remainingCents, req.Currency),
		dueAt.Format("Mon, 02 Jan 2006"),
		paymentURL,
	); err != nil {
		log.Printf("expansion MarkExpanded send email: %v", err)
	}

	c.JSON(http.StatusOK, gin.H{
		"payment_due_at":  dueAt,
		"remaining_cents": remainingCents,
	})
}

// CancelRequest refunds the deposit and cancels an expansion request.
// POST /api/v1/admin/expansion-requests/:id/cancel
// Body: { reason }
func (h *Handler) CancelRequest(c *gin.Context) {
	id, ok := h.parseID(c)
	if !ok {
		return
	}

	var body struct {
		Reason string `json:"reason" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	req, err := h.queries.GetExpansionRequestByID(c.Request.Context(), id)
	if err != nil || req == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if req.Status != "opened" && req.Status != "expanded" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "request is not cancellable"})
		return
	}
	if req.PayPalCaptureID == nil {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "deposit not yet captured"})
		return
	}
	if h.paypal == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}

	refund, err := h.paypal.RefundCapture(c.Request.Context(), *req.PayPalCaptureID, req.DepositAmountCents, req.Currency)
	if err != nil {
		log.Printf("expansion CancelRequest paypal refund: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "refund failed"})
		return
	}

	_, err = h.queries.CancelExpansionRequest(c.Request.Context(), id, refund.RefundID, body.Reason)
	if err != nil {
		log.Printf("expansion CancelRequest mark refunded: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "record cancellation"})
		return
	}

	if err := h.emailSvc.SendExpansionCancellation(
		c.Request.Context(),
		req.UserEmail,
		req.ServerName,
		planLabel(req.PlanID, req.StorageType),
		formatCents(req.DepositAmountCents, req.Currency),
		body.Reason,
	); err != nil {
		log.Printf("expansion CancelRequest send email: %v", err)
	}

	c.JSON(http.StatusOK, gin.H{"refund_id": refund.RefundID})
}

// ── Background expiry loop ────────────────────────────────────────────────────

// StartExpiryLoop spawns a goroutine that checks every hour for:
//   - 'opened' requests past their 14-day SLA → refund deposit, mark expired
//   - 'expanded' requests past their 3-day payment window → forfeit (no refund)
func (h *Handler) StartExpiryLoop(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		log.Printf("expansion: expiry loop started")
		for {
			select {
			case <-ctx.Done():
				log.Printf("expansion: expiry loop stopped")
				return
			case <-ticker.C:
				h.processExpired(ctx)
				h.processForfeited(ctx)
			}
		}
	}()
}

// processExpired handles 'opened' requests that have passed their 14-day SLA.
// The deposit is refunded via PayPal.
func (h *Handler) processExpired(ctx context.Context) {
	expired, err := h.queries.ListExpiredOpenRequests(ctx)
	if err != nil {
		log.Printf("expansion expiry: list opened: %v", err)
		return
	}
	for i := range expired {
		h.expireOne(ctx, &expired[i])
	}
}

func (h *Handler) expireOne(ctx context.Context, r *models.ServerExpansionRequest) {
	if r.PayPalCaptureID == nil {
		if err := h.queries.ExpireExpansionRequest(ctx, r.ID, ""); err != nil {
			log.Printf("expansion expiry %s: mark expired (no capture): %v", r.ID, err)
		}
		return
	}
	if h.paypal == nil {
		log.Printf("expansion expiry %s: paypal not configured, skipping", r.ID)
		return
	}
	refund, err := h.paypal.RefundCapture(ctx, *r.PayPalCaptureID, r.DepositAmountCents, r.Currency)
	if err != nil {
		log.Printf("expansion expiry %s: paypal refund: %v", r.ID, err)
		return
	}
	if err := h.queries.ExpireExpansionRequest(ctx, r.ID, refund.RefundID); err != nil {
		log.Printf("expansion expiry %s: mark expired: %v", r.ID, err)
	}
}

// processForfeited handles 'expanded' requests past the 3-day payment window.
// No refund is issued — the deposit is forfeited.
func (h *Handler) processForfeited(ctx context.Context) {
	forfeited, err := h.queries.ListExpiredExpandedRequests(ctx)
	if err != nil {
		log.Printf("expansion expiry: list expanded: %v", err)
		return
	}
	for i := range forfeited {
		r := &forfeited[i]
		if err := h.queries.ForfeitExpansionRequest(ctx, r.ID); err != nil {
			log.Printf("expansion forfeit %s: %v", r.ID, err)
		}
	}
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// loadExpandedRequest loads an expansion request by :id, verifies it belongs to
// the caller and is in 'expanded' status with a live payment window.
func (h *Handler) loadExpandedRequest(c *gin.Context, username string) (*models.ServerExpansionRequest, bool) {
	id, ok := h.parseID(c)
	if !ok {
		return nil, false
	}
	req, err := h.queries.GetExpansionRequestByID(c.Request.Context(), id)
	if err != nil || req == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "not found"})
		return nil, false
	}
	if req.Username != username {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "request does not belong to user"})
		return nil, false
	}
	if req.Status != "expanded" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "request is not awaiting payment"})
		return nil, false
	}
	if req.PaymentDueAt != nil && time.Now().After(*req.PaymentDueAt) {
		c.AbortWithStatusJSON(http.StatusGone, gin.H{"error": "payment window has expired"})
		return nil, false
	}
	return req, true
}

// applyRemainingPayment adds the quota and marks the expansion request completed.
func (h *Handler) applyRemainingPayment(c *gin.Context, req *models.ServerExpansionRequest, captureID string) (int64, bool) {
	newQuota, err := h.queries.AddUserQuota(c.Request.Context(), req.Username, req.BytesRequested)
	if err != nil {
		log.Printf("expansion payRemaining add quota: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "apply quota"})
		return 0, false
	}
	updated, err := h.queries.FulfillExpansionRequest(c.Request.Context(), req.ID, newQuota)
	if err != nil || !updated {
		log.Printf("expansion payRemaining fulfill: err=%v updated=%v", err, updated)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "mark completed"})
		return 0, false
	}
	return newQuota, true
}

func (h *Handler) persistDirectExpansion(
	c *gin.Context,
	username string,
	serverID uuid.UUID,
	planID, storageType, paymentMethod string,
	pl billing.Plan,
	fullCents, depositCents int,
	cap *services.CaptureOrderResult,
) (*models.ServerExpansionRequest, bool) {
	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil || user == nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load user"})
		return nil, false
	}

	cid := cap.CaptureID
	r, err := h.queries.CreateExpansionRequest(c.Request.Context(), db.CreateExpansionRequestParams{
		Username:           username,
		ServerID:           serverID,
		PlanID:             planID,
		StorageType:        storageType,
		BytesRequested:     pl.BytesAdded,
		DepositAmountCents: depositCents,
		FullPriceCents:     fullCents,
		Currency:           cap.Currency,
		PaymentMethod:      paymentMethod,
		PayPalOrderID:      cap.OrderID,
		PayPalCaptureID:    &cid,
		Status:             "opened",
		PreQuotaBytes:      user.StorageQuotaBytes,
		ExpiresAt:          expiryAt(time.Now()),
	})
	if err != nil {
		log.Printf("expansion %s persist: %v", paymentMethod, err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "persist order"})
		return nil, false
	}
	return r, true
}

func (h *Handler) notifyAdmins(ctx context.Context, r *models.ServerExpansionRequest) {
	adminEmails, err := h.queries.ListAdminEmails(ctx)
	if err != nil {
		log.Printf("expansion notify: list admin emails: %v", err)
		return
	}
	if err := h.emailSvc.SendExpansionRequestNotification(
		ctx,
		adminEmails,
		r.Username,
		r.UserEmail,
		r.ServerName,
		planLabel(r.PlanID, r.StorageType),
		formatCents(r.DepositAmountCents, r.Currency),
		r.ExpiresAt.Format(time.RFC1123),
	); err != nil {
		log.Printf("expansion notify: send email: %v", err)
	}
}

func (h *Handler) currentUsername(c *gin.Context) (string, bool) {
	username := c.GetString("username")
	if username == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return "", false
	}
	return username, true
}

func (h *Handler) resolvePlan(c *gin.Context, planID, storageType string) (billing.Plan, int, int, bool) {
	pl, found := billing.LookupPlan(planID)
	if !found {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "unknown plan_id"})
		return billing.Plan{}, 0, 0, false
	}
	fullCents, ok := pl.PriceCents[storageType]
	if !ok {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "unknown storage_type for plan"})
		return billing.Plan{}, 0, 0, false
	}
	return pl, fullCents, fullCents / 2, true
}

func (h *Handler) parseID(c *gin.Context) (uuid.UUID, bool) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return uuid.UUID{}, false
	}
	return id, true
}

func (h *Handler) currencyOrDefault() string {
	if h.cfg.Currency != "" {
		return h.cfg.Currency
	}
	return "USD"
}

func planLabel(planID, storageType string) string {
	labels := map[string]string{
		"64gb": "64 GB", "128gb": "128 GB", "256gb": "256 GB",
		"512gb": "512 GB", "1tb": "1 TB",
	}
	label := labels[planID]
	if label == "" {
		label = planID
	}
	return label + " " + strings.ToUpper(storageType)
}

func formatCents(cents int, currency string) string {
	symbol := "$"
	switch strings.ToUpper(currency) {
	case "EUR":
		symbol = "€"
	case "GBP":
		symbol = "£"
	}
	return fmt.Sprintf("%s%d.%02d", symbol, cents/100, cents%100)
}
