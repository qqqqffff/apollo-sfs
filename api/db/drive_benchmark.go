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

// RequestBenchmarkOnAllNodes marks every active node as due for a benchmark
// run. Also clears any leftover live-progress state from a prior run (e.g.
// one where the final result POST never made it — see ClearBenchmarkProgress)
// so a fresh trigger never shows stale "currently benchmarking" info.
func (q *Queries) RequestBenchmarkOnAllNodes(ctx context.Context) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE nodes
		SET benchmark_requested_at = NOW(), benchmark_current_label = NULL, benchmark_current_step = NULL
		WHERE is_active = true
	`)
	if err != nil {
		return fmt.Errorf("RequestBenchmarkOnAllNodes: %w", err)
	}
	return nil
}

// CountInFlightBenchmarkNodes returns how many active nodes are still part of
// an in-flight run — either they haven't yet picked up the trigger
// (benchmark_requested_at still set) or they have and are actively working
// through a disk (benchmark_current_step set, reported by SetBenchmarkProgress).
// Used both to refuse a second trigger while one is running and, paired with
// CountActiveNodes, to compute the admin page's completed/total progress.
func (q *Queries) CountInFlightBenchmarkNodes(ctx context.Context) (int, error) {
	var n int
	err := q.db.QueryRowContext(ctx, `
		SELECT count(*) FROM nodes
		WHERE benchmark_requested_at IS NOT NULL OR benchmark_current_step IS NOT NULL
	`).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("CountInFlightBenchmarkNodes: %w", err)
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

// CountActiveNodes returns how many nodes are active — i.e. how many benchmark
// requests a triggered run fans out to. Paired with CountInFlightBenchmarkNodes
// this lets the admin page show real completed/total progress (one node's
// result arrives in a single atomic push, so per-node is the coarsest-grained
// signal; SetBenchmarkProgress/ListRunningBenchmarkNodes below add the
// finer-grained "which disk, which step" detail within that).
func (q *Queries) CountActiveNodes(ctx context.Context) (int, error) {
	var n int
	err := q.db.QueryRowContext(ctx,
		`SELECT count(*) FROM nodes WHERE is_active = true`).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("CountActiveNodes: %w", err)
	}
	return n, nil
}

// ── Live benchmark progress ─────────────────────────────────────────────────
//
// Ephemeral, best-effort "which disk, which step is running right now" state,
// reported by node-agent (POST /internal/node-benchmark-progress) right
// before it starts each step of each disk. Not part of the recorded result —
// just live telemetry for the admin page's progress bar while a run is in
// flight.

// SetBenchmarkProgress records the disk label and step a node's agent is
// currently executing.
func (q *Queries) SetBenchmarkProgress(ctx context.Context, nodeID uuid.UUID, label, step string) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE nodes SET benchmark_current_label = $2, benchmark_current_step = $3 WHERE id = $1`,
		nodeID, label, step)
	if err != nil {
		return fmt.Errorf("SetBenchmarkProgress: %w", err)
	}
	return nil
}

// ClearBenchmarkProgress clears a node's live progress state once its result
// batch has been recorded (see RecordBenchmarkResults).
func (q *Queries) ClearBenchmarkProgress(ctx context.Context, nodeID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx,
		`UPDATE nodes SET benchmark_current_label = NULL, benchmark_current_step = NULL WHERE id = $1`,
		nodeID)
	if err != nil {
		return fmt.Errorf("ClearBenchmarkProgress: %w", err)
	}
	return nil
}

// NodeBenchmarkProgress is one node's current disk/step, for nodes actively
// mid-run right now.
type NodeBenchmarkProgress struct {
	Hostname  string
	Label     string
	Step      string
	DriveType string
}

