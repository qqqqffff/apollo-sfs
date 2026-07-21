package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"apollo-sfs.com/api/models"
)

// CreateTestRun persists one test-runner report, tagged with the deployment
// version/git branch the api process was built from. passed is the overall
// pass/fail (models.TestRunReport.AnyFailed negated) — stored as a column
// (rather than re-derived from Report on every read) purely so future callers
// can filter/sort on it without unmarshaling the report.
func (q *Queries) CreateTestRun(ctx context.Context, version, branch string, report models.TestRunReport, passed bool) (*models.TestRun, error) {
	reportJSON, err := json.Marshal(report)
	if err != nil {
		return nil, fmt.Errorf("CreateTestRun: marshal report: %w", err)
	}

	var r models.TestRun
	var raw []byte
	err = q.db.QueryRowContext(ctx, `
		INSERT INTO test_runs (deployment_version, git_branch, report, passed)
		VALUES ($1, $2, $3, $4)
		RETURNING id, deployment_version, git_branch, report, passed, created_at
	`, version, branch, reportJSON, passed).Scan(
		&r.ID, &r.DeploymentVersion, &r.GitBranch, &raw, &r.Passed, &r.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("CreateTestRun: %w", err)
	}
	if err := json.Unmarshal(raw, &r.Report); err != nil {
		return nil, fmt.Errorf("CreateTestRun: unmarshal report: %w", err)
	}
	return &r, nil
}

// GetLatestTestRunForBranch returns the most recent run recorded for branch,
// or nil if none exist.
func (q *Queries) GetLatestTestRunForBranch(ctx context.Context, branch string) (*models.TestRun, error) {
	return q.scanLatestTestRun(ctx, `
		SELECT id, deployment_version, git_branch, report, passed, created_at
		FROM test_runs WHERE git_branch = $1 ORDER BY created_at DESC LIMIT 1
	`, branch)
}

// GetLatestTestRun returns the most recent run across every branch, or nil if
// no run has ever been recorded. Used as the fallback when the current branch
// has no run of its own yet.
func (q *Queries) GetLatestTestRun(ctx context.Context) (*models.TestRun, error) {
	return q.scanLatestTestRun(ctx, `
		SELECT id, deployment_version, git_branch, report, passed, created_at
		FROM test_runs ORDER BY created_at DESC LIMIT 1
	`)
}

func (q *Queries) scanLatestTestRun(ctx context.Context, query string, args ...any) (*models.TestRun, error) {
	var r models.TestRun
	var raw []byte
	err := q.db.QueryRowContext(ctx, query, args...).Scan(
		&r.ID, &r.DeploymentVersion, &r.GitBranch, &raw, &r.Passed, &r.CreatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("scanLatestTestRun: %w", err)
	}
	if err := json.Unmarshal(raw, &r.Report); err != nil {
		return nil, fmt.Errorf("scanLatestTestRun: unmarshal report: %w", err)
	}
	return &r, nil
}
