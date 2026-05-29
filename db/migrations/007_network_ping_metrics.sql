-- Migration 007: add server-side ISP ping and packet-loss columns to snapshots.
-- Both columns are nullable — set to NULL when ping is unavailable (no ICMP
-- capability, network unreachable, etc.).

ALTER TABLE server_metrics_snapshots
  ADD COLUMN IF NOT EXISTS server_isp_ping_ms             DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS server_isp_packet_loss_percent DOUBLE PRECISION;
