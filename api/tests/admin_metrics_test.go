package tests

import (
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"apollo-sfs.com/api/models"
)

// ── helpers ───────────────────────────────────────────────────────────────────

func ptr[T any](v T) *T { return &v }

func sampleSnapshot() *models.ServerMetricSnapshot {
	return &models.ServerMetricSnapshot{
		CPUPercent:                 12.5,
		MemoryUsedBytes:            2 * 1024 * 1024 * 1024,
		MemoryTotalBytes:           8 * 1024 * 1024 * 1024,
		NetworkBytesSent:           1000,
		NetworkBytesRecv:           2000,
		StorageTotalUsedBytes:      500 * 1024 * 1024,
		StorageTotalQuotaBytes:     10 * 1024 * 1024 * 1024,
		DiskTotalBytes:             100 * 1024 * 1024 * 1024,
		DiskFreeBytes:              60 * 1024 * 1024 * 1024,
		ActiveUserCount:            3,
		TotalUserCount:             10,
		SampledAt:                  time.Now().UTC(),
		CPUTempCelsius:             ptr(55.0),
		DriveTempCelsius:           ptr(42.0),
		ServerISPPingMs:            ptr(14.3),
		ServerISPPacketLossPercent: ptr(0.0),
	}
}

// ── GET /system/metrics ───────────────────────────────────────────────────────

func TestGetMetrics_OK(t *testing.T) {
	snap := sampleSnapshot()
	h := newMetricsAdminHandler(&stubAdminQuerier{}, &stubMetricsService{latest: snap})

	r := newEngine()
	r.GET("/admin/system/metrics", h.GetMetrics)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/metrics", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["cpu_percent"] == nil {
		t.Error("expected cpu_percent in response")
	}
	if body["server_isp_ping_ms"] == nil {
		t.Error("expected server_isp_ping_ms in response")
	}
	if body["server_isp_packet_loss_percent"] == nil {
		t.Error("expected server_isp_packet_loss_percent in response")
	}
}

func TestGetMetrics_NullPingFields(t *testing.T) {
	snap := sampleSnapshot()
	snap.ServerISPPingMs = nil
	snap.ServerISPPacketLossPercent = nil
	h := newMetricsAdminHandler(&stubAdminQuerier{}, &stubMetricsService{latest: snap})

	r := newEngine()
	r.GET("/admin/system/metrics", h.GetMetrics)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/metrics", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if v, ok := body["server_isp_ping_ms"]; !ok || v != nil {
		t.Errorf("expected server_isp_ping_ms to be null, got %v", v)
	}
	if v, ok := body["server_isp_packet_loss_percent"]; !ok || v != nil {
		t.Errorf("expected server_isp_packet_loss_percent to be null, got %v", v)
	}
}

func TestGetMetrics_NotFound(t *testing.T) {
	h := newMetricsAdminHandler(&stubAdminQuerier{}, &stubMetricsService{latestErr: sql.ErrNoRows})

	r := newEngine()
	r.GET("/admin/system/metrics", h.GetMetrics)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/metrics", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestGetMetrics_DBError(t *testing.T) {
	h := newMetricsAdminHandler(&stubAdminQuerier{}, &stubMetricsService{latestErr: errors.New("db down")})

	r := newEngine()
	r.GET("/admin/system/metrics", h.GetMetrics)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/metrics", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}

// ── GET /system/metrics/history ───────────────────────────────────────────────

func TestGetMetricsHistory_ByHours(t *testing.T) {
	snaps := []models.ServerMetricSnapshot{*sampleSnapshot(), *sampleSnapshot()}
	h := newMetricsAdminHandler(&stubAdminQuerier{}, &stubMetricsService{history: snaps})

	r := newEngine()
	r.GET("/admin/system/metrics/history", h.GetMetricsHistory)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/metrics/history?hours=12", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body []map[string]any
	decodeBody(w, &body) //nolint
	if len(body) != 2 {
		t.Fatalf("expected 2 snapshots, got %d", len(body))
	}
	if body[0]["server_isp_ping_ms"] == nil {
		t.Error("expected server_isp_ping_ms in history snapshot")
	}
}

func TestGetMetricsHistory_InvalidHours(t *testing.T) {
	h := newMetricsAdminHandler(&stubAdminQuerier{}, &stubMetricsService{})

	r := newEngine()
	r.GET("/admin/system/metrics/history", h.GetMetricsHistory)

	for _, q := range []string{"hours=0", "hours=-1", "hours=73", "hours=abc"} {
		req := httptest.NewRequest(http.MethodGet, "/admin/system/metrics/history?"+q, nil)
		w := doRequest(r, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("?%s: expected 400, got %d", q, w.Code)
		}
	}
}

func TestGetMetricsHistory_ByHoursDBError(t *testing.T) {
	h := newMetricsAdminHandler(&stubAdminQuerier{}, &stubMetricsService{historyErr: errors.New("db down")})

	r := newEngine()
	r.GET("/admin/system/metrics/history", h.GetMetricsHistory)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/metrics/history?hours=1", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}

func TestGetMetricsHistory_Paginated(t *testing.T) {
	snaps := []models.ServerMetricSnapshot{*sampleSnapshot()}
	h := newMetricsAdminHandler(&stubAdminQuerier{}, &stubMetricsService{history: snaps})

	r := newEngine()
	r.GET("/admin/system/metrics/history", h.GetMetricsHistory)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/metrics/history?limit=10", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["items"] == nil {
		t.Error("expected items array in paginated response")
	}
}

// ── GET /system/ping ──────────────────────────────────────────────────────────

func TestPingServer_ReturnsNoContent(t *testing.T) {
	h := newMetricsAdminHandler(&stubAdminQuerier{}, &stubMetricsService{})

	r := newEngine()
	r.GET("/admin/system/ping", h.PingServer)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/ping", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", w.Code)
	}
	if w.Body.Len() != 0 {
		t.Errorf("expected empty body, got %q", w.Body.String())
	}
}

func TestPingServer_ResponseIsImmediate(t *testing.T) {
	// Verify the ping handler works even when metrics service has no data.
	h := newMetricsAdminHandler(&stubAdminQuerier{}, &stubMetricsService{latestErr: errors.New("no data")})

	r := newEngine()
	r.GET("/admin/system/ping", h.PingServer)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/ping", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204 regardless of metrics state, got %d", w.Code)
	}
}
