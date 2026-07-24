// Command node-agent is a lightweight per-node metrics collector. It is deployed
// in Docker Swarm "global" mode (one replica per node), reads the local host's
// hardware metrics (CPU, memory, network, drive capacity + temperatures) every
// few seconds, and pushes them to the API's internal ingest endpoint. The API
// aggregates these into the per-node view shown on the admin metrics page.
//
// The manager host runs an agent too, so its hardware arrives the same way as the
// worker's — the metrics page treats every node uniformly.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"apollo-sfs.com/api/models"
)

func main() {
	hostname := envOr("NODE_HOSTNAME", "")
	if hostname == "" {
		if h, err := os.Hostname(); err == nil {
			hostname = h
		}
	}
	ingestURL := envOr("NODE_METRICS_INGEST_URL", "http://node-metrics-ingest:8080")
	token := os.Getenv("NODE_AGENT_TOKEN")
	interval := 5 * time.Second
	if v := os.Getenv("NODE_AGENT_INTERVAL_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			interval = time.Duration(n) * time.Second
		}
	}

	if token == "" {
		log.Fatal("node-agent: NODE_AGENT_TOKEN is required")
	}
	if hostname == "" {
		log.Fatal("node-agent: could not determine hostname (set NODE_HOSTNAME)")
	}

	metricsEndpoint := ingestURL + "/internal/node-metrics"
	benchmarkResultEndpoint := ingestURL + "/internal/node-benchmark-result"
	benchmarkProgressEndpoint := ingestURL + "/internal/node-benchmark-progress"
	// Benchmarks can take several seconds per disk (256 MiB write+fsync+read on
	// a spinning HDD); the shared 10s client timeout is too tight for that leg.
	client := &http.Client{Timeout: 10 * time.Second}
	benchmarkClient := &http.Client{Timeout: 60 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Printf("node-agent: started as %q, pushing to %s every %s", hostname, metricsEndpoint, interval)

	// Prime cpu.Percent so the first pushed sample carries a real utilisation value.
	collectPayload(hostname)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Print("node-agent: shutting down")
			return
		case <-ticker.C:
			runBenchmark, err := push(ctx, client, metricsEndpoint, token, hostname)
			if err != nil {
				log.Printf("node-agent: push: %v", err)
				continue
			}
			if !runBenchmark {
				continue
			}
			// Runs synchronously — node-agent has no inbound listener, so this
			// is the only way an admin-triggered "run now" request reaches the
			// node (see docs/drive_benchmark_setup.md). Delaying this tick's
			// regular metrics push by however long the benchmark takes is an
			// acceptable trade-off for a background collector loop.
			log.Print("node-agent: benchmark requested, running now")
			results := runBenchmarks(func(label, step string) {
				// Fire-and-forget: a dropped progress post just means the
				// admin page's live display lags until the next step (or the
				// final result, which always lands via postBenchmarkResults).
				if err := postBenchmarkProgress(ctx, client, benchmarkProgressEndpoint, token, hostname, label, step); err != nil {
					log.Printf("node-agent: post benchmark progress: %v", err)
				}
			})
			if err := postBenchmarkResults(ctx, benchmarkClient, benchmarkResultEndpoint, token, hostname, results); err != nil {
				log.Printf("node-agent: post benchmark results: %v", err)
			}
		}
	}
}

// push POSTs the current metrics sample and reports whether the ingest
// service asked this node to run a benchmark (set by an admin trigger and
// consumed server-side on this exact push — see ConsumeBenchmarkRequest).
func push(ctx context.Context, client *http.Client, endpoint, token, hostname string) (runBenchmark bool, err error) {
	payload := collectPayload(hostname)
	body, err := json.Marshal(payload)
	if err != nil {
		return false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", token)

	resp, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return false, errStatus(resp.StatusCode)
	}

	var ack struct {
		RunBenchmark bool `json:"run_benchmark"`
	}
	// Older/mismatched ingest builds may not send this field — decode errors
	// are non-fatal, they just mean no benchmark runs this tick.
	_ = json.NewDecoder(resp.Body).Decode(&ack)
	return ack.RunBenchmark, nil
}

// postBenchmarkResults sends every disk's benchmark result back to
// node-metrics-ingest in one call.
func postBenchmarkResults(ctx context.Context, client *http.Client, endpoint, token, hostname string, results []models.BenchmarkResultPayload) error {
	if len(results) == 0 {
		return nil
	}
	payload := models.BenchmarkResultBatch{Hostname: hostname, Results: results}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", token)

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return errStatus(resp.StatusCode)
	}
	return nil
}

// postBenchmarkProgress tells node-metrics-ingest which disk/step is about to
// run, so the admin page's progress bar can show live detail instead of just
// a coarse per-node pending flag. Best-effort — the caller logs and moves on
// if this fails; it never blocks or aborts the benchmark run itself.
func postBenchmarkProgress(ctx context.Context, client *http.Client, endpoint, token, hostname, label, step string) error {
	payload := models.BenchmarkProgressPayload{Hostname: hostname, Label: label, Step: step}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", token)

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return errStatus(resp.StatusCode)
	}
	return nil
}

type statusError int

func (e statusError) Error() string { return "unexpected status " + strconv.Itoa(int(e)) }
func errStatus(code int) error      { return statusError(code) }

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
