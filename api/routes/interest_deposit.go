package routes

import (
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/billing"
)

// resolveDepositPlan resolves a fixed plan for the interest-form deposit
// endpoints. Custom/arbitrary storage amounts are not allowed — every
// request-access deposit uses the same fixed-tier pricing as a direct
// storage purchase or expansion request. Returns (plan, full price cents,
// 50% deposit cents, ok).
func (h *Handler) resolveDepositPlan(c *gin.Context, planID, storageType string) (billing.Plan, int, int, bool) {
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

func (h *Handler) currencyOrDefault() string {
	if h.interestDepositCfg.Currency != "" {
		return h.interestDepositCfg.Currency
	}
	return "USD"
}

// CreateInterestDepositOrder creates a PayPal order for the 50% deposit on a
// fixed storage plan, before the visitor has submitted the rest of the
// interest form.
// POST /api/v1/interest/deposit/orders
// Body: { plan_id, storage_type, payment_method }
// Returns: { order_id, approve_url }
func (h *Handler) CreateInterestDepositOrder(c *gin.Context) {
	if h.paypal == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}

	var req struct {
		PlanID        string `json:"plan_id"        binding:"required"`
		StorageType   string `json:"storage_type"   binding:"required,oneof=nvme hdd"`
		PaymentMethod string `json:"payment_method" binding:"required,oneof=paypal card"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	_, fullCents, depositCents, ok := h.resolveDepositPlan(c, req.PlanID, req.StorageType)
	if !ok {
		return
	}

	currency := h.currencyOrDefault()
	result, err := h.paypal.CreateWalletOrder(
		c.Request.Context(), depositCents, currency, h.interestDepositCfg.ReturnURL, h.interestDepositCfg.CancelURL,
	)
	if err != nil {
		log.Printf("interest deposit CreateOrder paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal error"})
		return
	}

	if err := h.queries.CreateInterestDepositOrder(c.Request.Context(), &models.InterestDepositOrder{
		OrderID:            result.OrderID,
		PlanID:             req.PlanID,
		StorageType:        req.StorageType,
		FullPriceCents:     fullCents,
		DepositAmountCents: depositCents,
		Currency:           currency,
		PaymentMethod:      req.PaymentMethod,
	}); err != nil {
		log.Printf("interest deposit CreateOrder persist: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "persist order"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"order_id":    result.OrderID,
		"approve_url": result.ApproveURL,
	})
}

// CaptureInterestDepositOrder captures an approved PayPal deposit order.
// POST /api/v1/interest/deposit/orders/:order_id/capture
// Returns: { capture_id, status }
func (h *Handler) CaptureInterestDepositOrder(c *gin.Context) {
	if h.paypal == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}
	orderID := c.Param("order_id")
	if orderID == "" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "order_id required"})
		return
	}

	order, err := h.queries.GetInterestDepositOrder(c.Request.Context(), orderID)
	if err != nil {
		log.Printf("interest deposit capture: load order: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return
	}
	if order == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	if order.CapturedAt != nil {
		captureID := ""
		if order.PayPalCaptureID != nil {
			captureID = *order.PayPalCaptureID
		}
		c.JSON(http.StatusOK, gin.H{"capture_id": captureID, "status": "COMPLETED"})
		return
	}

	cap, err := h.paypal.CaptureOrder(c.Request.Context(), orderID)
	if err != nil {
		log.Printf("interest deposit capture: paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "paypal capture failed"})
		return
	}
	if cap.AmountCents != order.DepositAmountCents {
		log.Printf("interest deposit capture: amount mismatch: got %d, expected %d", cap.AmountCents, order.DepositAmountCents)
		c.AbortWithStatusJSON(http.StatusUnprocessableEntity, gin.H{"error": "payment amount does not match deposit"})
		return
	}

	if err := h.queries.MarkInterestDepositOrderCaptured(c.Request.Context(), orderID, cap.CaptureID); err != nil {
		log.Printf("interest deposit capture: mark captured: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "record capture"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"capture_id": cap.CaptureID, "status": cap.Status})
}

// CreateGooglePayInterestDeposit charges the 50% deposit via Google Pay.
// POST /api/v1/interest/deposit/orders/google-pay
// Body: { plan_id, storage_type, payment_token }
// Returns: { order_id }
func (h *Handler) CreateGooglePayInterestDeposit(c *gin.Context) {
	if h.paypal == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}

	var req struct {
		PlanID       string `json:"plan_id"       binding:"required"`
		StorageType  string `json:"storage_type"  binding:"required,oneof=nvme hdd"`
		PaymentToken string `json:"payment_token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	_, fullCents, depositCents, ok := h.resolveDepositPlan(c, req.PlanID, req.StorageType)
	if !ok {
		return
	}

	currency := h.currencyOrDefault()
	cap, err := h.paypal.DirectChargeGooglePay(c.Request.Context(), depositCents, currency, req.PaymentToken)
	if err != nil {
		log.Printf("interest deposit google-pay: %v", err)
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": err.Error()})
		return
	}

	capturedAt := time.Now()
	if err := h.queries.CreateInterestDepositOrder(c.Request.Context(), &models.InterestDepositOrder{
		OrderID:            cap.OrderID,
		PlanID:             req.PlanID,
		StorageType:        req.StorageType,
		FullPriceCents:     fullCents,
		DepositAmountCents: depositCents,
		Currency:           currency,
		PaymentMethod:      "google_pay",
		PayPalCaptureID:    &cap.CaptureID,
		CapturedAt:         &capturedAt,
	}); err != nil {
		log.Printf("interest deposit google-pay: persist: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "persist order"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"order_id": cap.OrderID})
}
