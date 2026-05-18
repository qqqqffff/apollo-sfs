package tests

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"apollo-sfs.com/api/routes/admin"
)

// newShutdownHandler constructs a Handler wired with the given shutdown channel.
func newShutdownHandler(ch chan struct{}) *admin.Handler {
	return admin.NewHandler(&stubAdminQuerier{}, &stubAdminInviteService{}, nil, nil, nil, nil, "", "", ch)
}

// isClosed returns true if ch is already closed (non-blocking).
func isClosed(ch chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// ── Kill switch not configured ────────────────────────────────────────────────

func TestShutdown_NotConfigured(t *testing.T) {
	h := newShutdownHandler(nil)
	r := newEngine()
	r.POST("/admin/system/shutdown", h.Shutdown)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/shutdown", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotImplemented {
		t.Fatalf("expected 501 when shutdownCh is nil, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── Kill switch triggers and closes the channel ───────────────────────────────

func TestShutdown_ClosesChannel(t *testing.T) {
	ch := make(chan struct{})
	h := newShutdownHandler(ch)
	r := newEngine()
	r.POST("/admin/system/shutdown", h.Shutdown)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/shutdown", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	if !isClosed(ch) {
		t.Fatal("expected shutdownCh to be closed after handler returns")
	}
}

// ── Second call is a no-op — channel is not double-closed ────────────────────

func TestShutdown_IdempotentNoPanic(t *testing.T) {
	ch := make(chan struct{})
	h := newShutdownHandler(ch)
	r := newEngine()
	r.POST("/admin/system/shutdown", h.Shutdown)

	for range 2 {
		req := httptest.NewRequest(http.MethodPost, "/admin/system/shutdown", nil)
		// If sync.Once is broken this panics (closing a closed channel).
		doRequest(r, req)
	}

	if !isClosed(ch) {
		t.Fatal("expected shutdownCh to be closed")
	}
}
