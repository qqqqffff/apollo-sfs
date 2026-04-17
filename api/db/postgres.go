package db

import (
	"database/sql"
	"fmt"
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

	if err := pool.Ping(); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}

	return pool, nil
}
