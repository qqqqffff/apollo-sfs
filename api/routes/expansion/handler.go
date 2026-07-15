package expansion

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/billing"
	"apollo-sfs.com/api/routes/middleware"
	"apollo-sfs.com/api/routes/services"
)

const (
	// approvalSLABusinessDays is how many business days the admin has to
	// approve a standard expansion request before the deposit is auto-refunded.
	approvalSLABusinessDays = 7
	// customReviewSLABusinessDays is the manual-review SLA for custom capacity
	// requests (1 TiB – 10 PiB): the invoice must be sent within this window.
	customReviewSLABusinessDays = 3
	// expansionSLABusinessDays is how many business days after approval the
	// capacity must be expanded before the deposit is auto-refunded.
	expansionSLABusinessDays = 14
	// invoiceAcceptBusinessDays is how long the user has to review, accept and
	// pay the deposit on a custom-capacity invoice before the request expires.
	invoiceAcceptBusinessDays = 14
	// balanceRevertDays: when the remaining balance is still unpaid this many
	// calendar days after it came due, the provisioned allocation is reverted
	// and the deposit kept.
	balanceRevertDays = 30
	// maxFailedRequests: users with this many cancelled / non-paid / refunded
	// / rejected requests can no longer open expansion or custom requests.
	maxFailedRequests = 3
)

// balanceReminderOffsetsDays are the calendar-day offsets (after the balance
// came due) at which the three reminder emails go out: 7 days after due,
// 1 week before the 30-day revert, and 1 day before the revert.
var balanceReminderOffsetsDays = [...]int{7, balanceRevertDays - 7, balanceRevertDays - 1}

// Config holds URL templates used for the PayPal wallet redirect flow.
type Config struct {
	Currency  string
	ReturnURL string // e.g. "apollosfs://billing/expansion/complete"
	CancelURL string // e.g. "apollosfs://billing/expansion/cancel"
	// AppURL is used to build the payment deep-link sent in the payment-due email.
	// e.g. "https://files.example.com" — the email links to apollosfs://expansion/pay/{id}
	AppURL string
	// AppName is used on generated invoice PDFs. Defaults to "Apollo SFS".
	AppName string
}

// Handler serves expansion-request endpoints for both users and admins.
type Handler struct {
	paypal   services.PayPalClients
	emailSvc *services.EmailService
	queries  Querier
	cfg      Config
}

// NewHandler constructs an expansion Handler.
func NewHandler(paypal services.PayPalClients, email *services.EmailService, q Querier, cfg Config) *Handler {
	return &Handler{paypal: paypal, emailSvc: email, queries: q, cfg: cfg}
}

// resolveClient picks the PayPal client for the calling user's current
// sandbox-payments toggle state, along with the environment string to stamp
// on newly created requests. Returns a nil client when that environment
// isn't configured (callers 503).
func (h *Handler) resolveClient(c *gin.Context) (*services.PayPalClient, string) {
	env := services.PayPalEnvLive
	if middleware.SandboxEnabled(c) {
		env = services.PayPalEnvSandbox
	}
	return h.paypal.For(env), env
}

// ── User deposit endpoints ─────────────────────────────────────────────────────

// CreateWalletOrder creates a PayPal wallet order for a 50% expansion deposit.
// POST /api/v1/billing/storage/expansion/order
// Body: { plan_id, storage_type, server_id }
// Returns: { order_id, approval_url, deposit_cents, full_price_cents }
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
		ServerID    string `json:"server_id"    binding:"required"`
		CustomBytes int64  `json:"custom_bytes"`
		// Platform is "web" for the browser frontend, which needs a real
		// http(s) return/cancel URL (unlike the mobile app's apollosfs://
		// deep link, which is the default when this is omitted).
		Platform string `json:"platform"`
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

	pl, fullCents, depositCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType, username, serverID)
	if !ok {
		return
	}

	if !h.checkRequestAllowed(c, username) {
		return
	}

	currency := h.currencyOrDefault()
	returnURL, cancelURL := h.cfg.ReturnURL, h.cfg.CancelURL
	if req.Platform == "web" && h.cfg.AppURL != "" {
		returnURL = h.cfg.AppURL + "/checkout/return?flow=expansion"
		cancelURL = h.cfg.AppURL + "/checkout/return?flow=expansion&cancelled=1"
	}
	result, err := client.CreateWalletOrder(
		c.Request.Context(), depositCents, currency, returnURL, cancelURL,
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

	isCustom := req.PlanID == billing.CustomPlanID
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
		IsCustom:           isCustom,
		PreQuotaBytes:      user.StorageQuotaBytes,
		ExpiresAt:          approvalDeadline(time.Now(), isCustom),
		Environment:        env,
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

	client := h.paypal.For(existing.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	cap, err := client.CaptureOrder(c.Request.Context(), orderID)
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
// ── POST /api/v1/billing/storage/expansion/hosted-card ───────────────────────

// CaptureHostedCardExpansion captures a deposit payment for a capacity expansion
// request where the order was created client-side via PayPal's hosted fields JS SDK.
// Body: { plan_id, storage_type, server_id, order_id }.
// Returns { expansion_request_id, expires_at }.
func (h *Handler) CaptureHostedCardExpansion(c *gin.Context) {
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
		ServerID    string `json:"server_id"    binding:"required"`
		OrderID     string `json:"order_id"     binding:"required"`
		CustomBytes int64  `json:"custom_bytes"`
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

	pl, fullCents, depositCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType, username, serverID)
	if !ok {
		return
	}

	if !h.checkRequestAllowed(c, username) {
		return
	}

	cap, err := client.CaptureOrder(c.Request.Context(), req.OrderID)
	if err != nil {
		log.Printf("expansion CaptureHostedCardExpansion paypal capture: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal capture failed"})
		return
	}

	if cap.AmountCents != depositCents {
		log.Printf("expansion CaptureHostedCardExpansion amount mismatch: got %d, expected %d", cap.AmountCents, depositCents)
		c.AbortWithStatusJSON(http.StatusUnprocessableEntity, gin.H{"error": "payment amount does not match deposit"})
		return
	}

	r, ok := h.persistDirectExpansion(c, username, serverID, req.PlanID, req.StorageType, "hosted_card", pl, fullCents, depositCents, cap, env)
	if !ok {
		return
	}
	go h.notifyAdmins(c.Request.Context(), r)
	c.JSON(http.StatusCreated, gin.H{
		"expansion_request_id": r.ID,
		"expires_at":           r.ExpiresAt,
	})
}

