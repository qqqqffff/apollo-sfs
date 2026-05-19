package admin

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/routes/services"
)

const speedTestBlobBytes = 32 * 1024 * 1024 // 32 MB — enough to saturate most links without OOM on a Pi

// SpeedTestResult is the outcome of one upload+download probe against MinIO.
type SpeedTestResult struct {
	UploadMbps   float64   `json:"upload_mbps"`
	DownloadMbps float64   `json:"download_mbps"`
	SizeBytes    int64     `json:"size_bytes"`
	TestedAt     time.Time `json:"tested_at"`
	Error        string    `json:"error,omitempty"`
}

// LatestSpeedTestMbps returns max(upload, download) from the most recent speed
// test result, or 0 when no test has run or the last test failed.
// Implements services.SpeedTestProvider.
func (h *Handler) LatestSpeedTestMbps() float64 {
	h.speedTestMu.RLock()
	result := h.latestSpeedTest
	h.speedTestMu.RUnlock()
	if result == nil || result.Error != "" {
		return 0
	}
	if result.UploadMbps > result.DownloadMbps {
		return result.UploadMbps
	}
	return result.DownloadMbps
}

// GetSpeedTest handles GET /admin/system/speed-test.
// Returns the most recently cached result, or 204 No Content if no test has run yet.
func (h *Handler) GetSpeedTest(c *gin.Context) {
	h.speedTestMu.RLock()
	result := h.latestSpeedTest
	h.speedTestMu.RUnlock()

	if result == nil {
		c.Status(http.StatusNoContent)
		return
	}
	c.JSON(http.StatusOK, result)
}

// TriggerSpeedTest handles POST /admin/system/speed-test.
// Runs the probe synchronously and returns the result. Returns 503 if a run
// is already in progress or network traffic exceeds 50 % of the last measured
// capacity (results would be unreliable under load).
func (h *Handler) TriggerSpeedTest(c *gin.Context) {
	if !h.speedTestRunning.CompareAndSwap(false, true) {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "speed test already in progress"})
		return
	}
	defer h.speedTestRunning.Store(false)

	ctx, cancel := context.WithTimeout(c.Request.Context(), 120*time.Second)
	defer cancel()

	if h.isNetworkTrafficHigh(ctx) {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "network traffic exceeds 50% of last measured capacity — try again when load decreases",
		})
		return
	}

	result := h.runSpeedTest(ctx)
	if result == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "no active storage configured"})
		return
	}

	h.speedTestMu.Lock()
	h.latestSpeedTest = result
	h.speedTestMu.Unlock()

	status := http.StatusOK
	if result.Error != "" {
		status = http.StatusInternalServerError
	}
	c.JSON(status, result)
}

// SpeedTestLoop runs a probe every 15 minutes until ctx is cancelled.
// Intended to be called in a goroutine from main after the handler is wired up.
// The probe is skipped when current network traffic exceeds 50 % of the last
// measured capacity — the loop retries on the next tick rather than waiting.
func (h *Handler) SpeedTestLoop(ctx context.Context) {
	if h.registry == nil {
		return
	}
	tick := time.NewTicker(15 * time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if h.isNetworkTrafficHigh(ctx) {
				continue
			}
			if h.speedTestRunning.CompareAndSwap(false, true) {
				result := h.runSpeedTest(ctx)
				h.speedTestRunning.Store(false)
				if result != nil {
					h.speedTestMu.Lock()
					h.latestSpeedTest = result
					h.speedTestMu.Unlock()
				}
			}
		}
	}
}

// isNetworkTrafficHigh returns true when the current network throughput (derived
// from the two most recent metric snapshots) exceeds 50 % of the capacity
// measured by the last speed test. Returns false if there is no reference
// capacity yet or if recent snapshots are unavailable.
func (h *Handler) isNetworkTrafficHigh(ctx context.Context) bool {
	if h.metrics == nil {
		return false
	}

	h.speedTestMu.RLock()
	last := h.latestSpeedTest
	h.speedTestMu.RUnlock()

	if last == nil || last.Error != "" {
		return false
	}
	capacityMbps := max(last.UploadMbps, last.DownloadMbps)
	if capacityMbps <= 0 {
		return false
	}

	snaps, err := h.metrics.GetHistoryByHours(ctx, 1)
	if err != nil || len(snaps) < 2 {
		return false
	}

	prev := snaps[len(snaps)-2]
	curr := snaps[len(snaps)-1]
	dtSec := curr.SampledAt.Sub(prev.SampledAt).Seconds()
	if dtSec <= 0 {
		return false
	}

	sentMbps := float64(curr.NetworkBytesSent-prev.NetworkBytesSent) / dtSec * 8 / (1024 * 1024)
	recvMbps := float64(curr.NetworkBytesRecv-prev.NetworkBytesRecv) / dtSec * 8 / (1024 * 1024)
	currentMbps := max(sentMbps, recvMbps)

	return currentMbps > capacityMbps*0.5
}

// runSpeedTest performs one upload+download cycle against the first active
// MinIO drive and returns timing results. Returns nil if no storage is
// available (registry or queries not configured).
func (h *Handler) runSpeedTest(ctx context.Context) *SpeedTestResult {
	if h.registry == nil || h.queries == nil {
		return nil
	}

	drives, err := h.queries.GetDriveSummaries(ctx)
	if err != nil {
		return &SpeedTestResult{Error: fmt.Sprintf("list drives: %v", err), TestedAt: time.Now()}
	}

	var svc *services.MinIOService
	for _, d := range drives {
		if !d.DriveIsActive || !d.ServerIsActive {
			continue
		}
		client, ok := h.registry.Client(d.ServerID)
		if !ok {
			continue
		}
		svc = services.NewMinIOService(client, d.MinioBucket)
		break
	}
	if svc == nil {
		return &SpeedTestResult{Error: "no active storage target found", TestedAt: time.Now()}
	}

	key := "_speed-probe/" + uuid.NewString()
	defer svc.RemoveObject(context.Background(), key) //nolint:errcheck

	blob := make([]byte, speedTestBlobBytes)

	// ── Upload ────────────────────────────────────────────────────────────────
	uploadStart := time.Now()
	if err := svc.PutObject(ctx, key, bytes.NewReader(blob), speedTestBlobBytes, "application/octet-stream"); err != nil {
		return &SpeedTestResult{Error: fmt.Sprintf("upload: %v", err), TestedAt: time.Now()}
	}
	uploadMbps := float64(speedTestBlobBytes) / time.Since(uploadStart).Seconds() / (1024 * 1024)

	// ── Download ──────────────────────────────────────────────────────────────
	downloadStart := time.Now()
	rc, err := svc.GetObject(ctx, key)
	if err != nil {
		return &SpeedTestResult{Error: fmt.Sprintf("download: %v", err), TestedAt: time.Now()}
	}
	_, copyErr := io.Copy(io.Discard, rc)
	rc.Close()
	if copyErr != nil {
		return &SpeedTestResult{Error: fmt.Sprintf("download read: %v", copyErr), TestedAt: time.Now()}
	}
	downloadMbps := float64(speedTestBlobBytes) / time.Since(downloadStart).Seconds() / (1024 * 1024)

	return &SpeedTestResult{
		UploadMbps:   uploadMbps,
		DownloadMbps: downloadMbps,
		SizeBytes:    speedTestBlobBytes,
		TestedAt:     time.Now(),
	}
}
