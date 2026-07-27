package routes

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/middleware"
	"apollo-sfs.com/api/routes/services"
)

// passwordChangeCodeTTL bounds how long an emailed change-password code stays
// valid. Short enough to limit exposure, long enough to fetch it from email.
const passwordChangeCodeTTL = 10 * time.Minute

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password" binding:"required"`
	NewPassword     string `json:"new_password" binding:"required"`
	// Code is the one-time two-factor code emailed to the account address via
	// RequestPasswordChangeCode. Required.
	Code string `json:"code" binding:"required"`
}

// RequestPasswordChangeCode handles POST /api/v1/me/password/request-code.
// Emails a single-use two-factor code to the signed-in user's account address.
// The code must later be presented to ChangePassword along with the current and
// new password. Always returns 200 with a generic message (the caller is
// already authenticated, so there's no enumeration concern, but the response
// intentionally does not echo the code).
func (h *Handler) RequestPasswordChangeCode(c *gin.Context) {
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	ctx := c.Request.Context()

	user, err := h.queries.GetUserByUsername(ctx, username)
	if err != nil || user == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load account"})
		return
	}

	code, err := generateNumericCode(6)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not generate code"})
		return
	}

	if err := h.queries.CreatePasswordChangeCode(ctx, username, code, time.Now().Add(passwordChangeCodeTTL)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not issue code"})
		return
	}

	if err := h.email.SendPasswordChangeCode(ctx, user, code, "10 minutes"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not send code"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "a change-password code has been emailed to you"})
}

// ChangePassword handles POST /api/v1/me/password.
// Requires a valid two-factor code (from RequestPasswordChangeCode) in addition
// to the current password, then sets the new one via Keycloak.
func (h *Handler) ChangePassword(c *gin.Context) {
	username := c.GetString("username")

	var req changePasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "current_password, new_password and code are required"})
		return
	}

	// Verify the two-factor code first so an attacker with only the current
	// password (e.g. a shared/leaked one) still can't change it without access
	// to the account's email.
	ok, err := h.queries.ConsumePasswordChangeCode(c.Request.Context(), username, req.Code)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not verify code"})
		return
	}
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired code"})
		return
	}

	if err := h.auth.ChangePassword(c.Request.Context(), username, req.CurrentPassword, req.NewPassword); err != nil {
		if errors.Is(err, services.ErrWrongPassword) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "current password is incorrect"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not change password"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "password changed"})
}

type updateMyUsernameRequest struct {
	NewUsername string `json:"new_username" binding:"required,min=3,max=150"`
}

