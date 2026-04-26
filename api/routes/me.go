package routes

import (
	"database/sql"
	"errors"
	"net/http"
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

	user, err := h.queries.GetUserByUsername(c.Request.Context(), username.(string))
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

	c.JSON(http.StatusOK, meResponse{
		Username:          user.Username,
		Email:             user.Email,
		StorageUsedBytes:  user.StorageUsedBytes,
		StorageQuotaBytes: user.StorageQuotaBytes,
		StorageUsedPct:    usedPct,
		LastSeenAt:        user.LastSeenAt,
		CreatedAt:         user.CreatedAt,
		IsAdmin:           isAdmin,
	})
}
