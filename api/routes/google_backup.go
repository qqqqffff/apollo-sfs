package routes

import (
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// Google Drive/Photos backup is otherwise entirely client-side (OAuth and
// file fetching happen in the browser, uploads go through the normal
// /files/upload endpoint) — this is the one endpoint it needs server-side,
// to log a completed run so the "notify me when complete" setting can
// surface a bell item, mirroring email backup's /email-backup/runs.

type completeGoogleBackupRunRequest struct {
	Uploaded   int  `json:"uploaded"`
	Duplicates int  `json:"duplicates"`
	Errors     int  `json:"errors"`
	Notify     bool `json:"notify"`
}

// CompleteGoogleBackupRun handles POST /api/v1/google-backup/runs.
func (h *Handler) CompleteGoogleBackupRun(c *gin.Context) {
	var req completeGoogleBackupRunRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}

	userID, err := uuid.Parse(c.GetString("userID"))
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid user"})
		return
	}
	username := c.GetString("username")

	run := &models.GoogleBackupRun{
		ID:          uuid.New(),
		Username:    username,
		UserID:      userID,
		Uploaded:    req.Uploaded,
		Duplicates:  req.Duplicates,
		Errors:      req.Errors,
		Notify:      req.Notify,
		CompletedAt: time.Now(),
	}
	if err := h.queries.InsertGoogleBackupRun(c.Request.Context(), run); err != nil {
		log.Printf("CompleteGoogleBackupRun: user=%s err=%v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not record backup run"})
		return
	}
	c.JSON(http.StatusCreated, run)
}