// UpdateMyUsername handles PATCH /api/v1/me/username.
// Lets the signed-in user rename their own account in Keycloak and the app DB.
// The caller's existing access token still carries the old preferred_username
// until it is refreshed, so the frontend signs the user out after a successful
// rename to force a fresh token on next login.
func (h *Handler) UpdateMyUsername(c *gin.Context) {
	oldUsername := c.GetString("username")
	if oldUsername == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	var req updateMyUsernameRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "new_username is required (3–150 characters)"})
		return
	}

	newUsername := strings.TrimSpace(req.NewUsername)
	if newUsername == "" || len(newUsername) < 3 || len(newUsername) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "new_username must be 3–150 characters"})
		return
	}
	if newUsername == oldUsername {
		c.JSON(http.StatusOK, gin.H{"message": "username unchanged"})
		return
	}

	if err := h.auth.RenameUser(c.Request.Context(), oldUsername, newUsername); err != nil {
		if strings.Contains(err.Error(), "already taken") {
			c.JSON(http.StatusConflict, gin.H{"error": "that username is already taken"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update username"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "username updated"})
}

// generateNumericCode returns a cryptographically random decimal code of the
// given length (zero-padded), e.g. "042931" for length 6.
func generateNumericCode(digits int) (string, error) {
	max := big.NewInt(1)
	for i := 0; i < digits; i++ {
		max.Mul(max, big.NewInt(10))
	}
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%0*d", digits, n), nil
}

// meResponse is the JSON shape returned by GET /api/v1/me.
// Sensitive fields (encrypted_key, nonce, master_key_version) are never
// included — they are tagged json:"-" on the model itself.
type meResponse struct {
	Username          string     `json:"username"`
	Email             string     `json:"email"`
	StorageUsedBytes  int64      `json:"storage_used_bytes"`
	StorageQuotaBytes int64      `json:"storage_quota_bytes"`
	StorageUsedPct    float64    `json:"storage_used_pct"`
	LastSeenAt        *time.Time `json:"last_seen_at"`
	CreatedAt         time.Time  `json:"created_at"`
	IsAdmin           bool       `json:"is_admin"`
	IsPremium         bool       `json:"is_premium"`
	PremiumGrantedAt  *time.Time `json:"premium_granted_at"`
	// PremiumSubscribed is true when the user has an active/suspended premium
	// subscription of their own — see models.User.PremiumSubscribed. Lets the
	// frontend show a separate "Premium" badge alongside "Admin" only when an
	// admin actually subscribed, rather than for every admin (who get
	// IsPremium implicitly), and gates the real upgrade flow's visibility.
	PremiumSubscribed bool `json:"premium_subscribed"`
	// PremiumEnvironment/PremiumPlan/PremiumCurrentPeriodEnd describe the
	// user's own active subscription (nil when they have none of their own —
	// e.g. a non-subscribed admin). Populated from GetActiveSubscriptionForUser.
	PremiumEnvironment      *string    `json:"premium_environment,omitempty"`
	PremiumPlan             *string    `json:"premium_plan,omitempty"`
	PremiumCurrentPeriodEnd *time.Time `json:"premium_current_period_end,omitempty"`
	LinkedProviders         []string   `json:"linked_providers"`
	// SandboxPaymentsEnabled reflects the admin's session-scoped toggle (see
	// middleware.SandboxEnabled) — always false for non-admins, and resets on
	// logout/session expiry since it isn't persisted.
	SandboxPaymentsEnabled bool `json:"sandbox_payments_enabled"`
	// ExpansionOverrideEnabled reflects the admin's session-scoped toggle (see
	// middleware.ExpansionOverrideEnabled) — always false for non-admins, and
	// resets on logout/session expiry since it isn't persisted.
	ExpansionOverrideEnabled bool `json:"expansion_override_enabled"`
	// FeedbackAccessEnabled gates the profile-page feedback form — disabled by
	// default; admins grant it per-user from the admin Feedback → Access tab.
	FeedbackAccessEnabled bool `json:"feedback_access_enabled"`
}

// Me handles GET /api/v1/me.
// Returns the authenticated user's profile, including storage usage.
// Requires the "username" context key set by RequireAuth middleware.
func (h *Handler) Me(c *gin.Context) {
	username, exists := c.Get("username")
	if !exists {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	ctx := c.Request.Context()
	uname := username.(string)

	// Auto-pardon any expired suspensions before checking ban status.
	_ = h.queries.AutoPardonExpiredSuspension(ctx, uname)

	ban, err := h.queries.GetActiveBan(ctx, uname)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal server error"})
		return
	}
	if ban != nil {
		if ban.BanType == "banned" {
			// Add the requester's IP to the blocklist for hardware-level enforcement.
			if ip := clientIP(c); ip != "" {
				_ = h.queries.AddBannedIP(ctx, ip, "user-ban")
			}
			c.JSON(http.StatusForbidden, gin.H{
				"error":          "banned",
				"violation_code": ban.ViolationCode,
				"comments":       ban.Comments,
				"banned_at":      ban.BannedAt,
			})
			return
		}
		// Suspended
		c.JSON(http.StatusForbidden, gin.H{
			"error":          "suspended",
			"violation_code": ban.ViolationCode,
			"comments":       ban.Comments,
			"expires_at":     ban.ExpiresAt,
			"banned_at":      ban.BannedAt,
		})
		return
	}

	user, err := h.queries.GetUserByUsername(ctx, uname)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal server error"})
		return
	}

	// Derive admin status from the JWT realm roles set by RequireAuth,
	// so it always reflects the current Keycloak role without a DB update.
	isAdmin := false
	if roles, ok := c.Get("roles"); ok {
		for _, r := range roles.([]string) {
			if r == "admin" {
				isAdmin = true
				break
			}
		}
	}

	var usedPct float64
	if user.StorageQuotaBytes > 0 {
		usedPct = float64(user.StorageUsedBytes) / float64(user.StorageQuotaBytes) * 100
	}

	linkedProviders := []string{}
	if h.auth != nil {
		if lp, err := h.auth.GetLinkedProviders(ctx, c.GetString("userID")); err == nil {
			linkedProviders = lp
		}
	}

	var (
		premiumSubscribed       bool
		premiumEnvironment      *string
		premiumPlan             *string
		premiumCurrentPeriodEnd *time.Time
	)
	sub, err := h.queries.GetActiveSubscriptionForUser(ctx, uname)
	if err != nil {
		log.Printf("Me: check premium subscription for %q: %v", uname, err)
	} else if sub != nil {
		premiumSubscribed = true
		premiumEnvironment = &sub.Environment
		premiumPlan = &sub.Plan
		premiumCurrentPeriodEnd = sub.CurrentPeriodEnd
	}

	c.JSON(http.StatusOK, meResponse{
		Username:                 user.Username,
		Email:                    user.Email,
		StorageUsedBytes:         user.StorageUsedBytes,
		StorageQuotaBytes:        user.StorageQuotaBytes,
		StorageUsedPct:           usedPct,
		LastSeenAt:               user.LastSeenAt,
		CreatedAt:                user.CreatedAt,
		IsAdmin:                  isAdmin,
		IsPremium:                user.IsPremium,
		PremiumGrantedAt:         user.PremiumGrantedAt,
		PremiumSubscribed:        premiumSubscribed,
		PremiumEnvironment:       premiumEnvironment,
		PremiumPlan:              premiumPlan,
		PremiumCurrentPeriodEnd:  premiumCurrentPeriodEnd,
		LinkedProviders:          linkedProviders,
		SandboxPaymentsEnabled:   middleware.SandboxEnabled(c),
		ExpansionOverrideEnabled: middleware.ExpansionOverrideEnabled(c),
		FeedbackAccessEnabled:    user.FeedbackAccessEnabled,
	})
}

// UpdateSandboxPayments handles PUT /api/v1/me/sandbox-payments.
// Admin-only: toggles whether the calling admin's own payment actions
// (premium, storage add-ons, capacity expansion) run against the PayPal
// sandbox instance instead of live. Stored in the session cookie only — it
// resets to disabled on logout or session expiry, never persisted to the DB.
func (h *Handler) UpdateSandboxPayments(c *gin.Context) {
	if !c.GetBool("isAdmin") {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "admin only"})
		return
	}
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	session := sessions.DefaultMany(c, middleware.SessionName)
	session.Set("sandbox_payments_enabled", req.Enabled)
	if err := session.Save(); err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "could not save session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"sandbox_payments_enabled": req.Enabled})
}

