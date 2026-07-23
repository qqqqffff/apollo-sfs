// Command node-metrics-ingest is the internal ingest endpoint per-node agents
// (cmd/node-agent) push their hardware samples to. It runs as its own Swarm
// service (manager-only) so ingestion traffic and any incidents on it are
// isolated from the public-facing api service. It owns no migrations — the
// api service applies those on its own startup — and holds no in-memory
// state; every push is persisted straight to Postgres, and the api service
// reads it back to serve the live admin metrics view.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/routes/nodeagent"
	"apollo-sfs.com/api/routes/services"
)

func main() {
	port := envOr("PORT", "8080")
	token := os.Getenv("NODE_AGENT_TOKEN")
	if token == "" {
		log.Fatal("node-metrics-ingest: NODE_AGENT_TOKEN is required")
	}

	dsn := fmt.Sprintf(
		"host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		requireEnv("POSTGRES_APP_HOST"),
		envOr("POSTGRES_APP_PORT", "5432"),
		requireEnv("POSTGRES_APP_USER"),
		requireEnv("POSTGRES_APP_PASSWORD"),
		requireEnv("POSTGRES_APP_DB"),
	)

	pool, err := db.Connect(dsn)
	if err != nil {
		log.Fatalf("node-metrics-ingest: database connection failed: %v", err)
	}
	defer pool.Close()

	queries := db.New(pool)
	ingestSvc := services.NewNodeIngestService(queries)
	handler := nodeagent.NewHandler(ingestSvc, token)

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Logger())
	r.Use(gin.Recovery())
	r.GET("/healthz", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.POST("/internal/node-metrics", handler.IngestNodeMetrics)
	r.POST("/internal/node-benchmark-result", handler.IngestBenchmarkResult)

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("node-metrics-ingest: listening on :%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("node-metrics-ingest: server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("node-metrics-ingest: shutting down…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("node-metrics-ingest: graceful shutdown error: %v", err)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func requireEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("node-metrics-ingest: required environment variable %q is not set", key)
	}
	return v
}
