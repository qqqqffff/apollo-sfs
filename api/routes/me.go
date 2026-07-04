package routes

import (
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/services"
)

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password" binding:"required"`
	NewPassword     string `json:"new_password" binding:"required"`
}

// ChangePassword handles POST /api/v1/me/password.
// Verifies the current password then sets the new one via Keycloak.
func (h *Handler) ChangePassword(c *gin.Context) {
	username := c.GetString("username")

	var req changePasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "current_password and new_password are required"})
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
	LinkedProviders   []string   `json:"linked_providers"`
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

	c.JSON(http.StatusOK, meResponse{
		Username:          user.Username,
		Email:             user.Email,
		StorageUsedBytes:  user.StorageUsedBytes,
		StorageQuotaBytes: user.StorageQuotaBytes,
		StorageUsedPct:    usedPct,
		LastSeenAt:        user.LastSeenAt,
		CreatedAt:         user.CreatedAt,
		IsAdmin:           isAdmin,
		IsPremium:         user.IsPremium,
		PremiumGrantedAt:  user.PremiumGrantedAt,
		LinkedProviders:   linkedProviders,
	})
}

type socialLinkRequest struct {
	Provider       string `json:"provider"        binding:"required"`
	Token          string `json:"token"`
	ServerAuthCode string `json:"server_auth_code"`
}

type socialUnlinkRequest struct {
	Provider string `json:"provider" binding:"required"`
}

// LinkSocial handles POST /api/v1/me/social/link.
// Links an Apple or Google identity to the authenticated user's account.
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
	if req.Provider != "apple" && req.Provider != "google" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "provider must be apple or google"})
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
// Removes an Apple or Google identity link from the authenticated user's account.
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
	if req.Provider != "apple" && req.Provider != "google" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "provider must be apple or google"})
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
// capacity_provisioned | payment_required | action_pending | share_received.
type notificationItem struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Link      string    `json:"link"`
	CreatedAt time.Time `json:"created_at"`
}

// shareNotificationWindow bounds how long a received share keeps showing in
// the bell dropdown.
const shareNotificationWindow = 30 * 24 * time.Hour

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

	items := []notificationItem{}

	requests, err := h.queries.ListUserExpansionRequests(ctx, username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "load notifications"})
		return
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
				Link:      "/client/orders",
				CreatedAt: provisionedAt,
			})
			if remaining := r.FullPriceCents - r.DepositAmountCents; remaining > 0 {
				items = append(items, notificationItem{
					ID:        r.ID.String() + ":payment",
					Kind:      "payment_required",
					Title:     "Payment required",
					Body:      fmt.Sprintf("The remaining balance of %s for your %s expansion is due.", formatCentsShort(remaining), capacity),
					Link:      "/client/orders?pay=" + r.ID.String(),
					CreatedAt: provisionedAt,
				})
			}
		case "invoice_sent":
			link := "/client/orders"
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

	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })

	c.JSON(http.StatusOK, gin.H{"items": items})
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