// UpdateExpansionOverride handles PUT /api/v1/me/expansion-override.
// Admin-only: toggles whether the calling admin's Add Storage modal always
// routes plan purchases through the capacity expansion request flow (deposit
// + manual review) instead of a direct buy, regardless of actual server
// capacity — useful for testing that flow. Stored in the session cookie
// only — it resets to disabled on logout or session expiry, never persisted
// to the DB.
func (h *Handler) UpdateExpansionOverride(c *gin.Context) {
	if !c.GetBool("isAdmin") {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "admin only"})
		return
	}
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	session := sessions.DefaultMany(c, middleware.SessionName)
	session.Set("expansion_override_enabled", req.Enabled)
	if err := session.Save(); err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "could not save session"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"expansion_override_enabled": req.Enabled})
}

type socialLinkRequest struct {
	Provider       string `json:"provider"        binding:"required"`
	Token          string `json:"token"`
	ServerAuthCode string `json:"server_auth_code"`
	// Code is the Keycloak authorization code from the web "Connect" flow —
	// the browser has no provider SDK to produce Token, so it re-runs the same
	// brokered authorization-code flow the sign-in buttons use and hands the
	// code here. See LinkSocial for why the code, not the callback, is what
	// arrives authenticated.
	Code string `json:"code"`
}

// brokeredLinkRedirectPath is the redirect_uri the web "Connect" flow registers
// with Keycloak, and so the one the code must be exchanged against. It points at
// the profile page itself rather than an API callback on purpose: the session
// cookie is SameSite=Strict, so it is not sent on the cross-site redirect back
// from Keycloak — an API callback would arrive unauthenticated. Landing on the
// SPA instead lets it forward the code over a normal same-site XHR, which does
// carry the cookie. Keep in sync with socialLinkUrl in the frontend.
const brokeredLinkRedirectPath = "/client/profile"

type socialUnlinkRequest struct {
	Provider string `json:"provider" binding:"required"`
}

// LinkSocial handles POST /api/v1/me/social/link.
// Links an Apple, Google, or Microsoft identity to the authenticated user's
// account. The identity can be presented three ways: a provider ID token
// (Token — what the mobile apps' native SDKs return), a Google server auth code
// (ServerAuthCode), or a Keycloak authorization code from the web Connect
// flow (Code).
func (h *Handler) LinkSocial(c *gin.Context) {
	userID := c.GetString("userID")
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	var req socialLinkRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "provider is required"})
		return
	}
	if req.Provider != "apple" && req.Provider != "google" && req.Provider != "microsoft" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "provider must be apple, google, or microsoft"})
		return
	}

	if req.Code != "" {
		redirectURI := h.auth.AppBaseURL() + brokeredLinkRedirectPath
		err := h.auth.LinkBrokeredIdentity(c.Request.Context(), userID, req.Code, redirectURI, req.Provider)
		switch {
		case err == nil:
			c.JSON(http.StatusOK, gin.H{"message": "identity linked"})
		case errors.Is(err, services.ErrIdentityClaimed):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrIdentityNotReturned):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		default:
			log.Printf("LinkSocial: brokered link of %s for %s failed: %v", req.Provider, userID, err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "could not connect the account — please try again"})
		}
		return
	}

	token := req.Token
	if req.Provider == "google" && req.ServerAuthCode != "" {
		idToken, err := h.auth.ExchangeGoogleServerAuthCode(c.Request.Context(), req.ServerAuthCode)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "google auth code exchange failed: " + err.Error()})
			return
		}
		token = idToken
	}
	if token == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "token or server_auth_code is required"})
		return
	}

	if err := h.auth.LinkSocialIdentity(c.Request.Context(), userID, req.Provider, token); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "identity linked"})
}

// UnlinkSocial handles DELETE /api/v1/me/social/unlink.
// Removes an Apple, Google, or Microsoft identity link from the authenticated
// user's account.
func (h *Handler) UnlinkSocial(c *gin.Context) {
	userID := c.GetString("userID")
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	var req socialUnlinkRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "provider is required"})
		return
	}
	if req.Provider != "apple" && req.Provider != "google" && req.Provider != "microsoft" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "provider must be apple, google, or microsoft"})
		return
	}

	if err := h.auth.UnlinkSocialIdentity(c.Request.Context(), userID, req.Provider); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "identity unlinked"})
}

