package routes

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// GetPublicDriveBenchmark handles GET /api/v1/drive-benchmark. Unauthenticated
// by design, same spirit as GET /config — it's just the fast-vs-standard tier
// comparison (no per-disk breakdown), reused by the home page, registration,
// and Add Storage modal promo cards. Returns {"available": false} until the
// first admin-triggered benchmark run has completed, so callers show a
// "results coming soon" placeholder instead of a fabricated number.
func (h *Handler) GetPublicDriveBenchmark(c *gin.Context) {
	rows, err := h.queries.ListNodeDiskBenchmarks(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load benchmark results"})
		return
	}

	fast, standard := db.AggregateBenchmarkRows(rows)
	c.JSON(http.StatusOK, models.DriveBenchmarkSummary{
		Available: fast != nil || standard != nil,
		Fast:      fast,
		Standard:  standard,
	})
}
