-- MinIO <-> Postgres reconciliation ledger (see db/38_reconciliation.sql for
-- full column commentary). Backs the daily 4am-local reconciliation heartbeat.

CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at               TIMESTAMPTZ,
    drives_scanned            INT         NOT NULL DEFAULT 0,
    objects_scanned           INT         NOT NULL DEFAULT 0,
    rows_scanned              INT         NOT NULL DEFAULT 0,
    orphans_found             INT         NOT NULL DEFAULT 0,
    orphans_deleted           INT         NOT NULL DEFAULT 0,
    ghosts_found              INT         NOT NULL DEFAULT 0,
    ghosts_deleted            INT         NOT NULL DEFAULT 0,
    abandoned_uploads_aborted INT         NOT NULL DEFAULT 0,
    error                     TEXT
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_started_idx ON reconciliation_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS reconciliation_findings (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id     UUID        REFERENCES reconciliation_runs (id) ON DELETE CASCADE,
    kind       TEXT        NOT NULL,
    drive_id   UUID,
    bucket     TEXT,
    object_key TEXT,
    user_id    UUID,
    file_id    UUID,
    detail     TEXT,
    action     TEXT        NOT NULL,
    error      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT reconciliation_findings_kind_check CHECK (
        kind IN ('orphan_object', 'ghost_file_row', 'ghost_variant_row', 'ghost_recognition_crop', 'abandoned_multipart')
    ),
    CONSTRAINT reconciliation_findings_action_check CHECK (
        action IN ('deleted', 'aborted', 'error')
    )
);

CREATE INDEX IF NOT EXISTS reconciliation_findings_run_idx     ON reconciliation_findings (run_id);
CREATE INDEX IF NOT EXISTS reconciliation_findings_created_idx ON reconciliation_findings (created_at DESC);