// POST /api/v1/billing/storage/expansion/card
func (h *Handler) ChargeCardExpansion(c *gin.Context) {
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
		ServerID    string `json:"server_id"    binding:"required"`
		CustomBytes int64  `json:"custom_bytes"`
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

	pl, fullCents, depositCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType, username, serverID)
	if !ok {
		return
	}

	if !h.checkRequestAllowed(c, username) {
		return
	}

	cap, err := client.DirectChargeCard(c.Request.Context(), services.CardOrderInput{
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

	r, ok := h.persistDirectExpansion(c, username, serverID, req.PlanID, req.StorageType, "card", pl, fullCents, depositCents, cap, env)
	if !ok {
		return
	}
	h.notifyAdmins(c.Request.Context(), r)
	c.JSON(http.StatusCreated, gin.H{"expansion_request_id": r.ID, "expires_at": r.ExpiresAt})
}

// ChargeApplePayExpansion processes an Apple Pay deposit.
// POST /api/v1/billing/storage/expansion/apple-pay
func (h *Handler) ChargeApplePayExpansion(c *gin.Context) {
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
		ServerID    string `json:"server_id"    binding:"required"`
		CustomBytes int64  `json:"custom_bytes"`
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

	pl, fullCents, depositCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType, username, serverID)
	if !ok {
		return
	}

	if !h.checkRequestAllowed(c, username) {
		return
	}

	cap, err := client.DirectChargeApplePay(c.Request.Context(), services.ApplePayTokenInput{
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

	r, ok := h.persistDirectExpansion(c, username, serverID, req.PlanID, req.StorageType, "apple_pay", pl, fullCents, depositCents, cap, env)
	if !ok {
		return
	}
	h.notifyAdmins(c.Request.Context(), r)
	c.JSON(http.StatusCreated, gin.H{"expansion_request_id": r.ID, "expires_at": r.ExpiresAt})
}

// ChargeGooglePayExpansion processes a Google Pay deposit.
// POST /api/v1/billing/storage/expansion/google-pay
func (h *Handler) ChargeGooglePayExpansion(c *gin.Context) {
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
		PlanID         string `json:"plan_id"          binding:"required"`
		StorageType    string `json:"storage_type"     binding:"required,oneof=nvme hdd"`
		ServerID       string `json:"server_id"        binding:"required"`
		CustomBytes    int64  `json:"custom_bytes"`
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

	pl, fullCents, depositCents, ok := h.resolvePlan(c, req.PlanID, req.StorageType, username, serverID)
	if !ok {
		return
	}

	if !h.checkRequestAllowed(c, username) {
		return
	}

	cap, err := client.DirectChargeGooglePay(
		c.Request.Context(), depositCents, h.currencyOrDefault(), req.GooglePayToken,
	)
	if err != nil {
		log.Printf("expansion ChargeGooglePay paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": err.Error()})
		return
	}

	r, ok := h.persistDirectExpansion(c, username, serverID, req.PlanID, req.StorageType, "google_pay", pl, fullCents, depositCents, cap, env)
	if !ok {
		return
	}
	h.notifyAdmins(c.Request.Context(), r)
	c.JSON(http.StatusCreated, gin.H{"expansion_request_id": r.ID, "expires_at": r.ExpiresAt})
}

// ── Custom capacity requests (estimated price, invoiced after review) ─────────

// SubmitCustomRequest opens a custom capacity request WITHOUT collecting any
// payment. The price shown to the user is an estimate; an admin manually
// reviews the request within 3 business days and sends an invoice with the
// final amount.
// POST /api/v1/billing/storage/expansion/custom
// Body: { storage_type, server_id, custom_bytes }
// Returns: { expansion_request_id, review_due_at, estimated_price_cents }
func (h *Handler) SubmitCustomRequest(c *gin.Context) {
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}
	if !h.checkRequestAllowed(c, username) {
		return
	}

	var req struct {
		StorageType string `json:"storage_type" binding:"required,oneof=nvme hdd"`
		ServerID    string `json:"server_id"    binding:"required"`
		CustomBytes int64  `json:"custom_bytes" binding:"required"`
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

	pl, err := billing.CustomPlan(req.CustomBytes, req.StorageType)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	estimateCents := pl.PriceCents[req.StorageType]

	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil || user == nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load user"})
		return
	}

	// No PayPal call happens for a custom request until the invoice deposit is
	// paid, but the environment is decided now (from the submitter's own
	// toggle state) so CreateInvoiceDepositOrder/CaptureInvoiceDepositOrder
	// have a stable value to read back regardless of how the admin's own
	// toggle might change before the invoice is sent.
	env := services.PayPalEnvLive
	if middleware.SandboxEnabled(c) {
		env = services.PayPalEnvSandbox
	}

	reviewDue := approvalDeadline(time.Now(), true)
	r, err := h.queries.CreateExpansionRequest(c.Request.Context(), db.CreateExpansionRequestParams{
		Username:       username,
		ServerID:       serverID,
		PlanID:         billing.CustomPlanID,
		StorageType:    req.StorageType,
		BytesRequested: pl.BytesAdded,
		// The estimate is recorded for reference; the invoice sets the final
		// amounts on acceptance. No deposit has been collected yet.
		DepositAmountCents: 0,
		FullPriceCents:     estimateCents,
		Currency:           h.currencyOrDefault(),
		PaymentMethod:      "invoice",
		PayPalOrderID:      "",
		Status:             "opened",
		IsCustom:           true,
		PreQuotaBytes:      user.StorageQuotaBytes,
		ExpiresAt:          reviewDue,
		Environment:        env,
	})
	if err != nil {
		log.Printf("expansion SubmitCustomRequest persist: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "persist request"})
		return
	}

	go h.notifyAdmins(context.Background(), r)

	c.JSON(http.StatusCreated, gin.H{
		"expansion_request_id":  r.ID,
		"review_due_at":         reviewDue,
		"estimated_price_cents": estimateCents,
	})
}

// ── Custom invoice endpoints (admin) ──────────────────────────────────────────

// CreateInvoice builds and sends the invoice for a custom request.
// POST /api/v1/admin/expansion-requests/:id/invoice
// Body: { line_items: [{description, amount_cents}], deposit_cents,
//
//	disclosures, notes, include_review_link }
func (h *Handler) CreateInvoice(c *gin.Context) {
	id, ok := h.parseID(c)
	if !ok {
		return
	}

	var body struct {
		LineItems []struct {
			Description string `json:"description"  binding:"required"`
			AmountCents int64  `json:"amount_cents" binding:"required"`
		} `json:"line_items" binding:"required,min=1"`
		DepositCents      int64  `json:"deposit_cents"`
		Disclosures       string `json:"disclosures"`
		Notes             string `json:"notes"`
		IncludeReviewLink bool   `json:"include_review_link"`
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
	if !req.IsCustom {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "only custom requests are invoiced"})
		return
	}
	if req.Status != "opened" && req.Status != "invoice_sent" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "request is not awaiting an invoice"})
		return
	}

	items := make([]models.InvoiceLineItem, 0, len(body.LineItems))
	var total int64
	for _, li := range body.LineItems {
		if li.AmountCents < 0 {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "line item amounts must be positive"})
			return
		}
		items = append(items, models.InvoiceLineItem{Description: li.Description, AmountCents: li.AmountCents})
		total += li.AmountCents
	}
	if body.DepositCents < 0 || body.DepositCents > total {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "deposit must be between 0 and the invoice total"})
		return
	}

	inv, err := h.queries.CreateExpansionInvoice(c.Request.Context(), db.CreateExpansionInvoiceParams{
		RequestID:         id,
		LineItems:         items,
		TotalCents:        total,
		DepositCents:      body.DepositCents,
		Disclosures:       body.Disclosures,
		Notes:             body.Notes,
		IncludeReviewLink: body.IncludeReviewLink,
		AcceptDueAt:       addBusinessDays(time.Now(), invoiceAcceptBusinessDays),
	})
	if err != nil {
		log.Printf("expansion CreateInvoice persist: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "persist invoice"})
		return
	}

	if _, err := h.queries.MarkExpansionInvoiceSent(c.Request.Context(), id); err != nil {
		log.Printf("expansion CreateInvoice mark sent: %v", err)
	}

	reviewURL := ""
	if inv.IncludeReviewLink && inv.ReviewToken != nil {
		reviewURL = fmt.Sprintf("%s/invoice/%s", strings.TrimRight(h.cfg.AppURL, "/"), *inv.ReviewToken)
	}
	depositFmt := ""
	if inv.DepositCents > 0 {
		depositFmt = formatCents(int(inv.DepositCents), req.Currency)
	}

	// Attach the invoice as a real PDF to the email; a render failure is
	// logged but never blocks the send.
	pdf, err := services.RenderInvoicePDF(h.appName(), inv, req)
	if err != nil {
		log.Printf("expansion CreateInvoice render pdf: %v", err)
		pdf = nil
	}

	if err := h.emailSvc.SendExpansionInvoice(
		c.Request.Context(),
		req.UserEmail,
		req.ServerName,
		planLabel(req.PlanID, req.StorageType, req.BytesRequested),
		inv.InvoiceNumber,
		formatCents(int(inv.TotalCents), req.Currency),
		depositFmt,
		inv.AcceptDueAt.Format("Mon, 02 Jan 2006"),
		reviewURL,
		pdf,
	); err != nil {
		log.Printf("expansion CreateInvoice send email: %v", err)
	}

	c.JSON(http.StatusCreated, inv)
}

