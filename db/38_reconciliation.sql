-- MinIO <-> Postgres reconciliation ledger.
--
-- reconciliation_runs is one row per scan (the daily 4am-local heartbeat, or an
-- admin-triggered manual run). reconciliation_findings records every individual
-- piece of drift a run (or an inline code path, e.g. a failed drive-migration
-- cleanup) turned up, independent of any run — run_id is nullable so a finding
-- logged outside of a scan still shows up in the admin ledger until the next
-- scan re-discovers and clears it.
--
-- No RLS: this is an internal admin/ops ledger, not user-owned data (mirrors
-- email_queue / recognition_jobs — admin-only consumer).

CREATE TABLE reconciliation_runs (
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

CREATE INDEX reconciliation_runs_started_idx ON reconciliation_runs (started_at DESC);

CREATE TABLE reconciliation_findings (
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

CREATE INDEX reconciliation_findings_run_idx     ON reconciliation_findings (run_id);
CREATE INDEX reconciliation_findings_created_idx ON reconciliation_findings (created_at DESC);