// ── Notifications ─────────────────────────────────────────────────────────────

// notificationItem is one entry in the bell dropdown. Kind is one of:
// capacity_provisioned | payment_required | action_pending | share_received |
// subscription_cancelled and, for admins: invitation_accepted |
// order_received | email_received | alarm_triggered. The frontend groups the dropdown by kind.
type notificationItem struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Link      string    `json:"link"`
	CreatedAt time.Time `json:"created_at"`
	// Details carries the structured before/after breakdown for kinds that
	// need more than a one-line body (currently only quota_changed) — the
	// frontend renders it behind a "Breakdown" expand button.
	Details json.RawMessage `json:"details,omitempty"`
}

// shareNotificationWindow bounds how long a received share keeps showing in
// the bell dropdown.
const shareNotificationWindow = 30 * 24 * time.Hour

// subscriptionCancelNotificationWindow bounds how long an admin-cancelled
// subscription keeps showing in the bell dropdown.
const subscriptionCancelNotificationWindow = 30 * 24 * time.Hour

// adminNotificationWindow bounds how long admin activity (accepted
// invitations, captured orders, inbound emails, fired alarms) keeps showing
// in the bell dropdown.
const adminNotificationWindow = 7 * 24 * time.Hour

// roleChangeNotificationWindow bounds how long an admin role assignment keeps
// showing in the bell dropdown.
const roleChangeNotificationWindow = 30 * 24 * time.Hour

// emailBackupNotificationWindow bounds how long a completed email backup run
// (with notifications enabled) keeps showing in the bell dropdown.
const emailBackupNotificationWindow = 7 * 24 * time.Hour

// googleBackupNotificationWindow is the Google Drive/Photos backup
// equivalent of emailBackupNotificationWindow.
const googleBackupNotificationWindow = 7 * 24 * time.Hour

// backupStaleAfter is how old the most recent Google/email backup may get
// before the opt-in backup reminder (user_preferences.backup_stale_notify)
// surfaces a bell warning.
const backupStaleAfter = 30 * 24 * time.Hour

// adminNotificationLimit caps each admin category so one busy day of orders
// or inbound mail can't flood the dropdown.
const adminNotificationLimit = 15

// notificationCategory maps a notification kind to the category header it's
// grouped under in the bell dropdown. Kept in sync by hand with KIND_META in
// frontend/src/components/NotificationBell.tsx — used server-side only to
// resolve the `category` query param on DismissNotifications.
func notificationCategory(kind string) string {
	switch kind {
	case "capacity_provisioned", "quota_changed":
		return "Storage"
	case "payment_required", "action_pending", "subscription_cancelled":
		return "Billing"
	case "share_received":
		return "Shares"
	case "email_backup_completed", "google_backup_completed", "backup_stale":
		return "Backups"
	case "invitation_accepted":
		return "Invitations"
	case "order_received":
		return "Orders"
	case "email_received":
		return "Emails"
	case "alarm_triggered":
		return "Alarms"
	case "role_changed":
		return "Account"
	default:
		return ""
	}
}

// Notifications handles GET /api/v1/me/notifications.
// Derives the user's pending-action notifications from live state: provisioned
// capacity awaiting its balance, invoices awaiting review, and recent shares.
func (h *Handler) Notifications(c *gin.Context) {
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	ctx := c.Request.Context()

	items, err := h.gatherNotificationItems(ctx, username, c.GetString("userID"), c.GetBool("isAdmin"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "load notifications"})
		return
	}

	dismissed, err := h.queries.ListDismissedNotificationIDs(ctx, username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "load notifications"})
		return
	}
	kept := items[:0]
	for _, item := range items {
		if !dismissed[item.ID] {
			kept = append(kept, item)
		}
	}
	items = kept

	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })

	c.JSON(http.StatusOK, gin.H{"items": items})
}

