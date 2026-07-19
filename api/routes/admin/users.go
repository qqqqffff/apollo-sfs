package admin

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/sanitize"
)

// validTiers whitelists the drive_type values the server/tier filter accepts
// (mirrors the drives.drive_type CHECK constraint).
var validTiers = map[string]bool{"nvme": true, "hdd": true}

type updateQuotaRequest struct {
	QuotaBytes int64 `json:"quota_bytes" binding:"required,min=0"`
}

// GetUsers handles GET /api/v1/admin/users
func (h *Handler) GetUsers(c *gin.Context) {
	page := db.PageInput{
		Cursor: strings.TrimSpace(c.Query("cursor")),
	}
	if err := parseLimit(c, &page.Limit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be a positive integer"})
		return
	}

	result, err := h.queries.ListUsers(c.Request.Context(), page)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list users"})
		return
	}

	c.JSON(http.StatusOK, result)
}

// SearchUsers handles GET /api/v1/admin/users/search — the searched, sorted,
// role-filtered, offset-paginated listing behind the admin Users table.
// Query params: search, role ("admin"|"premium"|"user"), sort
// ("username"|"email"|"role"|"created_at"|"last_seen_at"), dir ("asc"|"desc"),
// server_id (a servers.id — repeat drive/tier restricted to that server),
// tier (repeatable: "nvme"|"hdd" — restricts to users with an allocation of
// that tier, combined with server_id when both are given), page (1-based),
// page_size.
func (h *Handler) SearchUsers(c *gin.Context) {
	page := 1
	if v := c.Query("page"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "page must be a positive integer"})
			return
		}
		page = n
	}
	pageSize := db.DefaultPageLimit
	if v := c.Query("page_size"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "page_size must be a positive integer"})
			return
		}
		pageSize = n
	}

	serverID := strings.TrimSpace(c.Query("server_id"))
	if serverID != "" {
		if _, err := uuid.Parse(serverID); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "server_id must be a valid UUID"})
			return
		}
	}

	var tiers []string
	for _, t := range c.QueryArray("tier") {
		if !validTiers[t] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "tier must be one of: nvme, hdd"})
			return
		}
		tiers = append(tiers, t)
	}

	f := db.ListUsersFilter{
		Search:   strings.TrimSpace(c.Query("search")),
		Role:     c.Query("role"),
		Sort:     c.Query("sort"),
		Dir:      c.Query("dir"),
		ServerID: serverID,
		Tiers:    tiers,
	}

	items, total, err := h.queries.ListAdminUsers(c.Request.Context(), f, pageSize, (page-1)*pageSize)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list users"})
		return
	}
	if items == nil {
		items = []models.User{}
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "total": total, "page": page, "page_size": pageSize})
}

// GetUser handles GET /api/v1/admin/users/:user_id
func (h *Handler) GetUser(c *gin.Context) {
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	c.JSON(http.StatusOK, user)
}

// UpdateUserQuota handles PATCH /api/v1/admin/users/:user_id/quota
func (h *Handler) UpdateUserQuota(c *gin.Context) {
	ctx := c.Request.Context()
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	var req updateQuotaRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "quota_bytes is required and must be >= 0"})
		return
	}

	// Validate that the user's current drive can accommodate the new quota.
	alloc, err := h.queries.GetUserDrive(ctx, username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve drive allocation"})
		return
	}
	if alloc != nil {
		user, err := h.queries.GetUserByUsername(ctx, username)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve user"})
			return
		}
		avail, err := h.queries.GetDriveAvailableBytes(ctx, alloc.DriveID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check drive capacity"})
			return
		}
		// Available space for this user = free drive space + their existing quota slot.
		maxQuota := avail + user.StorageQuotaBytes
		if req.QuotaBytes > maxQuota {
			c.JSON(http.StatusConflict, gin.H{
				"error":       "quota exceeds drive capacity",
				"max_bytes":   maxQuota,
				"drive_label": alloc.Drive.Label,
			})
			return
		}
	}

	if err := h.queries.UpdateUserQuota(ctx, username, req.QuotaBytes); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update quota"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "quota updated"})
}

type updateFeedbackAccessRequest struct {
	Enabled *bool `json:"enabled" binding:"required"`
}

// UpdateUserFeedbackAccess handles PATCH /api/v1/admin/users/:user_id/feedback-access.
// Toggles whether the user may submit the profile-page feedback form —
// disabled by default for every account.
func (h *Handler) UpdateUserFeedbackAccess(c *gin.Context) {
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	var req updateFeedbackAccessRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Enabled == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "enabled is required"})
		return
	}

	if err := h.queries.SetUserFeedbackAccess(c.Request.Context(), username, *req.Enabled); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update feedback access"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "feedback access updated", "feedback_access_enabled": *req.Enabled})
}

type updateUsernameRequest struct {
	NewUsername string `json:"new_username" binding:"required,min=3,max=150"`
}

// UpdateUsername handles PATCH /api/v1/admin/users/:user_id/username.
// Renames the user in both Keycloak and the app DB.
func (h *Handler) UpdateUsername(c *gin.Context) {
	oldUsername := sanitize.String(c.Param("user_id"))
	if oldUsername == "" || len(oldUsername) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	var req updateUsernameRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "new_username is required (3–150 characters)"})
		return
	}

	newUsername := sanitize.String(req.NewUsername)
	if newUsername == oldUsername {
		c.JSON(http.StatusOK, gin.H{"message": "username unchanged"})
		return
	}

	if err := h.auth.RenameUser(c.Request.Context(), oldUsername, newUsername); err != nil {
		if strings.Contains(err.Error(), "already taken") || strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "username updated"})
}
