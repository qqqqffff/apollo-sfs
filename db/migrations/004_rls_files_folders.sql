-- Row-level security for the files and folders tables.
--
-- Every query against these tables must execute inside a transaction that
-- first sets the app.current_user_id parameter to the requesting user's UUID
-- (a string like '550e8400-e29b-41d4-a716-446655440000').
-- Use db.Queries.ForUser() to open such a transaction.
--
-- NULLIF converts an absent (empty-string) current_setting to NULL so that
-- the uuid cast evaluates to NULL rather than raising a cast error, causing
-- the row to be invisible rather than returning an error.
--
-- FORCE ROW LEVEL SECURITY applies the policy to the table owner as well,
-- which is necessary when the application DB user owns the tables.

ALTER TABLE files   ENABLE ROW LEVEL SECURITY;
ALTER TABLE files   FORCE  ROW LEVEL SECURITY;
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders FORCE  ROW LEVEL SECURITY;

CREATE POLICY files_owned_by_current_user ON files
    USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

CREATE POLICY folders_owned_by_current_user ON folders
    USING      (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);
