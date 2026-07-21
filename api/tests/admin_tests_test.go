package tests

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/admin"
)

// newTestRunnerHandler constructs a Handler with test-runner params only.
func newTestRunnerHandler(apiDir, testRunnerURL string) *admin.Handler {
	return admin.NewHandler(&stubAdminQuerier{}, &stubAdminInviteService{}, nil, nil, nil, nil, nil, "", "", testRunnerURL, apiDir, nil)
}

// reportOf extracts body["report"] as a map, the nested shape RunTests/
// GetLatestTests now return (models.TestRun{..., Report: models.TestRunReport}).
func reportOf(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	report, _ := body["report"].(map[string]any)
	if report == nil {
		t.Fatalf("expected a \"report\" key in response body, got %v", body)
	}
	return report
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
	report := reportOf(t, body)

	be, _ := report["backend"].(map[string]any)
	if be == nil || be["enabled"] != true {
		t.Errorf("expected backend.enabled=true, got %v", be)
	}
	for _, key := range []string{"frontend", "frontend_e2e", "mobile", "recognition"} {
		entry, _ := report[key].(map[string]any)
		if entry == nil {
			t.Fatalf("expected %s key in report", key)
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
			"backend":      map[string]any{"enabled": true, "result": map[string]any{"passed": true, "exit_code": 0, "output": "ok", "duration_ms": 10, "num_tests": 3, "num_passed": 3, "num_failed": 0}},
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
	if body["passed"] != true {
		t.Errorf("expected top-level passed=true, got %v", body["passed"])
	}
	report := reportOf(t, body)

	for _, key := range []string{"backend", "frontend", "frontend_e2e", "mobile", "recognition"} {
		entry, _ := report[key].(map[string]any)
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
	if body["passed"] != false {
		t.Errorf("expected top-level passed=false, got %v", body["passed"])
	}
	report := reportOf(t, body)
	rec, _ := report["recognition"].(map[string]any)
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

// ── Persistence — tags the run with deployment version/git branch ───────────

func TestRunTests_PersistsRunTaggedWithVersionAndBranch(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint
			"backend":      map[string]any{"enabled": true, "result": map[string]any{"passed": true, "exit_code": 0, "output": "ok", "duration_ms": 10}},
			"frontend":     map[string]any{"enabled": false},
			"frontend_e2e": map[string]any{"enabled": false},
			"mobile":       map[string]any{"enabled": false},
			"recognition":  map[string]any{"enabled": false},
		})
	}))
	defer sidecar.Close()

	q := &stubAdminQuerier{}
	h := admin.NewHandler(q, &stubAdminInviteService{}, nil, nil, nil, nil, nil, "", "", sidecar.URL+"/run-tests", "", nil)
	h.SetDeploymentInfo("abc1234", "release-1.2.2")

	r := newEngine()
	r.POST("/admin/system/tests", h.RunTests)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/tests", nil)
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	if len(q.createdTestRuns) != 1 {
		t.Fatalf("expected exactly one persisted test run, got %d", len(q.createdTestRuns))
	}
	saved := q.createdTestRuns[0]
	if saved.DeploymentVersion != "abc1234" || saved.GitBranch != "release-1.2.2" {
		t.Errorf("expected run tagged abc1234/release-1.2.2, got %s/%s", saved.DeploymentVersion, saved.GitBranch)
	}
	if !saved.Passed {
		t.Errorf("expected saved run to be marked passed")
	}
}

// ── GetLatestTests ────────────────────────────────────────────────────────────

func TestGetLatestTests_NoneRecorded(t *testing.T) {
	h := admin.NewHandler(&stubAdminQuerier{}, &stubAdminInviteService{}, nil, nil, nil, nil, nil, "", "", "", "", nil)
	r := newEngine()
	r.GET("/admin/system/tests/latest", h.GetLatestTests)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/tests/latest", nil)
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["run"] != nil {
		t.Errorf("expected run=null when nothing has ever been recorded, got %v", body["run"])
	}
}

func TestGetLatestTests_MatchesCurrentBranch(t *testing.T) {
	branchRun := &models.TestRun{ID: uuid.New(), DeploymentVersion: "cur123", GitBranch: "release-1.2.2", Passed: true, CreatedAt: time.Now()}
	overallRun := &models.TestRun{ID: uuid.New(), DeploymentVersion: "old999", GitBranch: "main", Passed: true, CreatedAt: time.Now().Add(-48 * time.Hour)}

	q := &stubAdminQuerier{
		latestTestRunForBranch: map[string]*models.TestRun{"release-1.2.2": branchRun},
		latestTestRunOverall:   overallRun,
	}
	h := admin.NewHandler(q, &stubAdminInviteService{}, nil, nil, nil, nil, nil, "", "", "", "", nil)
	h.SetDeploymentInfo("cur123", "release-1.2.2")

	r := newEngine()
	r.GET("/admin/system/tests/latest", h.GetLatestTests)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/tests/latest", nil)
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["matched_branch"] != true {
		t.Errorf("expected matched_branch=true, got %v", body["matched_branch"])
	}
	run, _ := body["run"].(map[string]any)
	if run == nil || run["git_branch"] != "release-1.2.2" {
		t.Fatalf("expected the branch-matched run, got %v", run)
	}
}

func TestGetLatestTests_FallsBackToOverallWhenBranchHasNoRun(t *testing.T) {
	overallRun := &models.TestRun{ID: uuid.New(), DeploymentVersion: "old999", GitBranch: "main", Passed: true, CreatedAt: time.Now().Add(-48 * time.Hour)}

	q := &stubAdminQuerier{
		latestTestRunForBranch: map[string]*models.TestRun{}, // nothing for "release-1.2.2"
		latestTestRunOverall:   overallRun,
	}
	h := admin.NewHandler(q, &stubAdminInviteService{}, nil, nil, nil, nil, nil, "", "", "", "", nil)
	h.SetDeploymentInfo("cur123", "release-1.2.2")

	r := newEngine()
	r.GET("/admin/system/tests/latest", h.GetLatestTests)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/tests/latest", nil)
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["matched_branch"] != false {
		t.Errorf("expected matched_branch=false, got %v", body["matched_branch"])
	}
	run, _ := body["run"].(map[string]any)
	if run == nil || run["git_branch"] != "main" {
		t.Fatalf("expected the fallback (overall) run from \"main\", got %v", run)
	}
	if body["current_branch"] != "release-1.2.2" || body["current_version"] != "cur123" {
		t.Errorf("expected current_branch/current_version to reflect this deployment, got %v/%v", body["current_branch"], body["current_version"])
	}
}
