package tests

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"apollo-sfs.com/api/routes/nodeagent"
)

// newNodeAgentEngine wires the ingest endpoint with the given shared token.
// metricsSvc is nil: the auth/validation tests below never reach the service.
func newNodeAgentEngine(token string) http.Handler {
	h := nodeagent.NewHandler(nil, token)
	r := newEngine()
	r.POST("/api/v1/internal/node-metrics", h.IngestNodeMetrics)
	return r
}

func postNodeMetrics(r http.Handler, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/internal/node-metrics", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("X-Internal-Token", token)
	}
	return doRequest(r, req)
}

func TestIngestNodeMetrics_RejectsMissingToken(t *testing.T) {
	r := newNodeAgentEngine("secret")
	w := postNodeMetrics(r, "", `{"hostname":"node-1"}`)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestIngestNodeMetrics_RejectsWrongToken(t *testing.T) {
	r := newNodeAgentEngine("secret")
	w := postNodeMetrics(r, "nope", `{"hostname":"node-1"}`)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestIngestNodeMetrics_FailsClosedWhenTokenUnset(t *testing.T) {
	// An empty configured token must reject every request (ingest disabled).
	r := newNodeAgentEngine("")
	w := postNodeMetrics(r, "", `{"hostname":"node-1"}`)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestIngestNodeMetrics_RejectsEmptyHostname(t *testing.T) {
	r := newNodeAgentEngine("secret")
	w := postNodeMetrics(r, "secret", `{"hostname":""}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestIngestNodeMetrics_RejectsMalformedJSON(t *testing.T) {
	r := newNodeAgentEngine("secret")
	w := postNodeMetrics(r, "secret", `not-json{{`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}
