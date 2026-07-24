package auth

import (
	"errors"
	"log"
	"net/http"
	"net/mail"
	"strings"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/middleware"
	"apollo-sfs.com/api/routes/services"
)

type registerRequest struct {
	Username string `json:"username" binding:"required,max=150"`
	Email    string `json:"email"    binding:"required,email,max=254"`
	Password string `json:"password" binding:"required,min=8,max=1024"`
	// Exactly one of InviteToken (admin invitation, email locked to the
	// invite) or ReservationToken (group-registration slot hold, email
	// user-supplied) must be set.
	InviteToken      string `json:"invite_token"      binding:"max=512"`
	ReservationToken string `json:"reservation_token" binding:"max=512"`
	CaptchaToken     string `json:"captcha_token"     binding:"required"`
}

// Register handles POST /api/v1/auth/register.
// Validates the Turnstile captcha and the invitation token (or group-slot
// reservation token), creates the user in Keycloak and the app DB, then
// auto-logs the user in by storing the new tokens in the session.
func (h *Handler) Register(c *gin.Context) {
	var req registerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	verifyFn := h.verifyCaptcha
	if verifyFn == nil {
		verifyFn = verifyTurnstile
	}
	if ok, err := verifyFn(h.turnstileSecret, req.CaptchaToken, c.ClientIP()); err != nil || !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "captcha verification failed — please try again"})
		return
	}

	req.Username = strings.TrimSpace(req.Username)
	req.InviteToken = strings.TrimSpace(req.InviteToken)
	req.ReservationToken = strings.TrimSpace(req.ReservationToken)
	if req.Username == "" || (req.InviteToken == "") == (req.ReservationToken == "") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username and exactly one of invite_token or reservation_token are required"})
		return
	}

	var (
		tokens *services.TokenPair
		err    error
	)
	if req.ReservationToken != "" {
		tokens, err = h.svc.RegisterWithReservation(
			c.Request.Context(),
			req.Username,
			req.Email,
			req.Password,
			req.ReservationToken,
		)
	} else {
		tokens, err = h.svc.Register(
			c.Request.Context(),
			req.Username,
			req.Email,
			req.Password,
			req.InviteToken,
		)
	}
	if err != nil {
		if errors.Is(err, services.ErrRoleProvisioningFailed) {
			log.Printf("register: role provisioning failed, invitation left unconsumed: %v", err)
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "account setup could not be completed — please try accepting your invitation again in a few minutes",
			})
			return
		}
		if errors.Is(err, services.ErrRegistrationSessionExpired) {
			c.JSON(http.StatusGone, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, services.ErrEmailTaken) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	session := sessions.DefaultMany(c, middleware.SessionName)
	session.Set("refresh_token", tokens.RefreshToken) // access token minted on demand; see middleware.RequireAuth
	if err := session.Save(); err != nil {
		log.Printf("register: session save failed: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save session"})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"username": req.Username})
}

type checkEmailRequest struct {
	Email string `json:"email" binding:"required,max=254"`
}

// CheckEmail handles POST /api/v1/auth/check-email.
// Used by the group-registration form's email field (on blur) to validate the
// address format and report whether an account already exists for it. Behind
// the shared auth rate limiter to keep enumeration slow.
func (h *Handler) CheckEmail(c *gin.Context) {
	var req checkEmailRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "an email address is required"})
		return
	}
	email := strings.TrimSpace(req.Email)
	if _, err := mail.ParseAddress(email); err != nil {
		c.JSON(http.StatusOK, gin.H{"valid": false, "available": false})
		return
	}
	inUse, err := h.svc.EmailInUse(c.Request.Context(), email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check email"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"valid": true, "available": !inUse})
}