// appName returns the configured application name for invoice PDFs.
func (h *Handler) appName() string {
	if h.cfg.AppName != "" {
		return h.cfg.AppName
	}
	return "Apollo SFS"
}

// writeInvoicePDF renders and streams an invoice PDF.
func (h *Handler) writeInvoicePDF(c *gin.Context, inv *models.ExpansionInvoice, req *models.ServerExpansionRequest) {
	pdf, err := services.RenderInvoicePDF(h.appName(), inv, req)
	if err != nil {
		log.Printf("expansion invoice pdf: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "render pdf"})
		return
	}
	c.Header("Content-Disposition", fmt.Sprintf("inline; filename=%q", inv.InvoiceNumber+".pdf"))
	c.Data(http.StatusOK, "application/pdf", pdf)
}

// GetMyInvoicePDF streams the invoice PDF for the review page.
// GET /api/v1/billing/invoices/:token/pdf
func (h *Handler) GetMyInvoicePDF(c *gin.Context) {
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}
	inv, req, ok := h.loadInvoiceForUser(c, username, false)
	if !ok {
		return
	}
	h.writeInvoicePDF(c, inv, req)
}

// GetInvoicePDF streams the latest invoice PDF for a request (admin view).
// GET /api/v1/admin/expansion-requests/:id/invoice/pdf
func (h *Handler) GetInvoicePDF(c *gin.Context) {
	id, ok := h.parseID(c)
	if !ok {
		return
	}
	inv, err := h.queries.GetLatestExpansionInvoice(c.Request.Context(), id)
	if err != nil || inv == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "no invoice for request"})
		return
	}
	req, err := h.queries.GetExpansionRequestByID(c.Request.Context(), id)
	if err != nil || req == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "request not found"})
		return
	}
	h.writeInvoicePDF(c, inv, req)
}

