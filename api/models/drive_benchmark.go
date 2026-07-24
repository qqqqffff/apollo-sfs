package models

import "time"

// Benchmark step identifiers, shared between node-agent (which reports them
// via BenchmarkProgressPayload as it works through each disk) and the admin
// page (which shows them in the progress bar). One physical disk goes through
// all four, in this order, before node-agent moves to the next disk.
const (
	BenchmarkStepSeqWrite    = "seq_write"
	BenchmarkStepSeqRead     = "seq_read"
	BenchmarkStepRandomWrite = "random_write"
	BenchmarkStepRandomRead  = "random_read"
)

// BenchmarkProgressPayload is what node-agent POSTs to
// /internal/node-benchmark-progress right before starting each step of a
// benchmark run, so the admin page can show live "which disk, which step"
// progress instead of just a coarse per-node pending flag. Fire-and-forget:
// node-agent doesn't retry a failed post, since the next step's post (or the
// final result batch) supersedes it anyway — see cmd/node-agent/benchmark.go.
type BenchmarkProgressPayload struct {
	Hostname string `json:"hostname"`
	Label    string `json:"label"`
	Step     string `json:"step"`
}

// BenchmarkResultPayload is one physical disk's result within the batch
// node-agent POSTs to /internal/node-benchmark-result after running its local
// benchmark (see cmd/node-agent/benchmark.go): a sequential ("same sector")
// write+read pass and a random-access (random 4 KiB block) write+read pass,
// mirroring the split industry tools like fio/CrystalDiskMark use. The *Mbps/
// *IOPS fields are nil when Error is set (the disk's test failed).
type BenchmarkResultPayload struct {
	Label     string `json:"label"`
	SizeBytes int64  `json:"size_bytes"`
	Error     string `json:"error,omitempty"`

	// Sequential pass: one large fsync'd write, then a sequential read of the
	// same file.
	SeqWriteMbps *float64 `json:"seq_write_mbps,omitempty"`
	SeqReadMbps  *float64 `json:"seq_read_mbps,omitempty"`

	// Random-access pass: fixed 4 KiB reads/writes at random block-aligned
	// offsets within the same file, time-boxed rather than a fixed operation
	// count so a slow HDD's low IOPS doesn't blow out the run time.
	RandomWriteMbps *float64 `json:"random_write_mbps,omitempty"`
	RandomWriteIOPS *float64 `json:"random_write_iops,omitempty"`
	RandomReadMbps  *float64 `json:"random_read_mbps,omitempty"`
	RandomReadIOPS  *float64 `json:"random_read_iops,omitempty"`

	// DirectIO is true only if every pass above opened the file with
	// O_DIRECT, bypassing the kernel page cache. False means at least one
	// pass fell back to buffered I/O (the mount's filesystem doesn't support
	// O_DIRECT) and the numbers may still be cache-inflated.
	DirectIO bool `json:"direct_io"`
}

// BenchmarkResultBatch is the full body node-agent POSTs to
// /internal/node-benchmark-result — every disk it benchmarked in one call,
// identified by hostname the same way the regular metrics push is.
type BenchmarkResultBatch struct {
	Hostname string                   `json:"hostname"`
	Results  []BenchmarkResultPayload `json:"results"`
}

// TierBenchmarkStat is the sequential and random-access throughput averaged
// across every physical disk on one storage tier's node(s) — e.g. the fast
// tier's two pooled NVMe drives averaged together, compared against the
// standard tier's single HDD.
type TierBenchmarkStat struct {
	SeqWriteMbps    float64 `json:"seq_write_mbps"`
	SeqReadMbps     float64 `json:"seq_read_mbps"`
	RandomWriteMbps float64 `json:"random_write_mbps"`
	RandomWriteIOPS float64 `json:"random_write_iops"`
	RandomReadMbps  float64 `json:"random_read_mbps"`
	RandomReadIOPS  float64 `json:"random_read_iops"`

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
