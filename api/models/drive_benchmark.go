package models

import "time"

// BenchmarkResultPayload is one physical disk's result within the batch
// node-agent POSTs to /internal/node-benchmark-result after running its local
// write/read test (see cmd/node-agent/benchmark.go). WriteMbps/ReadMbps are
// nil when Error is set (the disk's test failed).
type BenchmarkResultPayload struct {
	Label     string   `json:"label"`
	WriteMbps *float64 `json:"write_mbps,omitempty"`
	ReadMbps  *float64 `json:"read_mbps,omitempty"`
	SizeBytes int64    `json:"size_bytes"`
	Error     string   `json:"error,omitempty"`
}

// BenchmarkResultBatch is the full body node-agent POSTs to
// /internal/node-benchmark-result — every disk it benchmarked in one call,
// identified by hostname the same way the regular metrics push is.
type BenchmarkResultBatch struct {
	Hostname string                   `json:"hostname"`
	Results  []BenchmarkResultPayload `json:"results"`
}

// TierBenchmarkStat is the write/read throughput averaged across every
// physical disk on one storage tier's node(s) — e.g. the fast tier's two
// pooled NVMe drives averaged together, compared against the standard tier's
// single HDD.
type TierBenchmarkStat struct {
	WriteMbps float64   `json:"write_mbps"`
	ReadMbps  float64   `json:"read_mbps"`
	DiskCount int       `json:"disk_count"`
	TestedAt  time.Time `json:"tested_at"`
}

// DriveBenchmarkSummary is the public-facing fast-vs-standard comparison — no
// per-disk breakdown, just the two tier aggregates. Available is false before
// the first benchmark has ever completed, in which case Fast/Standard are nil
// and callers (the home page, registration, and Add Storage promo cards) show
// a "results coming soon" placeholder instead of a fabricated number.
type DriveBenchmarkSummary struct {
	Available bool               `json:"available"`
	Fast      *TierBenchmarkStat `json:"fast,omitempty"`
	Standard  *TierBenchmarkStat `json:"standard,omitempty"`
}
