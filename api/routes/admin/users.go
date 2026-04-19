package admin

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/sanitize"
)

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

	if err := h.queries.UpdateUserQuota(c.Request.Context(), username, req.QuotaBytes); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update quota"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "quota updated"})
}
