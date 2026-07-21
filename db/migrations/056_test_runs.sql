-- Persisted test-run reports, backing the admin metrics page's test-runner
-- card. Each row is one POST /admin/system/tests run against the unified
-- test-runner sidecar, tagged with the deployment version (api's build tag,
-- normally a git short SHA) and git branch it ran against (see APP_VERSION /
-- APP_GIT_BRANCH in api/Dockerfile + api/cmd/config.go), so the card can
-- reuse a cached run for the currently-deployed branch/version instead of
-- re-running the full suite on every page load.

CREATE TABLE IF NOT EXISTS test_runs (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_version  TEXT        NOT NULL DEFAULT '',
    git_branch          TEXT        NOT NULL DEFAULT '',
    report              JSONB       NOT NULL,
    passed              BOOLEAN     NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS test_runs_branch_created_idx ON test_runs (git_branch, created_at DESC);
CREATE INDEX IF NOT EXISTS test_runs_created_idx        ON test_runs (created_at DESC);
