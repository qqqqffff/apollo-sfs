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

// suiteResult holds the outcome of one test run — shared by backend and frontend.
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
}

// RunTests handles POST /admin/system/tests.
//
// Backend suite      — runs `go test ./tests/... -count=1` in apiDir.
//   Requires the Go toolchain to be available in PATH and the source tree to
//   be present (dev / source-based deployments only).
//
// Frontend suite     — calls the Jest sidecar at frontendTestURL (POST /run-tests).
// Frontend E2E suite — calls the Playwright sidecar at frontendE2EURL (POST /run-e2e).
//   Both sidecars run inside the frontend-tests Docker container on the internal
//   bridge network. Because the React app lives in a separate container it cannot
//   be exec'd directly — the sidecar bridges the gap.
//
// Returns 503 when no suite is configured.
// Returns 422 when at least one enabled suite fails.
// Returns 200 when all enabled suites pass.
func (h *Handler) RunTests(c *gin.Context) {
	resp := testRunResponse{
		Backend:     h.runBackend(c.Request.Context()),
		Frontend:    h.runFrontend(c.Request.Context()),
		FrontendE2E: h.runFrontendE2E(c.Request.Context()),
	}

	if !resp.Backend.Enabled && !resp.Frontend.Enabled && !resp.FrontendE2E.Enabled {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "no test suites are configured (set APP_DIR and/or FRONTEND_TEST_URL and/or FRONTEND_E2E_URL)",
		})
		return
	}

	anyFailed := (resp.Backend.Enabled && resp.Backend.Result != nil && !resp.Backend.Result.Passed) ||
		(resp.Frontend.Enabled && resp.Frontend.Result != nil && !resp.Frontend.Result.Passed) ||
		(resp.FrontendE2E.Enabled && resp.FrontendE2E.Result != nil && !resp.FrontendE2E.Result.Passed)

	status := http.StatusOK
	if anyFailed {
		status = http.StatusUnprocessableEntity
	}
	c.JSON(status, resp)
}

// runBackend executes the Go test suite and returns its entry.
func (h *Handler) runBackend(parent context.Context) suiteEntry {
	if h.apiDir == "" {
		return suiteEntry{
			Enabled: false,
			Message: "backend tests disabled — APP_DIR is not set",
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

// runFrontend calls the Jest sidecar container and returns its entry.
func (h *Handler) runFrontend(parent context.Context) suiteEntry {
	return h.callSidecar(parent, h.frontendTestURL, "frontend tests disabled — FRONTEND_TEST_URL is not set")
}

// runFrontendE2E calls the Playwright sidecar container and returns its entry.
func (h *Handler) runFrontendE2E(parent context.Context) suiteEntry {
	return h.callSidecar(parent, h.frontendE2EURL, "frontend E2E tests disabled — FRONTEND_E2E_URL is not set")
}

// callSidecar posts to url and unmarshals the suiteResult response.
// Returns a disabled entry when url is empty.
func (h *Handler) callSidecar(parent context.Context, url, disabledMsg string) suiteEntry {
	if url == "" {
		return suiteEntry{Enabled: false, Message: disabledMsg}
	}

	ctx, cancel := context.WithTimeout(parent, 120*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return suiteEntry{Enabled: true, Result: errorResult(fmt.Sprintf("build request: %v", err))}
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return suiteEntry{Enabled: true, Result: errorResult(fmt.Sprintf("call sidecar: %v", err))}
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	var result suiteResult
	if err := json.Unmarshal(body, &result); err != nil {
		return suiteEntry{
			Enabled: true,
			Result:  errorResult(fmt.Sprintf("parse sidecar response: %v\n%s", err, body)),
		}
	}

	return suiteEntry{Enabled: true, Result: &result}
}

func errorResult(msg string) *suiteResult {
	return &suiteResult{Passed: false, ExitCode: -1, Output: msg}
}
