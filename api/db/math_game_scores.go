package db

import (
	"context"
	"fmt"

	"apollo-sfs.com/api/models"
)

// AddMathGameScoreInput is the parameter set for AddMathGameScore.
type AddMathGameScoreInput struct {
	Username   string
	Score      int
	Total      int
	DurationMs int64
}

// AddMathGameScore inserts a completed game for a user and returns the stored
// row (with its generated id and created_at). Must run inside a ForUser
// transaction so row-level security accepts the insert.
func (q *Queries) AddMathGameScore(ctx context.Context, in AddMathGameScoreInput) (*models.MathGameScore, error) {
	var s models.MathGameScore
	err := q.db.QueryRowContext(ctx, `
		INSERT INTO math_game_scores (username, score, total, duration_ms)
		VALUES ($1, $2, $3, $4)
		RETURNING id, username, score, total, duration_ms, created_at
	`, in.Username, in.Score, in.Total, in.DurationMs).Scan(
		&s.ID, &s.Username, &s.Score, &s.Total, &s.DurationMs, &s.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("AddMathGameScore: %w", err)
	}
	return &s, nil
}

// ListMathGameScores returns up to limit of the user's most recent games,
// newest first. Relies on row-level security (run inside ForUser) to scope
// rows to the current user.
func (q *Queries) ListMathGameScores(ctx context.Context, limit int) ([]models.MathGameScore, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, username, score, total, duration_ms, created_at
		FROM math_game_scores
		ORDER BY created_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("ListMathGameScores: %w", err)
	}
	defer rows.Close()

	var out []models.MathGameScore
	for rows.Next() {
		var s models.MathGameScore
		if err := rows.Scan(
			&s.ID, &s.Username, &s.Score, &s.Total, &s.DurationMs, &s.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("ListMathGameScores scan: %w", err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListMathGameScores: %w", err)
	}
	return out, nil
}
