-- AI recognition (premium): per-collection face/pet/object indexing.
-- Adds:
--   * folders.ai_recognition_enabled — per-collection toggle (media folders only,
--     enforced by the handler)
--   * recognition_jobs — durable work queue drained by the API worker (no RLS;
--     mirrors email_queue/video_variants — worker-only consumer, status reads
--     join-guarded by collection ownership)
--   * recognition_detections — per-file face/pet/object detections; embedding is
--     a unit-normalized LE float32 vector; thumb_* is the encrypted crop stored
--     at {userID}/recognition/{detectionID}.jpg, quota-counted via thumb_size_bytes
--   * recognition_groups / recognition_group_members — per-collection clusters
--     with auto/user labels (user_label is what search matches)
-- See db/36_recognition.sql for the full column commentary.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'folders' AND column_name = 'ai_recognition_enabled'
    ) THEN
        ALTER TABLE folders ADD COLUMN ai_recognition_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS recognition_jobs (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL,
    username      TEXT        NOT NULL,
    collection_id UUID        NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
    file_id       UUID        NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    status        TEXT        NOT NULL DEFAULT 'pending',
    attempts      INT         NOT NULL DEFAULT 0,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT recognition_jobs_unique_per_collection UNIQUE (collection_id, file_id),
    CONSTRAINT recognition_jobs_status_check
        CHECK (status IN ('pending', 'processing', 'done', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS recognition_jobs_claim_idx ON recognition_jobs (status, user_id, created_at);
CREATE INDEX IF NOT EXISTS recognition_jobs_coll_idx  ON recognition_jobs (collection_id, status);

CREATE TABLE IF NOT EXISTS recognition_detections (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL,
    file_id          UUID        NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    kind             TEXT        NOT NULL,
    class_label      TEXT,
    confidence       REAL        NOT NULL,
    bbox_x           REAL        NOT NULL,
    bbox_y           REAL        NOT NULL,
    bbox_w           REAL        NOT NULL,
    bbox_h           REAL        NOT NULL,
    frame_ms         INT,
    embedding        BYTEA,
    thumb_object_key TEXT,
    thumb_nonce      BYTEA,
    thumb_size_bytes BIGINT      NOT NULL DEFAULT 0,
    model_version    TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT recognition_detections_kind_check CHECK (kind IN ('face', 'pet', 'object'))
);

CREATE INDEX IF NOT EXISTS recognition_detections_file_idx ON recognition_detections (file_id);
CREATE INDEX IF NOT EXISTS recognition_detections_user_idx ON recognition_detections (user_id);

CREATE TABLE IF NOT EXISTS recognition_groups (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID        NOT NULL,
    collection_id      UUID        NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
    kind               TEXT        NOT NULL,
    class_label        TEXT,
    auto_label         TEXT        NOT NULL,
    user_label         TEXT,
    centroid           BYTEA,
    member_count       INT         NOT NULL DEFAULT 0,
    cover_detection_id UUID        REFERENCES recognition_detections (id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT recognition_groups_kind_check CHECK (kind IN ('face', 'pet', 'object'))
);

CREATE UNIQUE INDEX IF NOT EXISTS recognition_groups_object_class_unique
    ON recognition_groups (collection_id, class_label) WHERE kind = 'object';
CREATE INDEX IF NOT EXISTS recognition_groups_coll_idx  ON recognition_groups (collection_id, kind);
CREATE INDEX IF NOT EXISTS recognition_groups_label_idx ON recognition_groups (user_id) WHERE user_label IS NOT NULL;

CREATE TABLE IF NOT EXISTS recognition_group_members (
    group_id     UUID NOT NULL REFERENCES recognition_groups (id) ON DELETE CASCADE,
    detection_id UUID NOT NULL REFERENCES recognition_detections (id) ON DELETE CASCADE,
    file_id      UUID NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    user_id      UUID NOT NULL,

    PRIMARY KEY (group_id, detection_id)
);

CREATE INDEX IF NOT EXISTS recognition_group_members_file_idx ON recognition_group_members (group_id, file_id);
CREATE INDEX IF NOT EXISTS recognition_group_members_det_idx  ON recognition_group_members (detection_id);

ALTER TABLE recognition_detections    ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_detections    FORCE  ROW LEVEL SECURITY;
ALTER TABLE recognition_groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_groups        FORCE  ROW LEVEL SECURITY;
ALTER TABLE recognition_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_group_members FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recognition_detections_owned_by_current_user ON recognition_detections;
CREATE POLICY recognition_detections_owned_by_current_user ON recognition_detections
    USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

DROP POLICY IF EXISTS recognition_groups_owned_by_current_user ON recognition_groups;
CREATE POLICY recognition_groups_owned_by_current_user ON recognition_groups
    USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

DROP POLICY IF EXISTS recognition_group_members_owned_by_current_user ON recognition_group_members;
CREATE POLICY recognition_group_members_owned_by_current_user ON recognition_group_members
    USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
