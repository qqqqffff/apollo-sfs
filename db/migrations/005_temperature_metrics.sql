-- Add CPU and drive temperature columns.
-- Nullable because servers may lack accessible temperature sensors.
ALTER TABLE server_metrics_snapshots
    ADD COLUMN IF NOT EXISTS cpu_temp_celsius   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS drive_temp_celsius DOUBLE PRECISION;
