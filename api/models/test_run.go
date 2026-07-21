package models

import (
	"time"

	"github.com/google/uuid"
)

// TestCase is one individual test's outcome within a suite, as reported by
// each toolchain's structured/JSON output (go test -json, jest --json,
// playwright --reporter=json, pytest --json-report). Suites whose output
// couldn't be parsed into individual cases (or that don't support it) report
// no Tests and are rendered as suite-level only on the admin metrics page.
type TestCase struct {
	Name       string `json:"name"`
	Passed     bool   `json:"passed"`
	DurationMs int64  `json:"duration_ms,omitempty"`
	// Message carries the failure output for a failed test; empty for passing tests.
	Message string `json:"message,omitempty"`
}

// CoverageStat is a suite's line/branch coverage percentage, when the
// toolchain reports it (Go/Jest/pytest via their coverage tooling).
// Playwright E2E has no meaningful coverage concept, so its entry omits this.
type CoverageStat struct {
	LinesPct    *float64 `json:"lines_pct,omitempty"`
	BranchesPct *float64 `json:"branches_pct,omitempty"`
}

// SuiteResult holds the outcome of one test run — shared by every suite.
type SuiteResult struct {
	Passed     bool   `json:"passed"`
	ExitCode   int    `json:"exit_code"`
	Output     string `json:"output"`
	DurationMs int64  `json:"duration_ms"`

	// NumTests/NumPassed/NumFailed are derived from Tests when available, or
	// parsed from the toolchain's summary output as a fallback.
	NumTests  int `json:"num_tests"`
	NumPassed int `json:"num_passed"`
	NumFailed int `json:"num_failed"`

	// Tests is the individual per-test breakdown, when the runner sidecar
	// could parse one. Omitted (nil) when only an aggregate count is available.
	Tests []TestCase `json:"tests,omitempty"`

	// Coverage is nil when the suite doesn't report coverage (e.g. Playwright E2E).
	Coverage *CoverageStat `json:"coverage,omitempty"`
}

// SuiteEntry is always present in the response.
// When Enabled=false the suite was not configured; Result is nil and Message explains why.
// When Enabled=true, Result carries the actual test outcome.
type SuiteEntry struct {
	Enabled bool         `json:"enabled"`
	Result  *SuiteResult `json:"result,omitempty"`
	Message string       `json:"message,omitempty"`
}

// TestRunReport is the combined report returned by the unified test-runner
// sidecar (test-runner/server.js) and proxied by the Go API. The frontend
// groups these five suites into four application areas — Frontend (Frontend +
// FrontendE2E), API (Backend), Recognition, and Mobile — for the admin
// metrics page's test-runner card.
type TestRunReport struct {
	Backend     SuiteEntry `json:"backend"`
	Frontend    SuiteEntry `json:"frontend"`
	FrontendE2E SuiteEntry `json:"frontend_e2e"`
	Mobile      SuiteEntry `json:"mobile"`
	Recognition SuiteEntry `json:"recognition"`
}

// AnyEnabled reports whether at least one suite ran (as opposed to every
// suite being disabled/unconfigured).
func (r TestRunReport) AnyEnabled() bool {
	return r.Backend.Enabled || r.Frontend.Enabled || r.FrontendE2E.Enabled ||
		r.Mobile.Enabled || r.Recognition.Enabled
}

// AnyFailed reports whether any enabled suite with a result failed.
func (r TestRunReport) AnyFailed() bool {
	entries := []SuiteEntry{r.Backend, r.Frontend, r.FrontendE2E, r.Mobile, r.Recognition}
	for _, e := range entries {
		if e.Enabled && e.Result != nil && !e.Result.Passed {
			return true
		}
	}
	return false
}

// TestRun is a persisted run of TestRunReport (test_runs table), tagged with
// the deployment version/git branch the api process was built from when the
// run was triggered — see AppVersion/AppGitBranch in api/cmd/config.go.
type TestRun struct {
	ID                uuid.UUID     `json:"id"`
	DeploymentVersion string        `json:"deployment_version"`
	GitBranch         string        `json:"git_branch"`
	Report            TestRunReport `json:"report"`
	Passed            bool          `json:"passed"`
	CreatedAt         time.Time     `json:"created_at"`
}
