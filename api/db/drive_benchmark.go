package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// ── Benchmark trigger ────────────────────────────────────────────────────────
//
// node-agent has no inbound listener (it only push-POSTs its regular metrics
// sample outward every few seconds), so there is no way to tell it "run a
// benchmark now" directly. Instead, the request is recorded here and ridden
// out on that same push: node-metrics-ingest checks-and-clears it for the
// pushing hostname on every /internal/node-metrics call and tells the agent
// to run the benchmark in its response.

// RequestBenchmarkOnAllNodes marks every active node as due for a benchmark run.
func (q *Queries) RequestBenchmarkOnAllNodes(ctx context.Context) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE nodes SET benchmark_requested_at = NOW() WHERE is_active = true`)
	if err != nil {
		return fmt.Errorf("RequestBenchmarkOnAllNodes: %w", err)
	}
	return nil
}

// CountPendingBenchmarkRequests returns how many nodes still have an
// unconsumed benchmark request, so the trigger endpoint can refuse to start a
// second run while one is already in flight.
func (q *Queries) CountPendingBenchmarkRequests(ctx context.Context) (int, error) {
	var n int
	err := q.db.QueryRowContext(ctx,
		`SELECT count(*) FROM nodes WHERE benchmark_requested_at IS NOT NULL`).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("CountPendingBenchmarkRequests: %w", err)
	}
	return n, nil
}

// ConsumeBenchmarkRequest atomically checks-and-clears a pending benchmark
// request for the given hostname, returning true if one was pending.
func (q *Queries) ConsumeBenchmarkRequest(ctx context.Context, hostname string) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE nodes SET benchmark_requested_at = NULL
		WHERE hostname = $1 AND benchmark_requested_at IS NOT NULL
	`, hostname)
	if err != nil {
		return false, fmt.Errorf("ConsumeBenchmarkRequest: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("ConsumeBenchmarkRequest: %w", err)
	}
	return n > 0, nil
}

// ── Disk benchmark results ──────────────────────────────────────────────────
//
// One latest row per physical disk, upserted on every run — an on-demand
// probe has no history to keep, unlike the continuously-sampled IO counters
// in node_disk_io_snapshots.

// UpsertNodeDiskBenchmarkParams carries one physical disk's benchmark result.
type UpsertNodeDiskBenchmarkParams struct {
	NodeID    uuid.UUID
	Label     string
	WriteMbps *float64
	ReadMbps  *float64
	SizeBytes int64
	Error     string
}

// UpsertNodeDiskBenchmark records the latest benchmark result for one
// physical disk, keyed by (node_id, label).
func (q *Queries) UpsertNodeDiskBenchmark(ctx context.Context, p UpsertNodeDiskBenchmarkParams) error {
	var errVal *string
	if p.Error != "" {
		errVal = &p.Error
	}
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO node_disk_benchmarks (node_id, label, write_mbps, read_mbps, size_bytes, error, tested_at)
		VALUES ($1, $2, $3, $4, $5, $6, NOW())
		ON CONFLICT (node_id, label) DO UPDATE SET
			write_mbps = EXCLUDED.write_mbps,
			read_mbps  = EXCLUDED.read_mbps,
			size_bytes = EXCLUDED.size_bytes,
			error      = EXCLUDED.error,
			tested_at  = NOW()
	`, p.NodeID, p.Label, p.WriteMbps, p.ReadMbps, p.SizeBytes, errVal)
	if err != nil {
		return fmt.Errorf("UpsertNodeDiskBenchmark: %w", err)
	}
	return nil
}

// NodeDiskBenchmarkRow is one benchmarked disk joined with its node's
// hostname and storage tier. DriveType comes from any drive registered on
// that node (every physical disk on a given node shares the same tier by
// construction — a node is wired to exactly one MinIO tier) and is "" if the
// node has no registered drive yet.
type NodeDiskBenchmarkRow struct {
	NodeID    uuid.UUID
	Hostname  string
	Label     string
	WriteMbps *float64
	ReadMbps  *float64
	SizeBytes int64
	Error     string
	TestedAt  time.Time
	DriveType string
}

// ListNodeDiskBenchmarks returns every disk's latest benchmark result, newest
// query first, for the admin detail view and the fast/standard aggregation
// (see AggregateBenchmarkRows).
func (q *Queries) ListNodeDiskBenchmarks(ctx context.Context) ([]NodeDiskBenchmarkRow, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT ndb.node_id, n.hostname, ndb.label, ndb.write_mbps, ndb.read_mbps,
		       ndb.size_bytes, COALESCE(ndb.error, ''), ndb.tested_at, COALESCE(d.drive_type, '')
		FROM node_disk_benchmarks ndb
		JOIN nodes n ON n.id = ndb.node_id
		LEFT JOIN LATERAL (
			SELECT drive_type FROM drives WHERE node_id = n.id LIMIT 1
		) d ON true
		ORDER BY n.hostname, ndb.label
	`)
	if err != nil {
		return nil, fmt.Errorf("ListNodeDiskBenchmarks: %w", err)
	}
	defer rows.Close()

	var out []NodeDiskBenchmarkRow
	for rows.Next() {
		var r NodeDiskBenchmarkRow
		var write, read sql.NullFloat64
		if err := rows.Scan(&r.NodeID, &r.Hostname, &r.Label, &write, &read,
			&r.SizeBytes, &r.Error, &r.TestedAt, &r.DriveType); err != nil {
			return nil, fmt.Errorf("ListNodeDiskBenchmarks scan: %w", err)
		}
		if write.Valid {
			r.WriteMbps = &write.Float64
		}
		if read.Valid {
			r.ReadMbps = &read.Float64
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AggregateBenchmarkRows groups benchmark rows by storage tier and averages
// write/read throughput across every successfully-tested disk in each group —
// this is the "average the NVMe drives, compare to the standard drive" logic.
// Rows with an Error (failed disk test) or an unrecognized/missing DriveType
// are excluded. Returns nil for a tier with no successful results yet.
func AggregateBenchmarkRows(rows []NodeDiskBenchmarkRow) (fast, standard *models.TierBenchmarkStat) {
	type acc struct {
		writeSum, readSum float64
		count             int
		latest            time.Time
	}
	accs := map[string]*acc{"nvme": {}, "hdd": {}}

	for _, r := range rows {
		if r.Error != "" || r.WriteMbps == nil || r.ReadMbps == nil {
			continue
		}
		a, ok := accs[r.DriveType]
		if !ok {
			continue
		}
		a.writeSum += *r.WriteMbps
		a.readSum += *r.ReadMbps
		a.count++
		if r.TestedAt.After(a.latest) {
			a.latest = r.TestedAt
		}
	}

	toStat := func(a *acc) *models.TierBenchmarkStat {
		if a.count == 0 {
			return nil
		}
		return &models.TierBenchmarkStat{
			WriteMbps: a.writeSum / float64(a.count),
			ReadMbps:  a.readSum / float64(a.count),
			DiskCount: a.count,
			TestedAt:  a.latest,
		}
	}
	return toStat(accs["nvme"]), toStat(accs["hdd"])
}
