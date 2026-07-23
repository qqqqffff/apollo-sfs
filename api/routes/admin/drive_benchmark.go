package admin

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// DriveBenchmarkDetail is the admin-facing response for GET
// /admin/system/drives/benchmark: every disk's latest result plus the
// fast-vs-standard tier aggregates shown on the metrics page.
type DriveBenchmarkDetail struct {
	Pending  bool                      `json:"pending"`
	Disks    []db.NodeDiskBenchmarkRow `json:"disks"`
	Fast     *models.TierBenchmarkStat `json:"fast,omitempty"`
	Standard *models.TierBenchmarkStat `json:"standard,omitempty"`
}

// GetDriveBenchmark handles GET /admin/system/drives/benchmark.
func (h *Handler) GetDriveBenchmark(c *gin.Context) {
	ctx := c.Request.Context()

	pending, err := h.queries.CountPendingBenchmarkRequests(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check benchmark status"})
		return
	}

	rows, err := h.queries.ListNodeDiskBenchmarks(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load benchmark results"})
		return
	}
	fast, standard := db.AggregateBenchmarkRows(rows)

	c.JSON(http.StatusOK, DriveBenchmarkDetail{
		Pending:  pending > 0,
		Disks:    rows,
		Fast:     fast,
		Standard: standard,
	})
}

// TriggerDriveBenchmark handles POST /admin/system/drives/benchmark.
// Marks every active node as due for a benchmark run; each node's agent picks
// it up (and runs it) the next time it pushes its regular metrics sample —
// see docs/drive_benchmark_setup.md for why the trigger works this way rather
// than calling into the node directly. Returns 409 if a run is already
// pending/in flight so a second click doesn't stack requests.
func (h *Handler) TriggerDriveBenchmark(c *gin.Context) {
	ctx := c.Request.Context()

	pending, err := h.queries.CountPendingBenchmarkRequests(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check benchmark status"})
		return
	}
	if pending > 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "a benchmark run is already in progress"})
		return
	}

	if err := h.queries.RequestBenchmarkOnAllNodes(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start benchmark"})
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"status": "requested"})
}
