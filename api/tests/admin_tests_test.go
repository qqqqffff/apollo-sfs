package tests

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"apollo-sfs.com/api/routes/admin"
)

// newTestRunnerHandler constructs a Handler with test-runner params only.
func newTestRunnerHandler(apiDir, testRunnerURL string) *admin.Handler {
	return admin.NewHandler(&stubAdminQuerier{}, &stubAdminInviteService{}, nil, nil, nil, nil, nil, "", "", testRunnerURL, apiDir, nil)
}

// ── Neither suite configured ──────────────────────────────────────────────────

func TestRunTests_NeitherConfigured(t *testing.T) {
	h := newTestRunnerHandler("", "")
	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when nothing is configured, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── Backend local-exec fallback (no test-runner sidecar) ─────────────────────

func TestRunTests_BackendLocalFallback_DisabledWhenDirNotSet(t *testing.T) {
	h := newTestRunnerHandler("", "")
	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestRunTests_BackendLocalFallback_OnlyBackendEnabled(t *testing.T) {
	// Invalid dir so the command fails fast, but the entry should still be
	// enabled=true (it was attempted) — every other suite is disabled since
	// there's no test-runner sidecar to reach them through.
	h := newTestRunnerHandler("/nonexistent-dir", "")
	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 when the backend suite fails, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint

	be, _ := body["backend"].(map[string]any)
	if be == nil || be["enabled"] != true {
		t.Errorf("expected backend.enabled=true, got %v", be)
	}
	for _, key := range []string{"frontend", "frontend_e2e", "mobile", "recognition"} {
		entry, _ := body[key].(map[string]any)
		if entry == nil {
			t.Fatalf("expected %s key in response", key)
		}
		if entry["enabled"] != false {
			t.Errorf("expected %s.enabled=false without a test-runner sidecar, got %v", key, entry["enabled"])
		}
	}
}

// ── Unified test-runner sidecar — passing report ─────────────────────────────

func TestRunTests_TestRunner_AllPass(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint
			"backend":      map[string]any{"enabled": true, "result": map[string]any{"passed": true, "exit_code": 0, "output": "ok", "duration_ms": 10}},
			"frontend":     map[string]any{"enabled": true, "result": map[string]any{"passed": true, "exit_code": 0, "output": "ok", "duration_ms": 20}},
			"frontend_e2e": map[string]any{"enabled": true, "result": map[string]any{"passed": true, "exit_code": 0, "output": "ok", "duration_ms": 30}},
			"mobile":       map[string]any{"enabled": true, "result": map[string]any{"passed": true, "exit_code": 0, "output": "ok", "duration_ms": 40}},
			"recognition":  map[string]any{"enabled": true, "result": map[string]any{"passed": true, "exit_code": 0, "output": "ok", "duration_ms": 50}},
		})
	}))
	defer sidecar.Close()

	h := newTestRunnerHandler("", sidecar.URL+"/run-tests")
	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 when every suite passes, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint

	for _, key := range []string{"backend", "frontend", "frontend_e2e", "mobile", "recognition"} {
		entry, _ := body[key].(map[string]any)
		if entry == nil || entry["enabled"] != true {
			t.Fatalf("expected %s.enabled=true, got %v", key, entry)
		}
		result, _ := entry["result"].(map[string]any)
		if result == nil || result["passed"] != true {
			t.Errorf("expected %s.result.passed=true, got %v", key, result)
		}
	}
}

// ── Unified test-runner sidecar — one suite fails ────────────────────────────

func TestRunTests_TestRunner_OneSuiteFails(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint
			"backend":      map[string]any{"enabled": true, "result": map[string]any{"passed": true, "exit_code": 0, "output": "ok", "duration_ms": 10}},
			"frontend":     map[string]any{"enabled": true, "result": map[string]any{"passed": true, "exit_code": 0, "output": "ok", "duration_ms": 20}},
			"frontend_e2e": map[string]any{"enabled": true, "result": map[string]any{"passed": true, "exit_code": 0, "output": "ok", "duration_ms": 30}},
			"mobile":       map[string]any{"enabled": true, "result": map[string]any{"passed": true, "exit_code": 0, "output": "ok", "duration_ms": 40}},
			"recognition": map[string]any{"enabled": true, "result": map[string]any{
				"passed": false, "exit_code": 1, "output": "FAIL tests/test_analyze.py", "duration_ms": 50,
			}},
		})
	}))
	defer sidecar.Close()

	h := newTestRunnerHandler("", sidecar.URL+"/run-tests")
	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 when one suite fails, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	rec, _ := body["recognition"].(map[string]any)
	result, _ := rec["result"].(map[string]any)
	if result["passed"] != false {
		t.Errorf("expected recognition.result.passed=false, got %v", result["passed"])
	}
}

// ── Unified test-runner sidecar — unreachable ────────────────────────────────

func TestRunTests_TestRunner_Unreachable(t *testing.T) {
	// Port 19228 is very unlikely to be listening. Unlike a single-suite
	// sidecar, an unreachable unified runner means NO suite results come
	// back at all, so this is a hard error rather than a per-suite failure.
	h := newTestRunnerHandler("", "http://127.0.0.1:19228/run-tests")
	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("expected 502 when the test-runner sidecar is unreachable, got %d (body: %s)", w.Code, w.Body.String())
	}
}