// GetInvoice returns the latest invoice for a request (admin view).
// GET /api/v1/admin/expansion-requests/:id/invoice
func (h *Handler) GetInvoice(c *gin.Context) {
	id, ok := h.parseID(c)
	if !ok {
		return
	}
	inv, err := h.queries.GetLatestExpansionInvoice(c.Request.Context(), id)
	if err != nil {
		log.Printf("expansion GetInvoice: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load invoice"})
		return
	}
	if inv == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "no invoice for request"})
		return
	}
	c.JSON(http.StatusOK, inv)
}

// ── Custom invoice endpoints (user) ───────────────────────────────────────────

// loadInvoiceForUser resolves the :token invoice, verifies ownership and that
// it is still pending acceptance.
func (h *Handler) loadInvoiceForUser(c *gin.Context, username string, mustBePending bool) (*models.ExpansionInvoice, *models.ServerExpansionRequest, bool) {
	token := c.Param("token")
	if token == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "token required"})
		return nil, nil, false
	}
	inv, err := h.queries.GetExpansionInvoiceByToken(c.Request.Context(), token)
	if err != nil {
		log.Printf("expansion loadInvoiceForUser: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load invoice"})
		return nil, nil, false
	}
	if inv == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "invoice not found"})
		return nil, nil, false
	}
	req, err := h.queries.GetExpansionRequestByID(c.Request.Context(), inv.RequestID)
	if err != nil || req == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "request not found"})
		return nil, nil, false
	}
	if req.Username != username {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "invoice does not belong to user"})
		return nil, nil, false
	}
	if mustBePending {
		if inv.Status != "sent" {
			c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "invoice is not awaiting acceptance"})
			return nil, nil, false
		}
		if time.Now().After(inv.AcceptDueAt) {
			c.AbortWithStatusJSON(http.StatusGone, gin.H{"error": "invoice acceptance window has expired"})
			return nil, nil, false
		}
	}
	return inv, req, true
}

// GetMyInvoice returns the invoice + request summary for the review page.
// GET /api/v1/billing/invoices/:token
func (h *Handler) GetMyInvoice(c *gin.Context) {
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}
	inv, req, ok := h.loadInvoiceForUser(c, username, false)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"invoice": inv, "request": req})
}

// AcceptInvoice accepts an invoice that requires NO deposit.
// POST /api/v1/billing/invoices/:token/accept
func (h *Handler) AcceptInvoice(c *gin.Context) {
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}
	inv, req, ok := h.loadInvoiceForUser(c, username, true)
	if !ok {
		return
	}
	if inv.DepositCents > 0 {
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": "this invoice requires a deposit payment"})
		return
	}
	if _, err := h.queries.AcceptExpansionInvoice(c.Request.Context(), inv.ID, nil, nil); err != nil {
		log.Printf("expansion AcceptInvoice: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "accept invoice"})
		return
	}
	approvalDue := addBusinessDays(time.Now(), approvalSLABusinessDays)
	if _, err := h.queries.AcceptExpansionRequestInvoice(
		c.Request.Context(), req.ID, 0, inv.TotalCents, "", nil, approvalDue,
	); err != nil {
		log.Printf("expansion AcceptInvoice request: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "update request"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "accepted"})
}

// DeclineInvoice rejects the invoice and the underlying request.
// POST /api/v1/billing/invoices/:token/decline
func (h *Handler) DeclineInvoice(c *gin.Context) {
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}
	inv, req, ok := h.loadInvoiceForUser(c, username, true)
	if !ok {
		return
	}
	if err := h.queries.SetExpansionInvoiceStatus(c.Request.Context(), inv.ID, "cancelled"); err != nil {
		log.Printf("expansion DeclineInvoice: %v", err)
	}
	if _, err := h.queries.RejectExpansionRequest(c.Request.Context(), req.ID, "invoice declined by user"); err != nil {
		log.Printf("expansion DeclineInvoice request: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "update request"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "declined"})
}

// CreateInvoiceDepositOrder creates the PayPal order for the invoice deposit.
// POST /api/v1/billing/invoices/:token/order
// Returns { order_id, approval_url, deposit_cents }
func (h *Handler) CreateInvoiceDepositOrder(c *gin.Context) {
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}
	inv, req, ok := h.loadInvoiceForUser(c, username, true)
	if !ok {
		return
	}
	if inv.DepositCents <= 0 {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "invoice has no deposit — accept it directly"})
		return
	}
	// Use the environment the parent request was created against, so it's
	// stable regardless of the current caller's toggle state.
	client := h.paypal.For(req.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}

	result, err := client.CreateWalletOrder(
		c.Request.Context(), int(inv.DepositCents), req.Currency, h.cfg.ReturnURL, h.cfg.CancelURL,
	)
	if err != nil {
		log.Printf("expansion CreateInvoiceDepositOrder paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal error"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"order_id":      result.OrderID,
		"approval_url":  result.ApproveURL,
		"deposit_cents": inv.DepositCents,
	})
}

