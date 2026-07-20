package routes

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

var validFeedbackCategories = map[string]bool{
	"bug":     true,
	"feature": true,
	"general": true,
}

const maxFeedbackMessageLen = 5000

type submitFeedbackRequest struct {
	Category string `json:"category" binding:"required"`
	Message  string `json:"message" binding:"required"`
}

// SubmitFeedback handles POST /api/v1/feedback.
// Gated by the user's feedback_access_enabled flag (disabled by default;
// admins grant it per-user from the admin Feedback → Access tab).
func (h *Handler) SubmitFeedback(c *gin.Context) {
	userID, err := uuid.Parse(c.GetString("userID"))
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid session"})
		return
	}
	username := c.GetString("username")

	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not verify feedback access"})
		return
	}
	if user == nil || !user.FeedbackAccessEnabled {
		c.JSON(http.StatusForbidden, gin.H{"error": "feedback access is not enabled for your account"})
		return
	}

	var req submitFeedbackRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "category and message are required"})
		return
	}
	if !validFeedbackCategories[req.Category] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "category must be one of: bug, feature, general"})
		return
	}
	message := strings.TrimSpace(req.Message)
	if message == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "message cannot be empty"})
		return
	}
	if len(message) > maxFeedbackMessageLen {
		c.JSON(http.StatusBadRequest, gin.H{"error": "message must be 5000 characters or fewer"})
		return
	}

	fb, err := h.queries.CreateFeedback(c.Request.Context(), userID, username, req.Category, message)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not submit feedback"})
		return
	}
	c.JSON(http.StatusCreated, fb)
}
