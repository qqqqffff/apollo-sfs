package db

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
)

const (
	DefaultPageLimit = 50
	MaxPageLimit     = 128
)

// PageInput is passed to every paginated list query.
// Cursor is the opaque token returned by the previous call; leave empty for the first page.
// Limit is capped at MaxPageLimit (128); zero falls back to DefaultPageLimit (50).
// Skip = true means "return an empty page without hitting the database" (used when
// the caller knows this list is exhausted and only the other list needs advancing).
type PageInput struct {
	Cursor string
	Limit  int
	Skip   bool
}

// PageResult is returned by every paginated list query.
// NextToken is empty when the current page is the last one.
type PageResult[T any] struct {
	Items     []T    `json:"items"`
	NextToken string `json:"next_token,omitempty"`
}

// cursorPayload is the decoded body of an opaque pagination cursor.
// Offset-based cursors set O; time-based cursors set B (Unix nanoseconds).
type cursorPayload struct {
	O int   `json:"o,omitempty"`
	B int64 `json:"b,omitempty"`
}

func decodeOffsetCursor(token string) (int, error) {
	if token == "" {
		return 0, nil
	}
	raw, err := base64.StdEncoding.DecodeString(token)
	if err != nil {
		return 0, fmt.Errorf("invalid cursor: %w", err)
	}
	var p cursorPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return 0, fmt.Errorf("invalid cursor: %w", err)
	}
	return p.O, nil
}

func encodeOffsetCursor(offset int) string {
	raw, _ := json.Marshal(cursorPayload{O: offset})
	return base64.StdEncoding.EncodeToString(raw)
}

func decodeTimeCursor(token string) (time.Time, error) {
	if token == "" {
		return time.Time{}, nil
	}
	raw, err := base64.StdEncoding.DecodeString(token)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid cursor: %w", err)
	}
	var p cursorPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return time.Time{}, fmt.Errorf("invalid cursor: %w", err)
	}
	if p.B == 0 {
		return time.Time{}, nil
	}
	return time.Unix(0, p.B).UTC(), nil
}

func encodeTimeCursor(t time.Time) string {
	raw, _ := json.Marshal(cursorPayload{B: t.UnixNano()})
	return base64.StdEncoding.EncodeToString(raw)
}

// clampLimit normalises a requested limit to the range [1, MaxPageLimit].
func clampLimit(limit int) int {
	if limit <= 0 {
		return DefaultPageLimit
	}
	if limit > MaxPageLimit {
		return MaxPageLimit
	}
	return limit
}

// offsetNextToken returns the next-page cursor when more rows may exist,
// or "" when the result set is shorter than limit (last page).
func offsetNextToken(resultsLen, limit, currentOffset int) string {
	if resultsLen < limit {
		return ""
	}
	return encodeOffsetCursor(currentOffset + limit)
}

// DBTX is satisfied by both *sql.DB and *sql.Tx, allowing Queries to be
// backed by either a connection pool or an open transaction.
type DBTX interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// Queries wraps a DBTX and exposes all application query methods.
// Create one at startup via New and inject it into services that need it.
// To execute queries under RLS call ForUser, which opens a transaction with
// app.current_user_id set for the duration of that transaction.
type Queries struct {
	db   DBTX
	pool *sql.DB
}

func New(db *sql.DB) *Queries {
	return &Queries{db: db, pool: db}
}

// ForUser begins a transaction with SET LOCAL app.current_user_id = userID
// and returns a Queries backed by that transaction together with the
// underlying *sql.Tx. The caller must always defer tx.Rollback() (it is a
// no-op after a successful Commit) and call tx.Commit() for write operations.
//
//	q, tx, err := queries.ForUser(ctx, userID)
//	if err != nil { return err }
//	defer func() { _ = tx.Rollback() }()
//	// ... use q for queries ...
//	return tx.Commit() // omit for read-only operations
func (q *Queries) ForUser(ctx context.Context, userID uuid.UUID) (*Queries, *sql.Tx, error) {
	tx, err := q.pool.BeginTx(ctx, nil)
	if err != nil {
		log.Printf("ForUser: begin tx failed: %v", err)
		return nil, nil, fmt.Errorf("ForUser: begin tx: %w", err)
	}
	// set_config(param, value, is_local=true) is transaction-scoped and works
	// correctly with lib/pq's parameterized query handling, unlike SET LOCAL x = $1
	// which lib/pq may send as a literal rather than a bound parameter.
	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.current_user_id', $1, true)`, userID.String()); err != nil {
		log.Printf("ForUser: set_config failed for user %s: %v", userID, err)
		_ = tx.Rollback()
		return nil, nil, fmt.Errorf("ForUser: set user: %w", err)
	}
	return &Queries{db: tx, pool: q.pool}, tx, nil
}