// CaptureInvoiceDepositOrder captures the deposit and accepts the invoice.
// POST /api/v1/billing/invoices/:token/order/:order_id/capture
func (h *Handler) CaptureInvoiceDepositOrder(c *gin.Context) {
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}
	inv, req, ok := h.loadInvoiceForUser(c, username, true)
	if !ok {
		return
	}

	orderID := c.Param("order_id")
	if orderID == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "order_id required"})
		return
	}

	client := h.paypal.For(req.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	cap, err := client.CaptureOrder(c.Request.Context(), orderID)
	if err != nil {
		log.Printf("expansion CaptureInvoiceDepositOrder paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal capture failed"})
		return
	}
	if cap.AmountCents != int(inv.DepositCents) {
		log.Printf("expansion CaptureInvoiceDepositOrder amount mismatch: got %d, expected %d", cap.AmountCents, inv.DepositCents)
		c.AbortWithStatusJSON(http.StatusUnprocessableEntity, gin.H{"error": "payment amount does not match deposit"})
		return
	}

	cid := cap.CaptureID
	if _, err := h.queries.AcceptExpansionInvoice(c.Request.Context(), inv.ID, &cap.OrderID, &cid); err != nil {
		log.Printf("expansion CaptureInvoiceDepositOrder invoice: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "accept invoice"})
		return
	}
	approvalDue := addBusinessDays(time.Now(), approvalSLABusinessDays)
	if _, err := h.queries.AcceptExpansionRequestInvoice(
		c.Request.Context(), req.ID, inv.DepositCents, inv.TotalCents, cap.OrderID, &cid, approvalDue,
	); err != nil {
		log.Printf("expansion CaptureInvoiceDepositOrder request: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "update request"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "accepted"})
}

// ── User pay-remaining endpoints ──────────────────────────────────────────────
// These are reached after the admin marks the request as expanded.
// The user pays the remaining 50% balance; on success the quota is added.

// PayRemainingWalletOrder creates a PayPal wallet order for the remaining balance.
// POST /api/v1/billing/storage/expansion/:id/pay-remaining/order
// Returns: { order_id, approval_url }
func (h *Handler) PayRemainingWalletOrder(c *gin.Context) {
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	req, ok := h.loadExpandedRequest(c, username)
	if !ok {
		return
	}
	// Use the environment this request was created against, not the caller's
	// current toggle state.
	client := h.paypal.For(req.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	remainingCents := req.FullPriceCents - req.DepositAmountCents

	// Platform is "web" for the browser frontend (?platform=web query param,
	// since this endpoint takes no JSON body), which needs a real http(s)
	// return/cancel URL carrying the expansion request id — capture needs it
	// (unlike the mobile app's apollosfs:// deep link, the default otherwise).
	returnURL, cancelURL := h.cfg.ReturnURL, h.cfg.CancelURL
	if c.Query("platform") == "web" && h.cfg.AppURL != "" {
		returnURL = h.cfg.AppURL + "/checkout/return?flow=pay_remaining&request_id=" + req.ID.String()
		cancelURL = h.cfg.AppURL + "/checkout/return?flow=pay_remaining&request_id=" + req.ID.String() + "&cancelled=1"
	}

	result, err := client.CreateWalletOrder(
		c.Request.Context(), remainingCents, req.Currency, returnURL, cancelURL,
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

	client := h.paypal.For(req.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	cap, err := client.CaptureOrder(c.Request.Context(), orderID)
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
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	req, ok := h.loadExpandedRequest(c, username)
	if !ok {
		return
	}
	client := h.paypal.For(req.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
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
	cap, err := client.DirectChargeCard(c.Request.Context(), services.CardOrderInput{
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
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	req, ok := h.loadExpandedRequest(c, username)
	if !ok {
		return
	}
	client := h.paypal.For(req.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
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
	cap, err := client.DirectChargeApplePay(c.Request.Context(), services.ApplePayTokenInput{
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
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}

	req, ok := h.loadExpandedRequest(c, username)
	if !ok {
		return
	}
	client := h.paypal.For(req.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
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
	cap, err := client.DirectChargeGooglePay(
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

// ListRequests returns searched, sorted, offset-paginated expansion requests.
// GET /api/v1/admin/expansion-requests?status=&server_id=&is_custom=&search=&sort=&page=&page_size=
func (h *Handler) ListRequests(c *gin.Context) {
	f := db.ExpansionRequestFilter{
		Status: c.Query("status"),
		Search: strings.TrimSpace(c.Query("search")),
		Sort:   c.Query("sort"),
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
	if ic := c.Query("is_custom"); ic != "" {
		v := ic == "true" || ic == "1"
		f.IsCustom = &v
	}

	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "25"))
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}

	items, total, err := h.queries.ListExpansionRequests(c.Request.Context(), f, pageSize, (page-1)*pageSize)
	if err != nil {
		log.Printf("expansion ListRequests: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	if items == nil {
		items = []models.ServerExpansionRequest{}
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "total": total, "page": page, "page_size": pageSize})
}

// ApproveRequest transitions an 'opened' (standard) or 'accepted' (custom,
// invoice approved) request to 'approved', starting the 14-business-day
// expansion SLA clock. If the expansion is not completed by then, the deposit
// is refunded automatically by the expiry loop.
// POST /api/v1/admin/expansion-requests/:id/approve
func (h *Handler) ApproveRequest(c *gin.Context) {
	id, ok := h.parseID(c)
	if !ok {
		return
	}

	req, err := h.queries.GetExpansionRequestByID(c.Request.Context(), id)
	if err != nil || req == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if req.Status != "opened" && req.Status != "accepted" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "request must be in 'opened' or 'accepted' state"})
		return
	}
	// Custom requests must go through invoicing first; standard requests must
	// have their deposit captured. An accepted zero-deposit invoice is fine.
	if req.IsCustom && req.Status == "opened" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "send and collect the invoice before approving a custom request"})
		return
	}
	if !req.IsCustom && req.PayPalCaptureID == nil {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "deposit not yet captured"})
		return
	}

	expansionDue := addBusinessDays(time.Now(), expansionSLABusinessDays)
	updated, err := h.queries.ApproveExpansionRequest(c.Request.Context(), id, expansionDue)
	if err != nil {
		log.Printf("expansion ApproveRequest: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "update status"})
		return
	}
	if !updated {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "concurrent modification"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"expansion_due_at": expansionDue})
}

// ListMine returns the calling user's expansion requests, newest first.
// GET /api/v1/billing/storage/expansion/requests
func (h *Handler) ListMine(c *gin.Context) {
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}
	items, err := h.queries.ListUserExpansionRequests(c.Request.Context(), username)
	if err != nil {
		log.Printf("expansion ListMine: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	if items == nil {
		items = []models.ServerExpansionRequest{}
	}
	c.JSON(http.StatusOK, gin.H{"items": items})
}

// MarkExpanded ("provision") verifies the server has capacity, provisions the
// quota immediately, sets status='expanded' and starts collecting the
// remaining balance: a reminder email goes out if it is unpaid after 7
// business days, and the allocation is reverted (deposit kept) 30 days after
// the balance came due.
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
	if req.Status != "opened" && req.Status != "approved" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "request must be in 'opened' or 'approved' state"})
		return
	}
	if req.PayPalCaptureID == nil && req.DepositAmountCents > 0 {
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

	// Provision the quota now; the remaining balance is collected afterwards.
	newQuota, err := h.queries.AddUserQuotaAndAllocation(c.Request.Context(), req.Username, &drive.DriveID, req.BytesRequested)
	if err != nil {
		log.Printf("expansion MarkExpanded add quota: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "provision quota"})
		return
	}

	updated, err := h.queries.ProvisionExpansionRequest(c.Request.Context(), id, newQuota)
	if err != nil || !updated {
		// Roll the quota back if the status flip lost a race.
		if _, rbErr := h.queries.AddUserQuotaAndAllocation(c.Request.Context(), req.Username, &drive.DriveID, -req.BytesRequested); rbErr != nil {
			log.Printf("expansion MarkExpanded rollback quota: %v", rbErr)
		}
		log.Printf("expansion MarkExpanded: err=%v updated=%v", err, updated)
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "concurrent modification"})
		return
	}

	// Build a deep-link the user taps from the email to open the payment UI in the app.
	paymentURL := fmt.Sprintf("apollosfs://expansion/pay/%s", id)
	remainingCents := req.FullPriceCents - req.DepositAmountCents
	revertAt := time.Now().AddDate(0, 0, balanceRevertDays)

	if remainingCents > 0 {
		if err := h.emailSvc.SendExpansionPaymentDue(
			c.Request.Context(),
			req.UserEmail,
			req.ServerName,
			planLabel(req.PlanID, req.StorageType, req.BytesRequested),
			formatCents(remainingCents, req.Currency),
			revertAt.Format("Mon, 02 Jan 2006"),
			paymentURL,
		); err != nil {
			log.Printf("expansion MarkExpanded send email: %v", err)
		}
	} else {
		// Nothing left to collect — complete immediately.
		if _, err := h.queries.MarkExpansionRequestPaid(c.Request.Context(), id); err != nil {
			log.Printf("expansion MarkExpanded autocomplete: %v", err)
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"new_quota_bytes": newQuota,
		"payment_due_at":  time.Now(),
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
	if req.Status != "opened" && req.Status != "invoice_sent" && req.Status != "accepted" &&
		req.Status != "approved" && req.Status != "expanded" {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "request is not cancellable"})
		return
	}

	// Nothing collected yet (custom request pre-invoice / unaccepted invoice):
	// reject without a refund.
	if req.PayPalCaptureID == nil {
		if inv, err := h.queries.GetLatestExpansionInvoice(c.Request.Context(), req.ID); err == nil && inv != nil && inv.Status == "sent" {
			if err := h.queries.SetExpansionInvoiceStatus(c.Request.Context(), inv.ID, "cancelled"); err != nil {
				log.Printf("expansion CancelRequest cancel invoice: %v", err)
			}
		}
		if _, err := h.queries.RejectExpansionRequest(c.Request.Context(), id, body.Reason); err != nil {
			log.Printf("expansion CancelRequest reject: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "record rejection"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"refund_id": nil, "status": "rejected"})
		return
	}

	// Use the environment this request was created against, not whichever
	// admin happens to be issuing the cancellation.
	client := h.paypal.For(req.Environment)
	if client == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}

	refund, err := client.RefundCapture(c.Request.Context(), *req.PayPalCaptureID, req.DepositAmountCents, req.Currency)
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
		planLabel(req.PlanID, req.StorageType, req.BytesRequested),
		formatCents(req.DepositAmountCents, req.Currency),
		body.Reason,
	); err != nil {
		log.Printf("expansion CancelRequest send email: %v", err)
	}

	c.JSON(http.StatusOK, gin.H{"refund_id": refund.RefundID})
}

