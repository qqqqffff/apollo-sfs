// test-server is a minimal HTTP sidecar that runs the Go test suite on demand.
//
// Endpoints:
//
//	POST /run-tests — runs `go test ./tests/... -count=1` and returns JSON
//	GET  /health    — liveness probe
//
// Only one run executes at a time; concurrent requests receive 503.
// Never exposed outside the Docker bridge network.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"sync/atomic"
	"time"
)

type suiteResult struct {
	Passed     bool   `json:"passed"`
	ExitCode   int    `json:"exit_code"`
	Output     string `json:"output"`
	DurationMs int64  `json:"duration_ms"`
}

var running atomic.Bool

func main() {
	port := os.Getenv("TEST_SERVER_PORT")
	if port == "" {
		port = "9228"
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "running": running.Load()})
	})

	mux.HandleFunc("POST /run-tests", func(w http.ResponseWriter, r *http.Request) {
		if !running.CompareAndSwap(false, true) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "a test run is already in progress"})
			return
		}
		defer running.Store(false)

		start := time.Now()
		cmd := exec.CommandContext(r.Context(), "go", "test", "./tests/...", "-count=1")
		cmd.Dir = "/app"
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

		writeJSON(w, http.StatusOK, suiteResult{
			Passed:     exitCode == 0,
			ExitCode:   exitCode,
			Output:     string(out),
			DurationMs: elapsed,
		})
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	})

	fmt.Printf("Test runner listening on :%s\n", port)
	if err := http.ListenAndServe("0.0.0.0:"+port, mux); err != nil {
		fmt.Fprintf(os.Stderr, "server error: %v\n", err)
		os.Exit(1)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	b, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}
