package routes

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/billing"
)

const (
	// maxIPSubmissions is the lifetime cap on submissions per source IP.
	maxIPSubmissions = 5
	// turnstileVerifyURL is Cloudflare's server-side verification endpoint.
	turnstileVerifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
)

type submitInterestRequest struct {
	Name         string `json:"name"          binding:"required,min=1,max=120"`
	Email        string `json:"email"         binding:"required,email,max=254"`
	PlanID       string `json:"plan_id"       binding:"required"`
	StorageType  string `json:"storage_type"  binding:"required,oneof=nvme hdd"`
	UseCase      string `json:"use_case"      binding:"required,min=1,max=2000"`
	CaptchaToken string `json:"captcha_token" binding:"required"`
	// DepositOrderID references a captured interest_deposit_orders row for
	// this exact plan_id/storage_type — see CaptureInterestDepositOrder.
	DepositOrderID string `json:"deposit_order_id" binding:"required"`
}

// submitMobileInterestRequest is the native-app variant of
// submitInterestRequest: identical except there is no captcha token, since the
// app cannot render the Cloudflare Turnstile widget. The captured 50% deposit
// (a real payment) plus the daily/per-IP caps remain as the abuse barriers.
type submitMobileInterestRequest struct {
	Name           string `json:"name"             binding:"required,min=1,max=120"`
	Email          string `json:"email"            binding:"required,email,max=254"`
	PlanID         string `json:"plan_id"          binding:"required"`
	StorageType    string `json:"storage_type"     binding:"required,oneof=nvme hdd"`
	UseCase        string `json:"use_case"         binding:"required,min=1,max=2000"`
	DepositOrderID string `json:"deposit_order_id" binding:"required"`
}

// SubmitInterestForm handles POST /api/v1/interest.
// Public endpoint — no authentication required.
// Protections applied in order:
//  1. Cloudflare Turnstile CAPTCHA verification
//  2. Daily submission cap (configurable from admin panel)
//  3. Per-IP lifetime cap (maxIPSubmissions = 5)
//  4. Duplicate email: silently ignored, always returns 200
func (h *Handler) SubmitInterestForm(c *gin.Context) {
	var req submitInterestRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "all fields are required and must be valid"})
		return
	}

	// 1. Turnstile verification.
	verifyFn := h.verifyCaptcha
	if verifyFn == nil {
		verifyFn = verifyTurnstile
	}
	if ok, err := verifyFn(h.turnstileSecret, req.CaptchaToken, c.ClientIP()); err != nil || !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "captcha verification failed — please try again"})
		return
	}

	h.processInterestSubmission(c, req.Name, req.Email, req.PlanID, req.StorageType, req.UseCase, req.DepositOrderID)
}

// SubmitMobileInterestForm handles POST /api/v1/mobile/interest.
// Public endpoint — the mobile app's account request form. Applies the same
// protections as SubmitInterestForm except step 1 (Turnstile), which native
// apps cannot complete.
func (h *Handler) SubmitMobileInterestForm(c *gin.Context) {
	var req submitMobileInterestRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "all fields are required and must be valid"})
		return
	}
	h.processInterestSubmission(c, req.Name, req.Email, req.PlanID, req.StorageType, req.UseCase, req.DepositOrderID)
}