// gatherNotificationItems assembles the full, undismissed-and-unfiltered
// notification-bell item list for a user: provisioned capacity awaiting its
// balance, invoices awaiting review, recent shares, plus (for admins) recent
// account/infrastructure activity. Shared by Notifications and
// DismissNotifications (category dismissal needs the same live-derived set to
// resolve which IDs a category currently contains).
func (h *Handler) gatherNotificationItems(ctx context.Context, username, userID string, isAdmin bool) ([]notificationItem, error) {
	items := []notificationItem{}

	requests, err := h.queries.ListUserExpansionRequests(ctx, username)
	if err != nil {
		return nil, err
	}
	for _, r := range requests {
		capacity := formatCapacityShort(r.BytesRequested)
		tier := "standard"
		if r.StorageType == "nvme" {
			tier = "fast"
		}
		switch r.Status {
		case "expanded":
			provisionedAt := r.CreatedAt
			if r.PaymentDueAt != nil {
				provisionedAt = *r.PaymentDueAt
			}
			items = append(items, notificationItem{
				ID:        r.ID.String() + ":provisioned",
				Kind:      "capacity_provisioned",
				Title:     "Additional capacity provisioned",
				Body:      fmt.Sprintf("%s of %s storage on %s is now available on your account.", capacity, tier, r.ServerName),
				Link:      "/client/orders?tab=requests",
				CreatedAt: provisionedAt,
			})
			if remaining := r.FullPriceCents - r.DepositAmountCents; remaining > 0 {
				items = append(items, notificationItem{
					ID:        r.ID.String() + ":payment",
					Kind:      "payment_required",
					Title:     "Payment required",
					Body:      fmt.Sprintf("The remaining balance of %s for your %s expansion is due.", formatCentsShort(remaining), capacity),
					Link:      "/client/orders?tab=requests&pay=" + r.ID.String(),
					CreatedAt: provisionedAt,
				})
			}
		case "invoice_sent":
			link := "/client/orders?tab=requests"
			if inv, err := h.queries.GetLatestExpansionInvoice(ctx, r.ID); err == nil && inv != nil && inv.ReviewToken != nil {
				link = "/invoice/" + *inv.ReviewToken
			}
			sentAt := r.CreatedAt
			if r.InvoiceSentAt != nil {
				sentAt = *r.InvoiceSentAt
			}
			items = append(items, notificationItem{
				ID:        r.ID.String() + ":invoice",
				Kind:      "action_pending",
				Title:     "Action pending: invoice awaiting review",
				Body:      fmt.Sprintf("Your custom %s request has been priced — review and approve the invoice.", capacity),
				Link:      link,
				CreatedAt: sentAt,
			})
		}
	}

	// Recent shares addressed to the user's email.
	if user, err := h.queries.GetUserByUsername(ctx, username); err == nil && user != nil {
		if shares, err := h.queries.ListSharesForRecipient(ctx, strings.ToLower(user.Email)); err == nil {
			for _, s := range shares {
				if time.Since(s.CreatedAt) > shareNotificationWindow {
					continue
				}
				itemType := "file"
				if s.FolderID != nil {
					itemType = "folder"
				}
				items = append(items, notificationItem{
					ID:        s.ID.String() + ":share",
					Kind:      "share_received",
					Title:     fmt.Sprintf("A %s was shared with you", itemType),
					Body:      fmt.Sprintf("%s shared a %s with you.", s.OwnerUsername, itemType),
					Link:      "/client/shared",
					CreatedAt: s.CreatedAt,
				})
			}
		}
	}

	// Subscriptions an admin cancelled (cancellation_reason set — the
	// self-service cancel and PayPal webhooks never set it) within the
	// window, surfacing the admin's reason and any prorated refund.
	cancelled, err := h.queries.ListRecentAdminCancelledSubscriptionsForUser(ctx, username, time.Now().Add(-subscriptionCancelNotificationWindow))
	if err != nil {
		return nil, err
	}
	for _, s := range cancelled {
		body := fmt.Sprintf("Your %s premium subscription was cancelled by an admin.", s.Plan)
		if s.RefundAmountCents != nil && *s.RefundAmountCents > 0 {
			body += fmt.Sprintf(" A prorated refund of %s was issued.", formatCentsShort(*s.RefundAmountCents))
		}
		if s.CancellationReason != nil && *s.CancellationReason != "" {
			body += fmt.Sprintf(" Reason: %s", *s.CancellationReason)
		}
		cancelledAt := s.UpdatedAt
		if s.CancelledAt != nil {
			cancelledAt = *s.CancelledAt
		}
		items = append(items, notificationItem{
			ID:        s.ID.String() + ":subscription-cancelled",
			Kind:      "subscription_cancelled",
			Title:     "Premium subscription cancelled",
			Body:      body,
			Link:      "/client/orders?tab=premium",
			CreatedAt: cancelledAt,
		})
	}

	// Completed email backup runs where the user asked to be notified.
	backupRuns, err := h.queries.ListRecentEmailBackupRunsForUser(ctx, username, time.Now().Add(-emailBackupNotificationWindow))
	if err != nil {
		return nil, err
	}
	for _, r := range backupRuns {
		body := fmt.Sprintf("%d email%s from %s backed up.", r.Uploaded, plural(r.Uploaded), r.EmailAddress)
		if r.Duplicates > 0 {
			body += fmt.Sprintf(" %d duplicate%s skipped.", r.Duplicates, plural(r.Duplicates))
		}
		if r.Errors > 0 {
			body += fmt.Sprintf(" %d failed.", r.Errors)
		}
		link := "/client"
		if r.FolderID != nil {
			link = "/client?folder=" + r.FolderID.String()
		}
		items = append(items, notificationItem{
			ID:        r.ID.String() + ":email-backup",
			Kind:      "email_backup_completed",
			Title:     "Email backup complete",
			Body:      body,
			Link:      link,
			CreatedAt: r.CompletedAt,
		})
	}

	// Completed Google backup runs where the user asked to be notified.
	googleRuns, err := h.queries.ListRecentGoogleBackupRunsForUser(ctx, username, time.Now().Add(-googleBackupNotificationWindow))
	if err != nil {
		return nil, err
	}
	for _, r := range googleRuns {
		body := fmt.Sprintf("%d file%s backed up from Google.", r.Uploaded, plural(r.Uploaded))
		if r.Duplicates > 0 {
			body += fmt.Sprintf(" %d duplicate%s skipped.", r.Duplicates, plural(r.Duplicates))
		}
		if r.Errors > 0 {
			body += fmt.Sprintf(" %d failed.", r.Errors)
		}
		items = append(items, notificationItem{
			ID:        r.ID.String() + ":google-backup",
			Kind:      "google_backup_completed",
			Title:     "Google backup complete",
			Body:      body,
			Link:      "/client",
			CreatedAt: r.CompletedAt,
		})
	}

	// Opt-in backup reminder: warn when the most recent Google/email backup is
	// more than 30 days old. Only fires for backup types the user has actually
	// used at least once — "never backed up" is not "out of date". The item ID
	// embeds the last-sync time, so dismissing one hides it until a newer
	// backup starts a fresh staleness period.
	if prefs, err := h.queries.GetUserPreferences(ctx, username); err == nil && prefs != nil && prefs.BackupStaleNotify {
		staleChecks := []struct {
			label  string
			action string
			last   func() (*time.Time, error)
		}{
			{"Google", "google-backup", func() (*time.Time, error) {
				uid, err := uuid.Parse(userID)
				if err != nil {
					return nil, nil
				}
				return h.queries.GetLastGoogleBackupSync(ctx, uid)
			}},
			{"Email", "email-backup", func() (*time.Time, error) {
				return h.queries.GetLastEmailBackupSync(ctx, username)
			}},
		}
		for _, chk := range staleChecks {
			last, err := chk.last()
			if err != nil || last == nil {
				continue
			}
			if age := time.Since(*last); age > backupStaleAfter {
				items = append(items, notificationItem{
					ID:    fmt.Sprintf("backup-stale:%s:%d", strings.ToLower(chk.label), last.Unix()),
					Kind:  "backup_stale",
					Title: fmt.Sprintf("%s backup is out of date", chk.label),
					Body: fmt.Sprintf("Your last %s backup completed %d days ago — over the 30-day reminder threshold.",
						strings.ToLower(chk.label), int(age.Hours()/24)),
					Link:      "/client?action=" + chk.action,
					CreatedAt: last.Add(backupStaleAfter),
				})
			}
		}
	}

	// Storage allocation changes an admin made via the Users page editor,
	// within the same window as the admin-cancelled-subscription notice above.
	quotaChanges, err := h.queries.ListRecentQuotaChangeNotificationsForUser(ctx, username, time.Now().Add(-subscriptionCancelNotificationWindow))
	if err != nil {
		return nil, err
	}
	for _, qc := range quotaChanges {
		items = append(items, notificationItem{
			ID:        qc.ID.String() + ":quota-changed",
			Kind:      "quota_changed",
			Title:     "Storage allocation updated",
			Body:      summarizeQuotaChange(qc.Details),
			Link:      "/client/profile",
			CreatedAt: qc.CreatedAt,
			Details:   qc.Details,
		})
	}

	// Role assignments an admin made via the Users page's role editor, within
	// the same window as the admin-cancelled-subscription notice above.
	roleChanges, err := h.queries.ListRecentRoleChangeNotificationsForUser(ctx, username, time.Now().Add(-roleChangeNotificationWindow))
	if err != nil {
		return nil, err
	}
	for _, rc := range roleChanges {
		items = append(items, notificationItem{
			ID:        rc.ID.String() + ":role-changed",
			Kind:      "role_changed",
			Title:     "Account role updated",
			Body:      describeRoleChange(rc),
			Link:      "/client/profile",
			CreatedAt: rc.CreatedAt,
		})
	}

	// Admin-only categories: recent account/infrastructure activity, so alerts
	// that previously only lived on the admin pages (or in email) surface in
	// the same bell, grouped by kind on the frontend.
	if isAdmin {
		items = append(items, h.adminNotifications(ctx)...)
	}

	return items, nil
}

