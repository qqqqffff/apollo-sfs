package admin

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/services"
)

// reconciliationTimeout bounds a manually-triggered scan run from an admin
// request. Listing object keys (no data transfer) across every drive should
// comfortably finish well inside this — the daily heartbeat has no such bound
// since it isn't tied to an HTTP request.
const reconciliationTimeout = 5 * time.Minute

// reconciliationStatus is the JSON response of GetReconciliation.
type reconciliationStatus struct {
	Run      any `json:"run"`
	Findings any `json:"findings"`
}

// GetReconciliation handles GET /admin/system/reconciliation.
// Returns the most recent scan (daily heartbeat or manual trigger) and its
// findings, or 204 No Content if no scan has ever run.
func (h *Handler) GetReconciliation(c *gin.Context) {
	ctx := c.Request.Context()
	run, err := h.queries.GetLatestReconciliationRun(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load reconciliation status"})
		return
	}
	if run == nil {
		c.Status(http.StatusNoContent)
		return
	}
	findings, err := h.queries.ListReconciliationFindings(ctx, &run.ID, 200)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load reconciliation findings"})
		return
	}
	c.JSON(http.StatusOK, reconciliationStatus{Run: run, Findings: findings})
}

// TriggerReconciliation handles POST /admin/system/reconciliation.
// Runs a full scan synchronously and returns its result. Returns 503 if a scan
// (this one or the daily heartbeat) is already in progress, or if the service
// was never configured.
func (h *Handler) TriggerReconciliation(c *gin.Context) {
	if h.reconcile == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "reconciliation is not configured"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), reconciliationTimeout)
	defer cancel()

	run, err := h.reconcile.RunOnce(ctx)
	if err != nil {
		if errors.Is(err, services.ErrReconciliationAlreadyRunning) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "a reconciliation scan is already running"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	findings, err := h.queries.ListReconciliationFindings(ctx, &run.ID, 200)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load reconciliation findings"})
		return
	}
	c.JSON(http.StatusOK, reconciliationStatus{Run: run, Findings: findings})
}