// ListRunningBenchmarkNodes returns every node currently executing a
// benchmark step, for the admin page's live "what's happening right now"
// display. DriveType is resolved the same way as ListNodeDiskBenchmarks.
func (q *Queries) ListRunningBenchmarkNodes(ctx context.Context) ([]NodeBenchmarkProgress, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT n.hostname, COALESCE(n.benchmark_current_label, ''), n.benchmark_current_step, COALESCE(d.drive_type, '')
		FROM nodes n
		LEFT JOIN LATERAL (
			SELECT drive_type FROM drives WHERE node_id = n.id LIMIT 1
		) d ON true
		WHERE n.benchmark_current_step IS NOT NULL
		ORDER BY n.hostname
	`)
	if err != nil {
		return nil, fmt.Errorf("ListRunningBenchmarkNodes: %w", err)
	}
	defer rows.Close()

	var out []NodeBenchmarkProgress
	for rows.Next() {
		var r NodeBenchmarkProgress
		if err := rows.Scan(&r.Hostname, &r.Label, &r.Step, &r.DriveType); err != nil {
			return nil, fmt.Errorf("ListRunningBenchmarkNodes scan: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ── Disk benchmark results ──────────────────────────────────────────────────
//
// One latest row per physical disk, upserted on every run — an on-demand
// probe has no history to keep, unlike the continuously-sampled IO counters
// in node_disk_io_snapshots.

// UpsertNodeDiskBenchmarkParams carries one physical disk's benchmark result:
// a sequential ("same sector") pass and a random-access pass, mirroring
// models.BenchmarkResultPayload.
type UpsertNodeDiskBenchmarkParams struct {
	NodeID    uuid.UUID
	Label     string
	SizeBytes int64
	Error     string

	SeqWriteMbps *float64
	SeqReadMbps  *float64

	RandomWriteMbps *float64
	RandomWriteIOPS *float64
	RandomReadMbps  *float64
	RandomReadIOPS  *float64

	DirectIO bool
}

// UpsertNodeDiskBenchmark records the latest benchmark result for one
// physical disk, keyed by (node_id, label).
func (q *Queries) UpsertNodeDiskBenchmark(ctx context.Context, p UpsertNodeDiskBenchmarkParams) error {
	var errVal *string
	if p.Error != "" {
		errVal = &p.Error
	}
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO node_disk_benchmarks (
			node_id, label, size_bytes, error,
			seq_write_mbps, seq_read_mbps,
			random_write_mbps, random_write_iops, random_read_mbps, random_read_iops,
			direct_io, tested_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
		ON CONFLICT (node_id, label) DO UPDATE SET
			size_bytes         = EXCLUDED.size_bytes,
			error              = EXCLUDED.error,
			seq_write_mbps     = EXCLUDED.seq_write_mbps,
			seq_read_mbps      = EXCLUDED.seq_read_mbps,
			random_write_mbps  = EXCLUDED.random_write_mbps,
			random_write_iops  = EXCLUDED.random_write_iops,
			random_read_mbps   = EXCLUDED.random_read_mbps,
			random_read_iops   = EXCLUDED.random_read_iops,
			direct_io          = EXCLUDED.direct_io,
			tested_at          = NOW()
	`, p.NodeID, p.Label, p.SizeBytes, errVal,
		p.SeqWriteMbps, p.SeqReadMbps,
		p.RandomWriteMbps, p.RandomWriteIOPS, p.RandomReadMbps, p.RandomReadIOPS,
		p.DirectIO)
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
	SizeBytes int64
	Error     string
	TestedAt  time.Time
	DriveType string

	SeqWriteMbps *float64
	SeqReadMbps  *float64

	RandomWriteMbps *float64
	RandomWriteIOPS *float64
	RandomReadMbps  *float64
	RandomReadIOPS  *float64

	DirectIO bool
}

