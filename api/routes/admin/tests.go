package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/models"
)

// runnerTimeout bounds the call to the unified test-runner sidecar. All five
// suites run sequentially inside it (Go, Jest ×2, Playwright, pytest), each
// individually capped at a 5-minute timeout inside the sidecar (server.js's
// SUITE_TIMEOUT_MS — a hung suite is killed and reported as a failure rather
// than blocking forever), so this needs to comfortably cover the worst case
// of every suite timing out back to back (5 × 5min) plus normal overhead.
const runnerTimeout = 30 * time.Minute

// progressTimeout bounds the lightweight GET /progress poll — this should
// always be near-instant (it just reads in-memory state), so a short timeout
// is enough to fail fast if the sidecar is unreachable mid-run.
const progressTimeout = 10 * time.Second

// progressURL derives the sidecar's progress-poll endpoint from its
// /run-tests URL (e.g. "http://test-runner:9228/run-tests" ->
// "http://test-runner:9228/progress") rather than a second config value —
// they always live on the same host.
func progressURL(testRunnerURL string) string {
	return strings.TrimSuffix(testRunnerURL, "/run-tests") + "/progress"
}

// latestTestRunResponse is the body of GET /admin/system/tests/latest.
// Run is nil when no test run has ever been recorded. When Run is non-nil but
// MatchedBranch is false, Run is the most recent run from ANY branch (there is
// none yet for CurrentBranch) — the frontend renders a fallback note using
// Run.GitBranch/Run.DeploymentVersion vs. CurrentBranch/CurrentVersion, and a
// staleness note from Run.CreatedAt, rather than the API prose-generating them.
type latestTestRunResponse struct {
	Run            *models.TestRun `json:"run"`
	MatchedBranch  bool            `json:"matched_branch"`
	CurrentBranch  string          `json:"current_branch"`
	CurrentVersion string          `json:"current_version"`
}

// GetLatestTests handles GET /admin/system/tests/latest.
//
// Backs the admin metrics page's test-runner card on load: rather than
// re-running the full cross-service suite (which takes minutes) every time
// the page is opened, the card shows the cached result of the most recent
// POST /admin/system/tests run for the currently-deployed git branch. If the
// current branch has no run of its own yet, it falls back to the most recent
// run from any branch (MatchedBranch=false) so the card has something to show
// instead of looking broken; if no run has ever been recorded, Run is nil.
func (h *Handler) GetLatestTests(c *gin.Context) {
	ctx := c.Request.Context()

	run, err := h.queries.GetLatestTestRunForBranch(ctx, h.appGitBranch)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load latest test run"})
		return
	}
	matchedBranch := run != nil

	if run == nil {
		run, err = h.queries.GetLatestTestRun(ctx)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load latest test run"})
			return
		}
	}

	c.JSON(http.StatusOK, latestTestRunResponse{
		Run:            run,
		MatchedBranch:  matchedBranch,
		CurrentBranch:  h.appGitBranch,
		CurrentVersion: h.appVersion,
	})
}

// testProgressResponse is the body of GET /admin/system/tests/progress —
// proxied directly from the sidecar's GET /progress. Completed is keyed by
// suite name ("backend", "frontend", ...) and only contains suites that have
// finished so far; CurrentSuite names whichever one is running right now (or
// is empty when nothing is running).
type testProgressResponse struct {
	Running      bool                         `json:"running"`
	CurrentSuite string                       `json:"current_suite,omitempty"`
	Order        []string                     `json:"order,omitempty"`
	Completed    map[string]models.SuiteEntry `json:"completed"`
}

// GetTestProgress handles GET /admin/system/tests/progress.
//
// Lets the admin metrics page's test-runner card poll for live status while a
// POST /admin/system/tests run is in flight (the full cross-service suite can
// take minutes), showing which suite is currently running and the results of
// whichever suites have already finished instead of a static "Running…"
// message. When testRunnerURL is unset (local-exec fallback, which runs the
// single backend suite synchronously with no progress tracking of its own),
// this simply reports nothing in progress rather than erroring.
func (h *Handler) GetTestProgress(c *gin.Context) {
	if h.testRunnerURL == "" {
		c.JSON(http.StatusOK, testProgressResponse{Completed: map[string]models.SuiteEntry{}})
		return
	}

	progress, err := h.callTestRunnerProgress(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, progress)
}

