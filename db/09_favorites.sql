-- User favorites: a junction table linking a user to a favorited file or folder.
-- Exactly one of file_id / folder_id must be non-null (enforced by CHECK).
-- Cascade deletes automatically remove favorites when the underlying item is deleted.
-- Partial unique indexes prevent a user from favoriting the same item twice.

CREATE TABLE favorites (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL,
    file_id    UUID        REFERENCES files   (id) ON DELETE CASCADE,
    folder_id  UUID        REFERENCES folders (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT favorites_exactly_one_target
        CHECK ((file_id IS NULL) <> (folder_id IS NULL))
);

CREATE UNIQUE INDEX favorites_file_unique_idx
    ON favorites (user_id, file_id)
    WHERE file_id IS NOT NULL;

CREATE UNIQUE INDEX favorites_folder_unique_idx
    ON favorites (user_id, folder_id)
    WHERE folder_id IS NOT NULL;

CREATE INDEX favorites_user_id_idx ON favorites (user_id);
