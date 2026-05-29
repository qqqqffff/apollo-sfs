package admin

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/routes/services"
)

// ListInterestSubmissions handles GET /api/v1/admin/interest.
// Returns a paginated list of all interest form submissions.
func (h *Handler) ListInterestSubmissions(c *gin.Context) {
	page := db.PageInput{
		Cursor: strings.TrimSpace(c.Query("cursor")),
	}
	if err := parseLimit(c, &page.Limit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be a positive integer"})
		return
	}

	result, err := h.queries.ListInterestSubmissions(c.Request.Context(), page)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list submissions"})
		return
	}

	c.JSON(http.StatusOK, result)
}

// GetInterestFormSettings handles GET /api/v1/admin/interest/settings.
func (h *Handler) GetInterestFormSettings(c *gin.Context) {
	settings, err := h.queries.GetInterestFormSettings(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load settings"})
		return
	}
	c.JSON(http.StatusOK, settings)
}

type updateInterestSettingsRequest struct {
	DailyCap int `json:"daily_cap" binding:"required,min=1,max=100000"`
}

// UpdateInterestFormSettings handles PUT /api/v1/admin/interest/settings.
func (h *Handler) UpdateInterestFormSettings(c *gin.Context) {
	var req updateInterestSettingsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "daily_cap must be a positive integer"})
		return
	}

	settings, err := h.queries.UpdateInterestFormSettings(c.Request.Context(), req.DailyCap)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update settings"})
		return
	}
	c.JSON(http.StatusOK, settings)
}

type provisionInterestRequest struct {
	InitialQuotaBytes int64 `json:"initial_quota_bytes"`
	GrantAdmin        bool  `json:"grant_admin"`
}

// ProvisionInterestSubmission handles POST /api/v1/admin/interest/:id/provision.
// Creates an invitation for the submission's email (same flow as CreateInvitation)
// and marks the submission as provisioned.
func (h *Handler) ProvisionInterestSubmission(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid submission id"})
		return
	}

	var req provisionInterestRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}

	ctx := c.Request.Context()

	// Load the submission.
	submission, err := h.queries.GetInterestSubmissionByID(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "submission not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load submission"})
		return
	}

	if submission.ProvisionedAt != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "this submission has already been provisioned"})
		return
	}

	invitedByUserID, _ := c.Get("userID")
	invitedByUsername, _ := c.Get("username")

	adminID, err := uuid.Parse(invitedByUserID.(string))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid user context"})
		return
	}

	// Create the invitation via the invite service (same as standard invite flow).
	inv, err := h.invites.Create(ctx, adminID, invitedByUsername.(string), submission.Email, req.InitialQuotaBytes, req.GrantAdmin)
	if err != nil {
		if errors.Is(err, services.ErrInviteAlreadyPending) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create invitation"})
		return
	}

	// Link the invitation back to the submission.
	if err := h.queries.MarkInterestSubmissionProvisioned(ctx, id, inv.ID); err != nil {
		// Non-fatal: the invitation was created; just log.
		c.JSON(http.StatusOK, inv)
		return
	}

	c.JSON(http.StatusCreated, inv)
}