// processInterestSubmission runs the post-captcha portion of an interest
// submission: caps, dedupe, deposit validation/consumption, persistence, and
// the async admin notification. Shared by the web and mobile endpoints.
func (h *Handler) processInterestSubmission(c *gin.Context, name, email, planID, storageType, useCase, depositOrderID string) {
	req := submitMobileInterestRequest{
		Name:           name,
		Email:          email,
		PlanID:         planID,
		StorageType:    storageType,
		UseCase:        useCase,
		DepositOrderID: depositOrderID,
	}

	ctx := c.Request.Context()
	normalizedEmail := strings.ToLower(strings.TrimSpace(req.Email))

	// 2. Daily cap check.
	settings, err := h.queries.GetInterestFormSettings(ctx)
	if err != nil {
		log.Printf("interest form: get settings: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return
	}
	todayCount, err := h.queries.CountInterestSubmissionsToday(ctx)
	if err != nil {
		log.Printf("interest form: count today: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return
	}
	if todayCount >= settings.DailyCap {
		// Return success so the cap isn't detectable by bots.
		c.JSON(http.StatusOK, gin.H{"message": "your request has been received"})
		return
	}

	// 3. Per-IP lifetime cap.
	ipCount, err := h.queries.CountInterestSubmissionsFromIP(ctx, c.ClientIP())
	if err != nil {
		log.Printf("interest form: count ip: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return
	}
	if ipCount >= maxIPSubmissions {
		// Return success so the limit isn't fingerprinted.
		c.JSON(http.StatusOK, gin.H{"message": "your request has been received"})
		return
	}

	// 4. Duplicate email — silently ignored, always returns success.
	exists, err := h.queries.ExistsInterestSubmissionByEmail(ctx, normalizedEmail)
	if err != nil {
		log.Printf("interest form: check email exists: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return
	}
	if exists {
		c.JSON(http.StatusOK, gin.H{"message": "your request has been received"})
		return
	}

	// 5. Resolve the fixed plan — no custom/arbitrary storage amounts. Mirrors
	// the same plan table used for storage purchases and expansion requests.
	pl, found := billing.LookupPlan(req.PlanID)
	if !found {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown plan_id"})
		return
	}
	fullCents, ok := pl.PriceCents[req.StorageType]
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown storage_type for plan"})
		return
	}
	depositCents := fullCents / 2

	// 6. The 50% deposit must already be captured against this exact plan and
	// storage type, and not previously used by another submission.
	order, err := h.queries.GetInterestDepositOrder(ctx, req.DepositOrderID)
	if err != nil {
		log.Printf("interest form: load deposit order: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return
	}
	if order == nil || order.CapturedAt == nil {
		c.JSON(http.StatusPaymentRequired, gin.H{"error": "deposit has not been captured"})
		return
	}
	if order.PlanID != req.PlanID || order.StorageType != req.StorageType || order.DepositAmountCents != depositCents {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "deposit does not match the selected plan"})
		return
	}
	consumed, err := h.queries.ConsumeInterestDepositOrder(ctx, req.DepositOrderID)
	if err != nil {
		log.Printf("interest form: consume deposit order: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return
	}
	if !consumed {
		c.JSON(http.StatusConflict, gin.H{"error": "this deposit has already been used"})
		return
	}

	desiredStorageGB := int(pl.BytesAdded / (1 << 30))

	// Persist the submission.
	if err := h.queries.CreateInterestSubmission(ctx, &models.InterestSubmission{
		Name:               strings.TrimSpace(req.Name),
		Email:              normalizedEmail,
		DesiredStorageGB:   desiredStorageGB,
		UseCase:            strings.TrimSpace(req.UseCase),
		IPAddress:          c.ClientIP(),
		PlanID:             req.PlanID,
		StorageType:        req.StorageType,
		FullPriceCents:     fullCents,
		DepositAmountCents: depositCents,
		Currency:           h.currencyOrDefault(),
		PaymentMethod:      order.PaymentMethod,
		PayPalOrderID:      &req.DepositOrderID,
		PayPalCaptureID:    order.PayPalCaptureID,
	}); err != nil {
		log.Printf("interest form: create submission: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
		return
	}

	// Notify all admins asynchronously so the user gets an instant response.
	go func() {
		adminEmails, err := h.queries.ListAdminEmails(c.Request.Context())
		if err != nil {
			log.Printf("interest form: list admin emails: %v", err)
			return
		}
		if len(adminEmails) == 0 {
			return
		}
		if err := h.email.SendInterestFormNotification(
			c.Request.Context(),
			adminEmails,
			strings.TrimSpace(req.Name),
			normalizedEmail,
			desiredStorageGB,
			strings.TrimSpace(req.UseCase),
		); err != nil {
			log.Printf("interest form: enqueue admin notification: %v", err)
		}
	}()

	c.JSON(http.StatusOK, gin.H{"message": "your request has been received"})
}

// verifyTurnstile calls Cloudflare's siteverify endpoint and returns true when
// the token is valid. remoteIP is forwarded for Cloudflare's analytics.
func verifyTurnstile(secret, token, remoteIP string) (bool, error) {
	resp, err := http.PostForm(turnstileVerifyURL, url.Values{
		"secret":   {secret},
		"response": {token},
		"remoteip": {remoteIP},
	})
	if err != nil {
		return false, fmt.Errorf("turnstile: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, fmt.Errorf("turnstile read body: %w", err)
	}

	var result struct {
		Success bool `json:"success"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return false, fmt.Errorf("turnstile parse: %w", err)
	}
	return result.Success, nil
}