// callTestRunnerProgress fetches the sidecar's live run status.
func (h *Handler) callTestRunnerProgress(parent context.Context) (*testProgressResponse, error) {
	ctx, cancel := context.WithTimeout(parent, progressTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, progressURL(h.testRunnerURL), nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call test runner: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	var result testProgressResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parse test runner progress response: %w\n%s", err, body)
	}
	return &result, nil
}

// RunTests handles POST /admin/system/tests.
//
// Normal path — testRunnerURL is set: makes ONE call to the unified
// test-runner sidecar (POST /run-tests), which runs the backend, frontend,
// frontend E2E, mobile, and recognition suites in turn inside a single
// container and returns a combined report. That container replaces separate
// api-tests/frontend-tests/mobile-tests/recognition-tests sidecars — because
// the frontend/mobile/recognition apps live in a separate container from the
// API, they can't be exec'd directly, so the sidecar bridges the gap for all
// four (the backend suite doesn't strictly need it, see below).
//
// Fallback path — testRunnerURL is unset: runs ONLY the backend suite via
// direct exec in apiDir (requires the Go toolchain in PATH and the source
// tree present — dev / source-based deployments only). The other four
// suites can't run without the sidecar's toolchains, so they report disabled.
//
// Every run that produces at least one enabled suite is persisted (tagged
// with this process's deployment version/git branch — see SetDeploymentInfo)
// so GetLatestTests can serve it back without re-running. A persistence
// failure is logged but doesn't fail the request — the run itself already
// happened and its result is what the caller asked for.
//
// Returns 503 when no suite is configured.
// Returns 422 when at least one enabled suite fails.
// Returns 200 when all enabled suites pass.
func (h *Handler) RunTests(c *gin.Context) {
	var resp models.TestRunReport

	if h.testRunnerURL != "" {
		result, err := h.callTestRunner(c.Request.Context())
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		resp = *result
	} else {
		resp.Backend = h.runBackendLocal(c.Request.Context())
	}

	if !resp.AnyEnabled() {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "no test suites are configured (set TEST_RUNNER_URL and/or APP_DIR)",
		})
		return
	}

	anyFailed := resp.AnyFailed()
	run, err := h.queries.CreateTestRun(c.Request.Context(), h.appVersion, h.appGitBranch, resp, !anyFailed)
	if err != nil {
		log.Printf("admin: failed to persist test run: %v", err)
		run = &models.TestRun{
			DeploymentVersion: h.appVersion,
			GitBranch:         h.appGitBranch,
			Report:            resp,
			Passed:            !anyFailed,
			CreatedAt:         time.Now(),
		}
	}

	status := http.StatusOK
	if anyFailed {
		status = http.StatusUnprocessableEntity
	}
	c.JSON(status, run)
}

// callTestRunner posts to the unified test-runner sidecar and unmarshals its
// combined report directly into a models.TestRunReport — the sidecar's JSON
// shape mirrors this struct exactly, so no per-suite translation is needed.
func (h *Handler) callTestRunner(parent context.Context) (*models.TestRunReport, error) {
	ctx, cancel := context.WithTimeout(parent, runnerTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.testRunnerURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call test runner: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	var result models.TestRunReport
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parse test runner response: %w\n%s", err, body)
	}

	return &result, nil
}

// runBackendLocal runs the Go test suite via direct exec in apiDir — the
// local-dev fallback used only when testRunnerURL is unset. It has no access
// to the unified sidecar's structured JSON/coverage tooling, so it reports
// only the aggregate pass/fail — no per-test breakdown or coverage.
func (h *Handler) runBackendLocal(parent context.Context) models.SuiteEntry {
	if h.apiDir == "" {
		return models.SuiteEntry{
			Enabled: false,
			Message: "backend tests disabled — TEST_RUNNER_URL and APP_DIR are not set",
		}
	}

	ctx, cancel := context.WithTimeout(parent, 120*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "go", "test", "./tests/...", "-count=1")
	cmd.Dir = h.apiDir

	start := time.Now()
	out, err := cmd.CombinedOutput()
	elapsed := time.Since(start).Milliseconds()

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
	}

	return models.SuiteEntry{
		Enabled: true,
		Result: &models.SuiteResult{
			Passed:     exitCode == 0,
			ExitCode:   exitCode,
			Output:     string(out),
			DurationMs: elapsed,
		},
	}
}
