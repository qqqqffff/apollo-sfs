-- Live per-node benchmark progress — "which disk, which step is running right
-- now" — reported by node-agent while a triggered run is in flight (see
-- docs/drive_benchmark_setup.md and cmd/node-agent/benchmark.go). This is
-- ephemeral/best-effort, not part of the recorded result: it's cleared once
-- results are recorded for that node, or a fresh run is triggered.
-- Idempotent so it can be re-applied safely against partially-migrated
-- databases.

ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS benchmark_current_label TEXT,
    ADD COLUMN IF NOT EXISTS benchmark_current_step  TEXT;
