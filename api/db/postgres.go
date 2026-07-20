package db

import (
	"database/sql"
	"fmt"
	"log"
	"time"

	_ "github.com/lib/pq"
)

// Connect opens a PostgreSQL connection pool using lib/pq and verifies
// reachability with a ping. The caller is responsible for calling Close()
// when the pool is no longer needed.
//
// Pool sizing is conservative for a Raspberry Pi deployment:
//   - 25 max open connections
//   - 5 max idle connections
//   - 5-minute max connection lifetime (avoids stale connections after network blips)
//   - 1-minute max idle time (reclaims connections not actively needed)
func Connect(url string) (*sql.DB, error) {
	pool, err := sql.Open("postgres", url)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}

	pool.SetMaxOpenConns(25)
	pool.SetMaxIdleConns(5)
	pool.SetConnMaxLifetime(5 * time.Minute)
	pool.SetConnMaxIdleTime(1 * time.Minute)

	// A Swarm stop-first rolling update starts this container in a fresh
	// network sandbox: the embedded DNS resolver (127.0.0.11) can take a few
	// seconds to learn the db-app service VIP, so the first ping(s) right
	// after boot can fail with "no such host" even though db-app is up.
	// Retry with backoff rather than failing the whole process over a blip
	// that clears itself within a few seconds — an unconditional log.Fatalf
	// on the caller side would otherwise crash the task and can trigger an
	// automatic rollback of an otherwise-good deploy.
	const (
		pingAttempts = 10
		pingBackoff  = 2 * time.Second
	)
	for attempt := 1; ; attempt++ {
		if err = pool.Ping(); err == nil {
			break
		}
		if attempt == pingAttempts {
			pool.Close()
			return nil, fmt.Errorf("ping postgres (after %d attempts): %w", pingAttempts, err)
		}
		log.Printf("db: ping attempt %d/%d failed, retrying in %s: %v", attempt, pingAttempts, pingBackoff, err)
		time.Sleep(pingBackoff)
	}

	return pool, nil
}