// ── Background expiry loop ────────────────────────────────────────────────────

// StartExpiryLoop spawns a goroutine that checks every hour for:
//   - 'opened'/'accepted' requests past their approval SLA (7 business days;
//     3 for custom manual review) → refund deposit (when one was collected),
//     mark expired
//   - 'approved' requests past their 14-business-day expansion SLA → refund
//     deposit, mark expired
//   - 'invoice_sent' custom requests past the 14-business-day acceptance
//     window → expire invoice + request (nothing was collected)
//   - 'expanded' requests with the balance unpaid 7 business days after it
//     came due → send a one-time reminder email
//   - 'expanded' requests with the balance unpaid 30 days after it came due →
//     revert the provisioned allocation and keep the deposit
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
				h.processExpansionSLAMissed(ctx)
				h.processExpiredInvoices(ctx)
				h.processUnpaidBalances(ctx)
			}
		}
	}()
}

// processExpired handles 'opened' requests that have passed their approval
// SLA. The deposit is refunded via PayPal.
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

// processExpansionSLAMissed handles 'approved' requests whose 14-business-day
// expansion SLA elapsed without the capacity being expanded. The deposit is
// refunded via PayPal.
func (h *Handler) processExpansionSLAMissed(ctx context.Context) {
	expired, err := h.queries.ListExpiredApprovedRequests(ctx)
	if err != nil {
		log.Printf("expansion expiry: list approved: %v", err)
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
	client := h.paypal.For(r.Environment)
	if client == nil {
		log.Printf("expansion expiry %s: paypal not configured, skipping", r.ID)
		return
	}
	refund, err := client.RefundCapture(ctx, *r.PayPalCaptureID, r.DepositAmountCents, r.Currency)
	if err != nil {
		log.Printf("expansion expiry %s: paypal refund: %v", r.ID, err)
		return
	}
	if err := h.queries.ExpireExpansionRequest(ctx, r.ID, refund.RefundID); err != nil {
		log.Printf("expansion expiry %s: mark expired: %v", r.ID, err)
	}
}

// processExpiredInvoices expires 'sent' custom invoices whose 14-business-day
// acceptance window elapsed, along with their requests. Nothing was collected,
// so there is nothing to refund.
func (h *Handler) processExpiredInvoices(ctx context.Context) {
	invoices, err := h.queries.ListExpiredSentInvoices(ctx)
	if err != nil {
		log.Printf("expansion expiry: list invoices: %v", err)
		return
	}
	for i := range invoices {
		inv := &invoices[i]
		if err := h.queries.SetExpansionInvoiceStatus(ctx, inv.ID, "expired"); err != nil {
			log.Printf("expansion invoice expiry %s: %v", inv.ID, err)
			continue
		}
		if err := h.queries.ExpireExpansionRequest(ctx, inv.RequestID, ""); err != nil {
			log.Printf("expansion invoice expiry %s: expire request: %v", inv.ID, err)
		}
	}
}

// processUnpaidBalances walks 'expanded' requests still awaiting their
// remaining balance. Three reminder emails go out on a calendar-day schedule
// (7 days after the balance came due, 1 week before the 30-day revert, and
// 1 day before the revert); once the balance is 30 calendar days overdue the
// allocation is reverted and the deposit kept.
func (h *Handler) processUnpaidBalances(ctx context.Context) {
	unpaid, err := h.queries.ListUnpaidExpandedRequests(ctx)
	if err != nil {
		log.Printf("expansion expiry: list unpaid: %v", err)
		return
	}
	now := time.Now()
	for i := range unpaid {
		r := &unpaid[i]
		if r.PaymentDueAt == nil {
			continue
		}
		remainingCents := r.FullPriceCents - r.DepositAmountCents

		// 30 calendar days overdue → revert the allocation, keep the deposit.
		if now.After(r.PaymentDueAt.AddDate(0, 0, balanceRevertDays)) {
			var driveID *uuid.UUID
			if alloc, _ := h.queries.GetUserDrive(ctx, r.Username); alloc != nil {
				driveID = &alloc.DriveID
			}
			if _, err := h.queries.AddUserQuotaAndAllocation(ctx, r.Username, driveID, -r.BytesRequested); err != nil {
				log.Printf("expansion revert %s: subtract quota: %v", r.ID, err)
				continue
			}
			if err := h.queries.RevertExpansionRequest(ctx, r.ID); err != nil {
				log.Printf("expansion revert %s: %v", r.ID, err)
			}
			continue
		}

		if remainingCents <= 0 {
			continue
		}

		// Send the next due reminder, at most one per pass. Catching up after
		// downtime sends only the latest applicable reminder.
		next := r.RemindersSent
		due := -1
		for k := len(balanceReminderOffsetsDays) - 1; k >= next; k-- {
			if now.After(r.PaymentDueAt.AddDate(0, 0, balanceReminderOffsetsDays[k])) {
				due = k
				break
			}
		}
		if due < 0 {
			continue
		}

		paymentURL := fmt.Sprintf("apollosfs://expansion/pay/%s", r.ID)
		revertAt := r.PaymentDueAt.AddDate(0, 0, balanceRevertDays)
		if err := h.emailSvc.SendExpansionBalanceReminder(
			ctx,
			r.UserEmail,
			r.ServerName,
			planLabel(r.PlanID, r.StorageType, r.BytesRequested),
			formatCents(remainingCents, r.Currency),
			revertAt.Format("Mon, 02 Jan 2006"),
			paymentURL,
		); err != nil {
			log.Printf("expansion reminder %s: %v", r.ID, err)
			continue
		}
		if err := h.queries.MarkExpansionReminderSent(ctx, r.ID, due+1); err != nil {
			log.Printf("expansion reminder %s: mark sent: %v", r.ID, err)
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
	// The balance stays payable until the allocation is reverted (30 days
	// after payment came due) — the revert loop flips the status to 'expired'.
	return req, true
}

// applyRemainingPayment marks the expansion request completed. The quota was
// already provisioned when the admin fulfilled the request, so no quota is
// added here — the user simply settles the outstanding balance.
func (h *Handler) applyRemainingPayment(c *gin.Context, req *models.ServerExpansionRequest, captureID string) (int64, bool) {
	_ = captureID
	updated, err := h.queries.MarkExpansionRequestPaid(c.Request.Context(), req.ID)
	if err != nil || !updated {
		log.Printf("expansion payRemaining complete: err=%v updated=%v", err, updated)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "mark completed"})
		return 0, false
	}
	if req.PostQuotaBytes != nil {
		return *req.PostQuotaBytes, true
	}
	user, err := h.queries.GetUserByUsername(c.Request.Context(), req.Username)
	if err != nil || user == nil {
		return 0, true
	}
	return user.StorageQuotaBytes, true
}

func (h *Handler) persistDirectExpansion(
	c *gin.Context,
	username string,
	serverID uuid.UUID,
	planID, storageType, paymentMethod string,
	pl billing.Plan,
	fullCents, depositCents int,
	cap *services.CaptureOrderResult,
	environment string,
) (*models.ServerExpansionRequest, bool) {
	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil || user == nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load user"})
		return nil, false
	}

	cid := cap.CaptureID
	isCustom := planID == billing.CustomPlanID
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
		IsCustom:           isCustom,
		PreQuotaBytes:      user.StorageQuotaBytes,
		ExpiresAt:          approvalDeadline(time.Now(), isCustom),
		Environment:        environment,
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
		planLabel(r.PlanID, r.StorageType, r.BytesRequested),
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

// resolvePlan resolves a fixed plan for the deposit endpoints. Custom
// capacity is rejected here: custom requests are submitted without payment
// (estimated price only) via SubmitCustomRequest and invoiced after review.
// planID may be a legacy slug or an admin-managed pricing-item UUID — see
// billing.ResolvePlanPrice, which also applies any active discount for this
// user. Returns (plan, full price cents, 50% deposit cents, ok).
func (h *Handler) resolvePlan(c *gin.Context, planID, storageType, username string, serverID uuid.UUID) (billing.Plan, int, int, bool) {
	if planID == billing.CustomPlanID {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{
			"error": "custom capacity requests are invoiced after review — submit via the custom request endpoint",
		})
		return billing.Plan{}, 0, 0, false
	}
	pl, fullCents, err := billing.ResolvePlanPrice(
		c.Request.Context(), h.queries, planID, storageType, username, &serverID,
	)
	switch {
	case err == nil:
		return pl, fullCents, fullCents / 2, true
	case errors.Is(err, billing.ErrPlanNotFound), errors.Is(err, billing.ErrPlanMismatch):
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	default:
		log.Printf("expansion resolvePlan: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "resolve plan"})
	}
	return billing.Plan{}, 0, 0, false
}

// checkRequestAllowed rejects users who have accumulated maxFailedRequests
// cancelled / non-paid / refunded / rejected requests. Returns false after
// writing the error response.
func (h *Handler) checkRequestAllowed(c *gin.Context, username string) bool {
	n, err := h.queries.CountFailedExpansionRequests(c.Request.Context(), username)
	if err != nil {
		log.Printf("expansion checkRequestAllowed: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "check request history"})
		return false
	}
	if n >= maxFailedRequests {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
			"error": "expansion requests are disabled for this account due to repeated cancelled, unpaid or rejected requests",
		})
		return false
	}
	return true
}

