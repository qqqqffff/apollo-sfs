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
)

const (
	// maxIPSubmissions is the lifetime cap on submissions per source IP.
	maxIPSubmissions = 5
	// turnstileVerifyURL is Cloudflare's server-side verification endpoint.
	turnstileVerifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
)

type submitInterestRequest struct {
	Name             string `json:"name"               binding:"required,min=1,max=120"`
	Email            string `json:"email"              binding:"required,email,max=254"`
	DesiredStorageGB int    `json:"desired_storage_gb" binding:"required,min=1,max=10000"`
	UseCase          string `json:"use_case"           binding:"required,min=1,max=2000"`
	CaptchaToken     string `json:"captcha_token"      binding:"required"`
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

	// Persist the submission.
	if err := h.queries.CreateInterestSubmission(ctx, &models.InterestSubmission{
		Name:             strings.TrimSpace(req.Name),
		Email:            normalizedEmail,
		DesiredStorageGB: req.DesiredStorageGB,
		UseCase:          strings.TrimSpace(req.UseCase),
		IPAddress:        c.ClientIP(),
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
			req.DesiredStorageGB,
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