// ── Backup last-sync + reminder preference ────────────────────────────────────

// LastBackupSync handles GET /api/v1/me/backups/last-sync.
// Returns when the user's most recent Google backup (last Drive/Photos file
// uploaded) and email backup (last completed run) happened, so the backup
// dialogs can show "last backup completed N days ago". Null means that backup
// type has never been used.
func (h *Handler) LastBackupSync(c *gin.Context) {
	username := c.GetString("username")
	ctx := c.Request.Context()

	var googleLast *time.Time
	if uid, err := uuid.Parse(c.GetString("userID")); err == nil {
		t, err := h.queries.GetLastGoogleBackupSync(ctx, uid)
		if err != nil {
			log.Printf("LastBackupSync: google user=%s err=%v", username, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load backup status"})
			return
		}
		googleLast = t
	}

	emailLast, err := h.queries.GetLastEmailBackupSync(ctx, username)
	if err != nil {
		log.Printf("LastBackupSync: email user=%s err=%v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load backup status"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"google_last_sync": googleLast,
		"email_last_sync":  emailLast,
	})
}

type updateBackupReminderRequest struct {
	BackupStaleNotify *bool `json:"backup_stale_notify" binding:"required"`
}

// UpdateBackupReminderPreference handles PUT /api/v1/me/preferences/backup-reminder.
// Toggles the opt-in bell warning shown when the most recent Google or email
// backup is more than 30 days old. Premium-only (registered in the premium
// route group); disabled by default.
// Body: {"backup_stale_notify": bool}.
func (h *Handler) UpdateBackupReminderPreference(c *gin.Context) {
	var req updateBackupReminderRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.BackupStaleNotify == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "backup_stale_notify is required"})
		return
	}

	username := c.GetString("username")
	prefs, err := h.queries.SetBackupStaleNotify(c.Request.Context(), username, *req.BackupStaleNotify)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save preferences"})
		return
	}
	c.JSON(http.StatusOK, prefs)
}

