-- Migration 001: invitation quota + disk metrics
--
-- Run once against the live database:
--   psql -U apollo_sfs -d apollo_sfs -f db/migrations/001_quota_and_disk_metrics.sql
--
-- Adds initial_quota_bytes to invitations so admins can set a per-user
-- storage allocation at invite time (default matches the existing 10 GB default).
--
-- Adds disk_total_bytes / disk_free_bytes to server_metrics_snapshots so the
-- admin dashboard can show actual host disk capacity alongside user quotas.

ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS initial_quota_bytes BIGINT NOT NULL DEFAULT 10737418240;

ALTER TABLE server_metrics_snapshots
  ADD COLUMN IF NOT EXISTS disk_total_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS disk_free_bytes  BIGINT NOT NULL DEFAULT 0;
