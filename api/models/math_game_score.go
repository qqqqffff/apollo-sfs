package models

import (
	"time"

	"github.com/google/uuid"
)

// MathGameScore mirrors a row in the `math_game_scores` table: one completed
// game of the /math-game mental-math test for a single user. Score is the
// number of correct answers out of Total; DurationMs is the wall-clock time
// the player took to finish the game.
type MathGameScore struct {
	ID         uuid.UUID `json:"id" db:"id"`
	Username   string    `json:"username" db:"username"`
	Score      int       `json:"score" db:"score"`
	Total      int       `json:"total" db:"total"`
	DurationMs int64     `json:"duration_ms" db:"duration_ms"`
	CreatedAt  time.Time `json:"created_at" db:"created_at"`
}
