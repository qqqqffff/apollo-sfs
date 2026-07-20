package admin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"time"

	"github.com/gin-gonic/gin"
)

// suiteResult holds the outcome of one test run — shared by every suite.
type suiteResult struct {
	Passed     bool   `json:"passed"`
	ExitCode   int    `json:"exit_code"`
	Output     string `json:"output"`
	DurationMs int64  `json:"duration_ms"`
}

// suiteEntry is always present in the response.
// When Enabled=false the suite was not configured; Result is nil and Message explains why.
// When Enabled=true, Result carries the actual test outcome.
type suiteEntry struct {
	Enabled bool         `json:"enabled"`
	Result  *suiteResult `json:"result,omitempty"`
	Message string       `json:"message,omitempty"`
}

type testRunResponse struct {
	Backend     suiteEntry `json:"backend"`
	Frontend    suiteEntry `json:"frontend"`
	FrontendE2E suiteEntry `json:"frontend_e2e"`
	Mobile      suiteEntry `json:"mobile"`
	Recognition suiteEntry `json:"recognition"`
}

// runnerTimeout bounds the call to the unified test-runner sidecar. All five
// suites run sequentially inside it (Go, Jest ×2, Playwright, pytest), so this
// needs to be generous rather than the ~2min a single suite used to get.
const runnerTimeout = 10 * time.Minute

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
// Returns 503 when no suite is configured.
// Returns 422 when at least one enabled suite fails.
// Returns 200 when all enabled suites pass.
func (h *Handler) RunTests(c *gin.Context) {
	var resp testRunResponse

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

	anyEnabled := resp.Backend.Enabled || resp.Frontend.Enabled || resp.FrontendE2E.Enabled ||
		resp.Mobile.Enabled || resp.Recognition.Enabled
	if !anyEnabled {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "no test suites are configured (set TEST_RUNNER_URL and/or APP_DIR)",
		})
		return
	}

	anyFailed := (resp.Backend.Enabled && resp.Backend.Result != nil && !resp.Backend.Result.Passed) ||
		(resp.Frontend.Enabled && resp.Frontend.Result != nil && !resp.Frontend.Result.Passed) ||
		(resp.FrontendE2E.Enabled && resp.FrontendE2E.Result != nil && !resp.FrontendE2E.Result.Passed) ||
		(resp.Mobile.Enabled && resp.Mobile.Result != nil && !resp.Mobile.Result.Passed) ||
		(resp.Recognition.Enabled && resp.Recognition.Result != nil && !resp.Recognition.Result.Passed)

	status := http.StatusOK
	if anyFailed {
		status = http.StatusUnprocessableEntity
	}
	c.JSON(status, resp)
}

// callTestRunner posts to the unified test-runner sidecar and unmarshals its
// combined report directly into a testRunResponse — the sidecar's JSON shape
// mirrors this struct exactly, so no per-suite translation is needed.
func (h *Handler) callTestRunner(parent context.Context) (*testRunResponse, error) {
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

	var result testRunResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("parse test runner response: %w\n%s", err, body)
	}

	return &result, nil
}

// runBackendLocal runs the Go test suite via direct exec in apiDir — the
// local-dev fallback used only when testRunnerURL is unset.
func (h *Handler) runBackendLocal(parent context.Context) suiteEntry {
	if h.apiDir == "" {
		return suiteEntry{
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

	return suiteEntry{
		Enabled: true,
		Result: &suiteResult{
			Passed:     exitCode == 0,
			ExitCode:   exitCode,
			Output:     string(out),
			DurationMs: elapsed,
		},
	}
}