type markOnboardingGuideSeenRequest struct {
	Guide string `json:"guide" binding:"required,oneof=base premium"`
}

// MarkOnboardingGuideSeen handles PUT /api/v1/me/preferences/onboarding.
// Records that the caller has been shown one of the onboarding spotlight
// tours so it never auto-plays again. Body: {"guide": "base"|"premium"}.
//
// Account state, not browser state — the flags used to live in localStorage,
// which replayed the tour on every new browser/device or cleared-site-data
// login. The Profile page's "Replay guide" links don't touch this; they open
// the tour directly.
func (h *Handler) MarkOnboardingGuideSeen(c *gin.Context) {
	var req markOnboardingGuideSeenRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": `guide must be "base" or "premium"`})
		return
	}

	username := c.GetString("username")
	prefs, err := h.queries.SetOnboardingGuideSeen(c.Request.Context(), username, req.Guide)
	if err != nil {
		log.Printf("MarkOnboardingGuideSeen: user=%s guide=%s err=%v", username, req.Guide, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save preferences"})
		return
	}
	c.JSON(http.StatusOK, prefs)
}

type dismissNotificationsRequest struct {
	IDs []string `json:"ids" binding:"required,min=1"`
}

// DismissNotifications handles POST /api/v1/me/notifications/dismiss.
// Records notification-bell item IDs so they're excluded from the user's
// future Notifications responses (items are re-derived from live state on
// every request, so dismissal is tracked as a separate denylist rather than a
// flag on the source rows).
//
// Two ways to select what gets dismissed:
//   - ?category=<name> (e.g. "emails", "orders", "alarms" — matches the bell's
//     category headers, case-insensitively) dismisses every item currently in
//     that category, re-derived live server-side — no body required.
//   - a JSON body {"ids": [...]} dismisses exactly those IDs (used for
//     dismissing a single item).
//
// If both are given, category wins and the body is ignored.
func (h *Handler) DismissNotifications(c *gin.Context) {
	username := c.GetString("username")
	if username == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}
	ctx := c.Request.Context()

	if category := c.Query("category"); category != "" {
		items, err := h.gatherNotificationItems(ctx, username, c.GetString("userID"), c.GetBool("isAdmin"))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "dismiss notifications"})
			return
		}
		ids := make([]string, 0, len(items))
		for _, item := range items {
			if strings.EqualFold(notificationCategory(item.Kind), category) {
				ids = append(ids, item.ID)
			}
		}
		if err := h.queries.DismissNotifications(ctx, username, ids); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "dismiss notifications"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "dismissed": len(ids)})
		return
	}

	var req dismissNotificationsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "ids is required"})
		return
	}

	if err := h.queries.DismissNotifications(ctx, username, req.IDs); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "dismiss notifications"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// adminNotifications assembles the admin-only bell categories. Each source is
