package admin

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/routes/services"
)

const speedTestBlobBytes = 32 * 1024 * 1024 // 32 MB — enough to saturate most links without OOM on a Pi

// Cloudflare's public speed-test endpoints (the same ones speed.cloudflare.com
// itself uses) — unauthenticated, free, and built exactly for measuring a
// server's throughput to the internet. __down streams back the requested byte
// count; __up accepts and discards any POST body.
const (
	speedTestDownloadURL = "https://speed.cloudflare.com/__down?bytes=%d"
	speedTestUploadURL   = "https://speed.cloudflare.com/__up"
)

// speedTestHTTPClient bounds each probe so a stalled connection can't hang the
// 30-minute loop or a synchronous admin request indefinitely.
var speedTestHTTPClient = &http.Client{Timeout: 60 * time.Second}

// SpeedTestResult is the outcome of one upload+download probe against the
// public internet (Cloudflare), independent of MinIO/local storage — this
// measures the server's WAN link, not intra-cluster throughput.
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

	h.speedTestMu.Lock()
	h.latestSpeedTest = result
	h.speedTestMu.Unlock()

	status := http.StatusOK
	if result.Error != "" {
		status = http.StatusInternalServerError
	}
	c.JSON(status, result)
}

// LatestSpeedTestResult returns the most recent speed test result for inclusion
// in WS stream broadcasts. Implements services.SpeedTestStreamProvider.
func (h *Handler) LatestSpeedTestResult() *services.SpeedTestResultSnapshot {
	h.speedTestMu.RLock()
	result := h.latestSpeedTest
	h.speedTestMu.RUnlock()
	if result == nil {
		return nil
	}
	return &services.SpeedTestResultSnapshot{
		UploadMbps:   result.UploadMbps,
		DownloadMbps: result.DownloadMbps,
		TestedAt:     result.TestedAt,
		Error:        result.Error,
	}
}

// SpeedTestLoop runs a probe every 30 minutes until ctx is cancelled.
// Intended to be called in a goroutine from main after the handler is wired up.
// The probe is skipped when current network traffic exceeds 50 % of the last
// measured capacity — the loop retries on the next tick rather than waiting.
func (h *Handler) SpeedTestLoop(ctx context.Context) {
	tick := time.NewTicker(30 * time.Minute)
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
				h.speedTestMu.Lock()
				h.latestSpeedTest = result
				h.speedTestMu.Unlock()
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

// runSpeedTest performs one upload+download cycle against Cloudflare's public
// speed-test endpoints and returns timing results. This has no dependency on
// MinIO/storage being configured — it measures the server's actual internet
// uplink/downlink, not throughput to a local/internal service, so it always
// runs (never returns nil); any failure is reported via SpeedTestResult.Error.
func (h *Handler) runSpeedTest(ctx context.Context) *SpeedTestResult {
	uploadMbps, err := probeUploadMbps(ctx)
	if err != nil {
		return &SpeedTestResult{Error: fmt.Sprintf("upload: %v", err), TestedAt: time.Now()}
	}

	downloadMbps, downloadBytes, err := probeDownloadMbps(ctx)
	if err != nil {
		return &SpeedTestResult{Error: fmt.Sprintf("download: %v", err), TestedAt: time.Now()}
	}

	return &SpeedTestResult{
		UploadMbps:   uploadMbps,
		DownloadMbps: downloadMbps,
		SizeBytes:    downloadBytes,
		TestedAt:     time.Now(),
	}
}

// probeUploadMbps POSTs a throwaway blob to Cloudflare's speed-test upload
// endpoint (it discards the body) and times the round trip.
func probeUploadMbps(ctx context.Context) (float64, error) {
	blob := make([]byte, speedTestBlobBytes)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, speedTestUploadURL, bytes.NewReader(blob))
	if err != nil {
		return 0, fmt.Errorf("build request: %w", err)
	}
	req.ContentLength = speedTestBlobBytes

	start := time.Now()
	resp, err := speedTestHTTPClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body) //nolint:errcheck
	if resp.StatusCode >= 400 {
		return 0, fmt.Errorf("cloudflare speed test returned %s", resp.Status)
	}
	return float64(speedTestBlobBytes) / time.Since(start).Seconds() / (1024 * 1024), nil
}

// probeDownloadMbps GETs a fixed-size blob from Cloudflare's speed-test
// download endpoint and times how long it takes to stream in fully.
func probeDownloadMbps(ctx context.Context) (mbps float64, bytesRead int64, err error) {
	url := fmt.Sprintf(speedTestDownloadURL, speedTestBlobBytes)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("build request: %w", err)
	}

	start := time.Now()
	resp, err := speedTestHTTPClient.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return 0, 0, fmt.Errorf("cloudflare speed test returned %s", resp.Status)
	}
	n, err := io.Copy(io.Discard, resp.Body)
	if err != nil {
		return 0, 0, err
	}
	return float64(n) / time.Since(start).Seconds() / (1024 * 1024), n, nil
}
