package routes

import (
	"errors"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// saveMathScoreRequest is the body of POST /api/v1/math-game/scores.
type saveMathScoreRequest struct {
	Score      int   `json:"score"       binding:"min=0"`
	Total      int   `json:"total"       binding:"required,min=1"`
	DurationMs int64 `json:"duration_ms" binding:"min=0"`
}

// listMathScoresResponse wraps the user's score history so the payload has a
// stable top-level shape.
type listMathScoresResponse struct {
	Scores []models.MathGameScore `json:"scores"`
}

// ListMathScores handles GET /api/v1/math-game/scores.
// Returns the authenticated user's recent games, newest first.
func (h *Handler) ListMathScores(c *gin.Context) {
	if h.mathGame == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "math game not configured"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))

	scores, err := h.mathGame.List(c.Request.Context(), userID)
	if err != nil {
		log.Printf("ListMathScores: userID=%s err=%v", c.GetString("userID"), err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve scores"})
		return
	}
	c.JSON(http.StatusOK, listMathScoresResponse{Scores: scores})
}

// SaveMathScore handles POST /api/v1/math-game/scores.
// Records one completed game for the authenticated user.
func (h *Handler) SaveMathScore(c *gin.Context) {
	if h.mathGame == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "math game not configured"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))

	var req saveMathScoreRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	score, err := h.mathGame.Add(c.Request.Context(), userID, services.AddInput{
		Score:      req.Score,
		Total:      req.Total,
		DurationMs: req.DurationMs,
	})
	if err != nil {
		switch {
		case errors.Is(err, services.ErrInvalidScore):
			c.JSON(http.StatusBadRequest, gin.H{"error": "score must be between 0 and total"})
		default:
			log.Printf("SaveMathScore: userID=%s err=%v", c.GetString("userID"), err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save score"})
		}
		return
	}

	username := c.GetString("username")
	h.logAudit(db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         "math_game_score_recorded",
		ResourceType:   strPtr("math_game_score"),
		ResourceID:     &score.ID,
	})
	c.JSON(http.StatusCreated, score)
}
