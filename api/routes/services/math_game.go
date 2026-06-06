package services

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// MaxListedMathGameScores caps how many recent games List returns. The page
// only renders a short history, so this keeps the response small.
const MaxListedMathGameScores = 20

// ErrInvalidScore is returned when a submitted score is out of range for the
// given total (negative, or greater than total).
var ErrInvalidScore = errors.New("score is out of range for total")

// MathGameService persists and retrieves a user's /math-game results.
type MathGameService struct {
	queries *db.Queries
}

// NewMathGameService constructs a MathGameService.
func NewMathGameService(q *db.Queries) *MathGameService {
	return &MathGameService{queries: q}
}

// AddInput is the user-facing parameter set for Add.
type AddInput struct {
	Score      int
	Total      int
	DurationMs int64
}

// Add records a completed game for userID and returns the stored row. Returns
// ErrInvalidScore if the score/total pair is nonsensical.
func (s *MathGameService) Add(ctx context.Context, userID uuid.UUID, in AddInput) (*models.MathGameScore, error) {
	if in.Total <= 0 || in.Score < 0 || in.Score > in.Total {
		return nil, ErrInvalidScore
	}
	if in.DurationMs < 0 {
		in.DurationMs = 0
	}

	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("math game: tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	stored, err := q.AddMathGameScore(ctx, db.AddMathGameScoreInput{
		Username:   userID.String(),
		Score:      in.Score,
		Total:      in.Total,
		DurationMs: in.DurationMs,
	})
	if err != nil {
		return nil, fmt.Errorf("math game: persist: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("math game: commit: %w", err)
	}
	return stored, nil
}

// List returns the user's most recent games, newest first (never nil).
func (s *MathGameService) List(ctx context.Context, userID uuid.UUID) ([]models.MathGameScore, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("math game: tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	scores, err := q.ListMathGameScores(ctx, MaxListedMathGameScores)
	if err != nil {
		return nil, fmt.Errorf("math game: list: %w", err)
	}
	if scores == nil {
		scores = []models.MathGameScore{}
	}
	return scores, nil
}
