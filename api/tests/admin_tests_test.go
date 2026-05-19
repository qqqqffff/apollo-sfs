package tests

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"apollo-sfs.com/api/routes/admin"
)

// newTestRunnerHandler constructs a Handler with test-runner params only.
func newTestRunnerHandler(apiDir, frontendTestURL, frontendE2EURL string) *admin.Handler {
	return admin.NewHandler(&stubAdminQuerier{}, &stubAdminInviteService{}, nil, nil, nil, nil, "", apiDir, frontendTestURL, frontendE2EURL, nil)
}

// ── Neither suite configured ──────────────────────────────────────────────────

func TestRunTests_NeitherConfigured(t *testing.T) {
	h := newTestRunnerHandler("", "", "")
	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when nothing is configured, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── Frontend disabled when URL not set ───────────────────────────────────────

func TestRunTests_FrontendDisabledWhenURLNotSet(t *testing.T) {
	// Provide a fake apiDir so the backend entry is attempted (it will fail
	// because the dir is invalid, but that's fine — we only check the frontend
	// entry here).
	h := newTestRunnerHandler("/nonexistent-dir", "", "")
	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)

	var body map[string]any
	decodeBody(w, &body) //nolint

	fe, _ := body["frontend"].(map[string]any)
	if fe == nil {
		t.Fatal("expected frontend key in response")
	}
	if fe["enabled"] != false {
		t.Errorf("expected frontend.enabled=false when FRONTEND_TEST_URL is unset, got %v", fe["enabled"])
	}
	if fe["message"] == nil || fe["message"] == "" {
		t.Error("expected frontend.message to be set")
	}
}

// ── Backend disabled when apiDir not set ─────────────────────────────────────

func TestRunTests_BackendDisabledWhenDirNotSet(t *testing.T) {
	// Provide a sidecar stub so the endpoint returns a real response instead of 503.
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint
			"passed": true, "exit_code": 0, "output": "PASS", "duration_ms": 10,
		})
	}))
	defer sidecar.Close()

	h := newTestRunnerHandler("", sidecar.URL+"/run-tests", "")
	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)

	var body map[string]any
	decodeBody(w, &body) //nolint

	be, _ := body["backend"].(map[string]any)
	if be == nil {
		t.Fatal("expected backend key in response")
	}
	if be["enabled"] != false {
		t.Errorf("expected backend.enabled=false when APP_DIR is unset, got %v", be["enabled"])
	}
}

// ── Frontend sidecar — passing suite ─────────────────────────────────────────

func TestRunTests_FrontendSidecar_Pass(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint
			"passed":      true,
			"exit_code":   0,
			"output":      "PASS\nTest Suites: 0 passed, 0 total",
			"duration_ms": 312,
		})
	}))
	defer sidecar.Close()

	h := newTestRunnerHandler("", sidecar.URL+"/run-tests", "")
	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 when frontend passes, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint

	fe, _ := body["frontend"].(map[string]any)
	if fe["enabled"] != true {
		t.Errorf("expected frontend.enabled=true")
	}
	result, _ := fe["result"].(map[string]any)
	if result == nil {
		t.Fatal("expected frontend.result to be present")
	}
	if result["passed"] != true {
		t.Errorf("expected frontend.result.passed=true, got %v", result["passed"])
	}
}

// ── Frontend sidecar — failing suite ─────────────────────────────────────────

func TestRunTests_FrontendSidecar_Fail(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint
			"passed":      false,
			"exit_code":   1,
			"output":      "FAIL\n● MyComponent › renders correctly",
			"duration_ms": 890,
		})
	}))
	defer sidecar.Close()

	h := newTestRunnerHandler("", sidecar.URL+"/run-tests", "")
	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 when frontend fails, got %d", w.Code)
	}
}

// ── Frontend sidecar — unreachable ───────────────────────────────────────────

func TestRunTests_FrontendSidecar_Unreachable(t *testing.T) {
	// Port 19229 is very unlikely to be listening.
	h := newTestRunnerHandler("", "http://127.0.0.1:19229/run-tests", "")
	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)

	// Sidecar unreachable → frontend result is a network error, treated as failure.
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 when sidecar is unreachable, got %d", w.Code)
	}

	var body map[string]any
	decodeBody(w, &body) //nolint

	fe, _ := body["frontend"].(map[string]any)
	if fe["enabled"] != true {
		t.Errorf("expected frontend.enabled=true even when sidecar is unreachable")
	}
	result, _ := fe["result"].(map[string]any)
	if result["passed"] != false {
		t.Errorf("expected frontend.result.passed=false for unreachable sidecar")
	}
}