// approvalDeadline returns the approval SLA deadline for a new request:
// 3 business days for manually-reviewed custom requests, 7 otherwise.
func approvalDeadline(now time.Time, isCustom bool) time.Time {
	if isCustom {
		return addBusinessDays(now, customReviewSLABusinessDays)
	}
	return addBusinessDays(now, approvalSLABusinessDays)
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

func planLabel(planID, storageType string, bytes int64) string {
	labels := map[string]string{
		"64gb": "64 GB", "128gb": "128 GB", "256gb": "256 GB",
		"512gb": "512 GB", "1tb": "1 TB", billing.CustomPlanID: "Custom",
	}
	label := labels[planID]
	if label == "" {
		// Admin-managed pricing items carry a UUID plan id — label those by
		// their size instead.
		label = formatBytesLabel(bytes)
	}
	return label + " " + strings.ToUpper(storageType)
}

// formatBytesLabel renders a storage quantity the way plan labels do:
// whole GB below 1 TiB, and TB with up to two decimals above.
func formatBytesLabel(bytes int64) string {
	const gib = int64(1) << 30
	const tib = int64(1) << 40
	if bytes <= 0 {
		return "0 GB"
	}
	if bytes < tib {
		return fmt.Sprintf("%d GB", (bytes+gib-1)/gib)
	}
	tb := float64(bytes) / float64(tib)
	s := strconv.FormatFloat(tb, 'f', 2, 64)
	s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	return s + " TB"
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
