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
)

func main() {
	hostname := envOr("NODE_HOSTNAME", "")
	if hostname == "" {
		if h, err := os.Hostname(); err == nil {
			hostname = h
		}
	}
	apiURL := envOr("API_INTERNAL_URL", "http://api:8080")
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

	endpoint := apiURL + "/api/v1/internal/node-metrics"
	client := &http.Client{Timeout: 10 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Printf("node-agent: started as %q, pushing to %s every %s", hostname, endpoint, interval)

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
			if err := push(ctx, client, endpoint, token, hostname); err != nil {
				log.Printf("node-agent: push: %v", err)
			}
		}
	}
}

func push(ctx context.Context, client *http.Client, endpoint, token, hostname string) error {
	payload := collectPayload(hostname)
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
