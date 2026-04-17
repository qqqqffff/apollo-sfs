package routes

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

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
		IsAdmin:           user.IsAdmin,
	})
}
