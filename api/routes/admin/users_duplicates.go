package admin

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/services"
)

// DuplicateReconciler is the subset of *services.UserReconcileService used by
// the duplicate-account endpoints.
type DuplicateReconciler interface {
	Preview(ctx context.Context) ([]services.DuplicateGroup, error)
	Start(actor string) error
	Status() *services.UserReconcileReport
}

var _ DuplicateReconciler = (*services.UserReconcileService)(nil)

// SetDuplicateReconciler installs the duplicate-account reconciler; nil makes
// its endpoints return 503.
func (h *Handler) SetDuplicateReconciler(r DuplicateReconciler) { h.duplicates = r }

// duplicatesResponse is the body of both duplicate-account endpoints.
type duplicatesResponse struct {
	Groups []services.DuplicateGroup     `json:"groups"`
	Run    *services.UserReconcileReport `json:"run"`
}

// ListDuplicateUsers handles GET /api/v1/admin/users/duplicates — every group
// of rows that are one person (or a single row in a spelling Keycloak never
// issues), what reconciling would do to each, and the latest run's report.
func (h *Handler) ListDuplicateUsers(c *gin.Context) {
	if h.duplicates == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "duplicate reconciliation is not configured"})
		return
	}
	groups, err := h.duplicates.Preview(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check for duplicate accounts: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, duplicatesResponse{Groups: groups, Run: h.duplicates.Status()})
}

// ReconcileDuplicateUsers handles POST /api/v1/admin/users/duplicates/reconcile.
// Starts a background run that folds every reconcilable group into one
// account; poll ListDuplicateUsers for progress. 409 while a run is going.
func (h *Handler) ReconcileDuplicateUsers(c *gin.Context) {
	if h.duplicates == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "duplicate reconciliation is not configured"})
		return
	}
	if err := h.duplicates.Start(c.GetString("username")); err != nil {
		if errors.Is(err, services.ErrUserReconcileRunning) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusAccepted, duplicatesResponse{Groups: []services.DuplicateGroup{}, Run: h.duplicates.Status()})
}
