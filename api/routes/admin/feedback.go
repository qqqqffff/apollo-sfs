package admin

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
)

var validFeedbackStatuses = map[string]bool{
	"new":      true,
	"reviewed": true,
	"archived": true,
}

// ListFeedback handles GET /api/v1/admin/feedback.
// Query params: status=new|reviewed|archived (default: all), cursor, limit.
func (h *Handler) ListFeedback(c *gin.Context) {
	status := strings.TrimSpace(c.Query("status"))
	if status != "" && !validFeedbackStatuses[status] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "status must be one of: new, reviewed, archived"})
		return
	}

	page := db.PageInput{Cursor: strings.TrimSpace(c.Query("cursor"))}
	if err := parseLimit(c, &page.Limit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be a positive integer"})
		return
	}

	result, err := h.queries.ListFeedback(c.Request.Context(), status, page)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list feedback"})
		return
	}

	c.JSON(http.StatusOK, result)
}

type updateFeedbackStatusRequest struct {
	Status string `json:"status" binding:"required"`
}

// UpdateFeedbackStatus handles PATCH /api/v1/admin/feedback/:id/status.
func (h *Handler) UpdateFeedbackStatus(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id must be a valid UUID"})
		return
	}

	var req updateFeedbackStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "status is required"})
		return
	}
	if !validFeedbackStatuses[req.Status] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "status must be one of: new, reviewed, archived"})
		return
	}

	fb, err := h.queries.UpdateFeedbackStatus(c.Request.Context(), id, req.Status)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "feedback not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update feedback"})
		return
	}

	c.JSON(http.StatusOK, fb)
}