// ListNodeDiskBenchmarks returns every disk's latest benchmark result, newest
// query first, for the admin detail view and the fast/standard aggregation
// (see AggregateBenchmarkRows).
func (q *Queries) ListNodeDiskBenchmarks(ctx context.Context) ([]NodeDiskBenchmarkRow, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT ndb.node_id, n.hostname, ndb.label, ndb.size_bytes, COALESCE(ndb.error, ''),
		       ndb.tested_at, COALESCE(d.drive_type, ''),
		       ndb.seq_write_mbps, ndb.seq_read_mbps,
		       ndb.random_write_mbps, ndb.random_write_iops, ndb.random_read_mbps, ndb.random_read_iops,
		       ndb.direct_io
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
		var seqWrite, seqRead, randWriteMbps, randWriteIOPS, randReadMbps, randReadIOPS sql.NullFloat64
		if err := rows.Scan(&r.NodeID, &r.Hostname, &r.Label, &r.SizeBytes, &r.Error,
			&r.TestedAt, &r.DriveType,
			&seqWrite, &seqRead,
			&randWriteMbps, &randWriteIOPS, &randReadMbps, &randReadIOPS,
			&r.DirectIO); err != nil {
			return nil, fmt.Errorf("ListNodeDiskBenchmarks scan: %w", err)
		}
		if seqWrite.Valid {
			r.SeqWriteMbps = &seqWrite.Float64
		}
		if seqRead.Valid {
			r.SeqReadMbps = &seqRead.Float64
		}
		if randWriteMbps.Valid {
			r.RandomWriteMbps = &randWriteMbps.Float64
		}
		if randWriteIOPS.Valid {
			r.RandomWriteIOPS = &randWriteIOPS.Float64
		}
		if randReadMbps.Valid {
			r.RandomReadMbps = &randReadMbps.Float64
		}
		if randReadIOPS.Valid {
			r.RandomReadIOPS = &randReadIOPS.Float64
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AggregateBenchmarkRows groups benchmark rows by storage tier and averages
// every sequential/random metric across each group's successfully-tested
// disks — this is the "average the NVMe drives, compare to the standard
// drive" logic. Rows with an Error (failed disk test), a missing metric, or
// an unrecognized/missing DriveType are excluded. Returns nil for a tier with
// no successful results yet.
func AggregateBenchmarkRows(rows []NodeDiskBenchmarkRow) (fast, standard *models.TierBenchmarkStat) {
	type acc struct {
		seqWriteSum, seqReadSum            float64
		randWriteMbpsSum, randWriteIOPSSum float64
		randReadMbpsSum, randReadIOPSSum   float64
		count                              int
		latest                             time.Time
	}
	accs := map[string]*acc{"nvme": {}, "hdd": {}}

	for _, r := range rows {
		if r.Error != "" || r.SeqWriteMbps == nil || r.SeqReadMbps == nil ||
			r.RandomWriteMbps == nil || r.RandomWriteIOPS == nil ||
			r.RandomReadMbps == nil || r.RandomReadIOPS == nil {
			continue
		}
		a, ok := accs[r.DriveType]
		if !ok {
			continue
		}
		a.seqWriteSum += *r.SeqWriteMbps
		a.seqReadSum += *r.SeqReadMbps
		a.randWriteMbpsSum += *r.RandomWriteMbps
		a.randWriteIOPSSum += *r.RandomWriteIOPS
		a.randReadMbpsSum += *r.RandomReadMbps
		a.randReadIOPSSum += *r.RandomReadIOPS
		a.count++
		if r.TestedAt.After(a.latest) {
			a.latest = r.TestedAt
		}
	}

	toStat := func(a *acc) *models.TierBenchmarkStat {
		if a.count == 0 {
			return nil
		}
		n := float64(a.count)
		return &models.TierBenchmarkStat{
			SeqWriteMbps:    a.seqWriteSum / n,
			SeqReadMbps:     a.seqReadSum / n,
			RandomWriteMbps: a.randWriteMbpsSum / n,
			RandomWriteIOPS: a.randWriteIOPSSum / n,
			RandomReadMbps:  a.randReadMbpsSum / n,
			RandomReadIOPS:  a.randReadIOPSSum / n,
			DiskCount:       a.count,
			TestedAt:        a.latest,
		}
	}
	return toStat(accs["nvme"]), toStat(accs["hdd"])
}
