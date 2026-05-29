package admin

import (
	"errors"
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/sanitize"
)

// Recognised TOS violation codes. "other" is always valid.
var validViolationCodes = map[string]bool{
	"illegal_activity":    true,
	"third_party_rights":  true,
	"violence_harm":       true,
	"child_exploitation":  true,
	"system_attacks":      true,
	"spam":                true,
	"reverse_engineering": true,
	"unauthorized_resale": true,
	"security_risk":       true,
	"material_breach":     true,
	"other":               true,
}

// ── BanUser ───────────────────────────────────────────────────────────────────

type banUserRequest struct {
	ViolationCode string `json:"violation_code" binding:"required"`
	Comments      string `json:"comments"`
}

// BanUser handles POST /api/v1/admin/users/:user_id/ban.
// Creates a permanent ban record, deletes all user files, and resets quota.
func (h *Handler) BanUser(c *gin.Context) {
	target := sanitize.String(c.Param("user_id"))
	if target == "" || len(target) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	var req banUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "violation_code is required"})
		return
	}
	if !validViolationCodes[req.ViolationCode] {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("unknown violation_code %q", req.ViolationCode)})
		return
	}

	ctx := c.Request.Context()
	admin := c.GetString("username")

	if _, err := h.queries.GetUserByUsername(ctx, target); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	// Pardon any existing active ban/suspension before creating the new one.
	_ = h.queries.PardonAllActiveBans(ctx, target, admin)

	if _, err := h.queries.CreateBan(ctx, db.CreateBanParams{
		Username:      target,
		BanType:       "banned",
		ViolationCode: req.ViolationCode,
		Comments:      strings.TrimSpace(req.Comments),
		BannedBy:      admin,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create ban record"})
		return
	}

	// Delete all files and free storage quota immediately.
	if h.files != nil {
		if err := h.files.AdminDeleteAllFiles(ctx, target); err != nil {
			log.Printf("BanUser: delete files for %q: %v", target, err)
		}
	}

	c.JSON(http.StatusOK, gin.H{"message": "user banned"})
}

// ── SuspendUser ───────────────────────────────────────────────────────────────

type suspendUserRequest struct {
	ViolationCode string `json:"violation_code" binding:"required"`
	Comments      string `json:"comments"`
	Hours         int    `json:"hours" binding:"required,min=1"`
}

// SuspendUser handles POST /api/v1/admin/users/:user_id/suspend.
// Creates a time-limited suspension record.
func (h *Handler) SuspendUser(c *gin.Context) {
	target := sanitize.String(c.Param("user_id"))
	if target == "" || len(target) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	var req suspendUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "violation_code and hours (≥1) are required"})
		return
	}
	if !validViolationCodes[req.ViolationCode] {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("unknown violation_code %q", req.ViolationCode)})
		return
	}

	ctx := c.Request.Context()
	admin := c.GetString("username")

	if _, err := h.queries.GetUserByUsername(ctx, target); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	// Pardon any existing active ban/suspension first.
	_ = h.queries.PardonAllActiveBans(ctx, target, admin)

	expiresAt := time.Now().Add(time.Duration(req.Hours) * time.Hour).UTC().Format(time.RFC3339)

	if _, err := h.queries.CreateBan(ctx, db.CreateBanParams{
		Username:      target,
		BanType:       "suspended",
		ViolationCode: req.ViolationCode,
		Comments:      strings.TrimSpace(req.Comments),
		BannedBy:      admin,
		ExpiresAt:     &expiresAt,
	}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create suspension record"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "user suspended"})
}

// ── PardonUser ────────────────────────────────────────────────────────────────

// PardonUser handles POST /api/v1/admin/users/:user_id/pardon.
// Lifts any active ban or suspension.
func (h *Handler) PardonUser(c *gin.Context) {
	target := sanitize.String(c.Param("user_id"))
	if target == "" || len(target) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	admin := c.GetString("username")
	if err := h.queries.PardonAllActiveBans(c.Request.Context(), target, admin); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not pardon user"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "user pardoned"})
}

// ── ListUserBans ──────────────────────────────────────────────────────────────

// ListUserBans handles GET /api/v1/admin/bans.
// Query params: status=active (default) | all, cursor, limit.
func (h *Handler) ListUserBans(c *gin.Context) {
	activeOnly := strings.ToLower(c.DefaultQuery("status", "active")) == "active"

	page := db.PageInput{Cursor: strings.TrimSpace(c.Query("cursor"))}
	if err := parseLimit(c, &page.Limit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be a positive integer"})
		return
	}

	result, err := h.queries.ListUserBans(c.Request.Context(), activeOnly, page)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list user bans"})
		return
	}

	c.JSON(http.StatusOK, result)
}