// best-effort: a failure in one category never blanks the whole dropdown.
func (h *Handler) adminNotifications(ctx context.Context) []notificationItem {
	since := time.Now().Add(-adminNotificationWindow)
	items := []notificationItem{}

	if invs, err := h.queries.ListRecentlyAcceptedInvitations(ctx, since); err == nil {
		for i, inv := range invs {
			if i >= adminNotificationLimit {
				break
			}
			acceptedAt := inv.CreatedAt
			if inv.AcceptedAt != nil {
				acceptedAt = *inv.AcceptedAt
			}
			items = append(items, notificationItem{
				ID:        inv.ID.String() + ":invitation-accepted",
				Kind:      "invitation_accepted",
				Title:     "Invitation accepted",
				Body:      fmt.Sprintf("%s accepted their invitation.", inv.Email),
				Link:      "/admin/requests",
				CreatedAt: acceptedAt,
			})
		}
	}

	if orders, err := h.queries.ListRecentCapturedOrders(ctx, since, adminNotificationLimit); err == nil {
		for _, o := range orders {
			capturedAt := o.CreatedAt
			if o.CapturedAt != nil {
				capturedAt = *o.CapturedAt
			}
			kindLabel := "storage order"
			if o.Type == "premium" {
				kindLabel = "premium upgrade"
			}
			env := ""
			if o.Environment == "sandbox" {
				env = " (sandbox)"
			}
			items = append(items, notificationItem{
				ID:        o.ID.String() + ":order-received",
				Kind:      "order_received",
				Title:     "Order received",
				Body:      fmt.Sprintf("%s paid %s for a %s%s.", o.Username, formatCentsShort(int(o.AmountCents)), kindLabel, env),
				Link:      "/admin/orders",
				CreatedAt: capturedAt,
			})
		}
	}

	if emails, err := h.queries.ListRecentUnreadInboundEmails(ctx, since, adminNotificationLimit); err == nil {
		for _, e := range emails {
			subject := e.Subject
			if subject == "" {
				subject = "(no subject)"
			}
			items = append(items, notificationItem{
				ID:        e.ID.String() + ":email-received",
				Kind:      "email_received",
				Title:     "Email received",
				Body:      fmt.Sprintf("%s — %s", e.FromAddr, subject),
				Link:      "/admin/emails",
				CreatedAt: e.ReceivedAt,
			})
		}
	}

	if subs, err := h.queries.ListRecentlyFiredAlarmSubscriptions(ctx, since); err == nil {
		for i, s := range subs {
			if i >= adminNotificationLimit {
				break
			}
			target := s.ServerName
			if s.NodeHostname != "" {
				target = s.NodeHostname
			}
			if s.DriveLabel != "" {
				target = fmt.Sprintf("%s (%s)", target, s.DriveLabel)
			}
			if target == "" {
				target = "cluster"
			}
			firedAt := time.Now()
			if s.LastFiredAt != nil {
				firedAt = *s.LastFiredAt
			}
			items = append(items, notificationItem{
				ID:        s.ID.String() + ":alarm-triggered",
				Kind:      "alarm_triggered",
				Title:     "Alarm triggered",
				Body:      fmt.Sprintf("%s alarm fired on %s.", s.AlarmType, target),
				Link:      "/admin/alarm",
				CreatedAt: firedAt,
			})
		}
	}

	return items
}

// summarizeQuotaChange builds the bell body's concise one-line summary from a
// quota_change_notifications row's structured details — the full per-drive
// breakdown is available via the item's Details field (rendered behind the
// frontend's "Breakdown" expand button).
func summarizeQuotaChange(raw json.RawMessage) string {
	var d models.StorageAllocationChangeDetails
	if err := json.Unmarshal(raw, &d); err != nil {
		return "An admin updated your storage allocation."
	}
	var before, after int64
	for _, a := range d.Before {
		before += a.QuotaBytes
	}
	for _, a := range d.After {
		after += a.QuotaBytes
	}
	n := len(d.After)
	if n == 0 {
		n = len(d.Before)
	}
	drives := "drive"
	if n != 1 {
		drives = "drives"
	}
	return fmt.Sprintf(
		"An admin updated your storage across %d %s: %s → %s total.",
		n, drives, formatCapacityShort(before), formatCapacityShort(after),
	)
}

// roleLabel maps a role value ("admin"|"premium"|"user") to the display
// label used in bell/email copy — mirrors GroupBadge's THEME on the frontend.
func roleLabel(role string) string {
	switch role {
	case "admin":
		return "Admin"
	case "premium":
		return "Premium"
	default:
		return "User"
	}
}

// describeRoleChange builds the bell body for a role_change_notifications
// row: the role transition, the admin's reason, and — for a demotion away
// from Premium — the trial-expiry/purchase-block notes.
func describeRoleChange(rc db.RoleChangeNotification) string {
	body := fmt.Sprintf("Your account role was changed from %s to %s by an admin.", roleLabel(rc.PreviousRole), roleLabel(rc.NewRole))
	if rc.NewRole == "premium" {
		if rc.PremiumExpiresAt != nil {
			body += fmt.Sprintf(" Your Premium trial expires on %s.", rc.PremiumExpiresAt.Format("Jan 2, 2006"))
		} else {
			body += " Premium access does not expire."
		}
	}
	if rc.BlockFuturePremium {
		body += " You have also been restricted from purchasing a new Premium subscription."
	}
	if rc.Reason != "" {
		body += fmt.Sprintf(" Reason: %s", rc.Reason)
	}
	return body
}

func formatCapacityShort(bytes int64) string {
	const tib = int64(1) << 40
	switch {
	case bytes >= 1024*tib:
		return strings.TrimSuffix(fmt.Sprintf("%.1f", float64(bytes)/float64(1024*tib)), ".0") + " PB"
	case bytes >= tib:
		return strings.TrimSuffix(fmt.Sprintf("%.1f", float64(bytes)/float64(tib)), ".0") + " TB"
	default:
		return fmt.Sprintf("%d GB", bytes/(1<<30))
	}
}

// plural returns "s" when n != 1, for simple count phrases.
func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func formatCentsShort(cents int) string {
	return fmt.Sprintf("$%d.%02d", cents/100, cents%100)
}

// clientIP extracts the real client IP from the request, preferring
// X-Real-IP (set by nginx) over the remote address.
func clientIP(c *gin.Context) string {
	if ip := c.GetHeader("X-Real-IP"); ip != "" {
		return strings.TrimSpace(ip)
	}
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		return c.Request.RemoteAddr
	}
	return host
}
