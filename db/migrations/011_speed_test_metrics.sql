-- Migration 011: persist speed test results alongside metrics snapshots.
-- Previously speed_test_* fields were broadcast-only (never stored), so the
-- historical graph always showed "Waiting for data". Now the sampler writes the
-- latest speed test result into each snapshot row so the history query returns it.

ALTER TABLE server_metrics_snapshots
  ADD COLUMN IF NOT EXISTS speed_test_upload_mbps   DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS speed_test_download_mbps DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS speed_test_tested_at     TIMESTAMPTZ;
