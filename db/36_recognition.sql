-- AI recognition (premium): per-collection face/pet/object indexing.
--
-- recognition_jobs is the durable work queue drained by the API's background
-- worker (claimed with FOR UPDATE SKIP LOCKED, interleaved per-user so one
-- large collection cannot monopolize the queue). Completed rows are kept as
-- the "already indexed in this collection" ledger; re-enabling a collection
-- upserts with ON CONFLICT DO NOTHING so only new files are processed.
-- No RLS: the worker is the only consumer and status reads are join-guarded
-- by collection ownership (mirrors email_queue / video_variants).
--
-- recognition_detections is per-file and collection-agnostic: a file indexed
-- once is never re-inferred for a second collection, only re-cluster-assigned.
-- embedding is a unit-normalized little-endian float32 vector (512-d).
-- thumb_* describe the encrypted face/pet crop stored in MinIO on the user's
-- allocated drive at {userID}/recognition/{detectionID}.jpg; thumb_size_bytes
-- is counted against the user's storage quota.
--
-- recognition_groups are per-collection clusters ('face'/'pet') or one group
-- per detected class ('object'). auto_label is the generated name ("Person 3",
-- "Pet 1 (cat)", "car"); user_label is set when the user labels the group and
-- is what the search bar matches on. member_count is the centroid weight used
-- by the incremental clustering math — display counts are computed by joining
-- recognition_group_members.

CREATE TABLE recognition_jobs (
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

CREATE INDEX recognition_jobs_claim_idx ON recognition_jobs (status, user_id, created_at);
CREATE INDEX recognition_jobs_coll_idx  ON recognition_jobs (collection_id, status);

CREATE TABLE recognition_detections (
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

CREATE INDEX recognition_detections_file_idx ON recognition_detections (file_id);
CREATE INDEX recognition_detections_user_idx ON recognition_detections (user_id);

CREATE TABLE recognition_groups (
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

-- One group per detected object class per collection.
CREATE UNIQUE INDEX recognition_groups_object_class_unique
    ON recognition_groups (collection_id, class_label) WHERE kind = 'object';
CREATE INDEX recognition_groups_coll_idx  ON recognition_groups (collection_id, kind);
CREATE INDEX recognition_groups_label_idx ON recognition_groups (user_id) WHERE user_label IS NOT NULL;

CREATE TABLE recognition_group_members (
    group_id     UUID NOT NULL REFERENCES recognition_groups (id) ON DELETE CASCADE,
    detection_id UUID NOT NULL REFERENCES recognition_detections (id) ON DELETE CASCADE,
    file_id      UUID NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    user_id      UUID NOT NULL,

    PRIMARY KEY (group_id, detection_id)
);

CREATE INDEX recognition_group_members_file_idx ON recognition_group_members (group_id, file_id);
CREATE INDEX recognition_group_members_det_idx  ON recognition_group_members (detection_id);

-- Row-level security: queries must run inside a transaction that sets
-- app.current_user_id to the requesting user's UUID via db.Queries.ForUser().
ALTER TABLE recognition_detections    ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_detections    FORCE  ROW LEVEL SECURITY;
ALTER TABLE recognition_groups        ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_groups        FORCE  ROW LEVEL SECURITY;
ALTER TABLE recognition_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_group_members FORCE  ROW LEVEL SECURITY;

CREATE POLICY recognition_detections_owned_by_current_user ON recognition_detections
    USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

CREATE POLICY recognition_groups_owned_by_current_user ON recognition_groups
    USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

CREATE POLICY recognition_group_members_owned_by_current_user ON recognition_group_members
    USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
