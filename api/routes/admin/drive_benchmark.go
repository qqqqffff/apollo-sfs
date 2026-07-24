package admin

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// BenchmarkNodeProgress is one node currently mid-run — which disk and which
// step — for the admin page's live progress display. Converted from
// db.NodeBenchmarkProgress so the JSON shape (snake_case) is under this
// package's control rather than the db layer's.
type BenchmarkNodeProgress struct {
	Hostname  string `json:"hostname"`
	Label     string `json:"label"`
	Step      string `json:"step"`
	DriveType string `json:"drive_type"`
}

// DriveBenchmarkDetail is the admin-facing response for GET
// /admin/system/drives/benchmark: every disk's latest result plus the
// fast-vs-standard tier aggregates shown on the metrics page.
//
// CompletedNodes/TotalNodes back the progress bar's fill: a node's benchmark
// result arrives in one atomic push (see docs/drive_benchmark_setup.md), so
// per-node is the coarsest progress signal — TotalNodes is every active node
// a triggered run fans out to, CompletedNodes is how many have already
// reported back (or never had anything pending, when no run is in flight).
// Running fills in the finer-grained detail within that: which disk and step
// each still-in-flight node is currently executing.
type DriveBenchmarkDetail struct {
	Pending        bool                      `json:"pending"`
	CompletedNodes int                       `json:"completed_nodes"`
	TotalNodes     int                       `json:"total_nodes"`
	Running        []BenchmarkNodeProgress   `json:"running,omitempty"`
	Disks          []db.NodeDiskBenchmarkRow `json:"disks"`
	Fast           *models.TierBenchmarkStat `json:"fast,omitempty"`
	Standard       *models.TierBenchmarkStat `json:"standard,omitempty"`
}

// GetDriveBenchmark handles GET /admin/system/drives/benchmark.
func (h *Handler) GetDriveBenchmark(c *gin.Context) {
	ctx := c.Request.Context()

	inFlight, err := h.queries.CountInFlightBenchmarkNodes(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check benchmark status"})
		return
	}
	totalNodes, err := h.queries.CountActiveNodes(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check benchmark status"})
		return
	}
	completedNodes := totalNodes - inFlight
	if completedNodes < 0 {
		completedNodes = 0
	}

	runningRows, err := h.queries.ListRunningBenchmarkNodes(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check benchmark status"})
		return
	}
	running := make([]BenchmarkNodeProgress, 0, len(runningRows))
	for _, r := range runningRows {
		running = append(running, BenchmarkNodeProgress{
			Hostname:  r.Hostname,
			Label:     r.Label,
			Step:      r.Step,
			DriveType: r.DriveType,
		})
	}

	rows, err := h.queries.ListNodeDiskBenchmarks(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load benchmark results"})
		return
	}
	fast, standard := db.AggregateBenchmarkRows(rows)

	c.JSON(http.StatusOK, DriveBenchmarkDetail{
		Pending:        inFlight > 0,
		CompletedNodes: completedNodes,
		TotalNodes:     totalNodes,
		Running:        running,
		Disks:          rows,
		Fast:           fast,
		Standard:       standard,
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

	inFlight, err := h.queries.CountInFlightBenchmarkNodes(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check benchmark status"})
		return
	}
	if inFlight > 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "a benchmark run is already in progress"})
		return
	}

	if err := h.queries.RequestBenchmarkOnAllNodes(ctx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start benchmark"})
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"status": "requested"})
}
