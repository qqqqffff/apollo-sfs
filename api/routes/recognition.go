package routes

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
	"apollo-sfs.com/api/sanitize"
)

const maxGroupLabelLen = 80

// recognitionAvailable guards every recognition endpoint: 503 when the
// sidecar is not configured (RECOGNITION_URL unset), matching the API-key /
// share service convention of degrading rather than crashing.
func (h *Handler) recognitionAvailable(c *gin.Context) bool {
	if h.recognition == nil || !h.recognition.Available() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "recognition not configured"})
		return false
	}
	return true
}

func recognitionError(c *gin.Context, err error, fallback string) {
	switch {
	case errors.Is(err, services.ErrFolderNotFound), errors.Is(err, services.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
	case errors.Is(err, services.ErrNotMediaCollection):
		c.JSON(http.StatusBadRequest, gin.H{"error": "folder is not a media collection"})
	case errors.Is(err, services.ErrGroupKindMismatch):
		c.JSON(http.StatusBadRequest, gin.H{"error": services.ErrGroupKindMismatch.Error()})
	case errors.Is(err, services.ErrRecognitionUnavailable):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "recognition not configured"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": fallback})
	}
}

// GetCollectionRecognition handles GET /api/v1/collections/:collection_id/recognition.
// Returns the toggle state, indexing progress counts, per-kind group tallies,
// and the crop storage the feature is using (shown in the modal).
func (h *Handler) GetCollectionRecognition(c *gin.Context) {
	if !h.recognitionAvailable(c) {
		return
	}
	collectionID, err := uuid.Parse(c.Param("collection_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid collection_id"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))

	status, err := h.recognition.Status(c.Request.Context(), userID, collectionID)
	if err != nil {
		recognitionError(c, err, "could not retrieve recognition status")
		return
	}
	c.JSON(http.StatusOK, status)
}

// SetCollectionRecognition handles PUT /api/v1/collections/:collection_id/recognition.
// Body: {"enabled": bool, "purge": bool}. Enabling scans and enqueues the
// collection; disabling drops pending jobs, and with purge=true also deletes
// groups/detections/crops and refunds their bytes to the user's quota.
func (h *Handler) SetCollectionRecognition(c *gin.Context) {
	if !h.recognitionAvailable(c) {
		return
	}
	collectionID, err := uuid.Parse(c.Param("collection_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid collection_id"})
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
		Purge   bool `json:"purge"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	enqueued, freed, err := h.recognition.SetEnabled(c.Request.Context(), userID, username, collectionID, body.Enabled, body.Purge)
	if err != nil {
		recognitionError(c, err, "could not update recognition setting")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"enabled":        body.Enabled,
		"files_enqueued": enqueued,
		"freed_bytes":    freed,
	})
}

// ListRecognitionGroups handles GET /api/v1/collections/:collection_id/recognition/groups.
// Query params: kind=face|pet|object (optional), labeled=true (optional —
// only user-labeled groups, the modal's "Labeled" sub-tab).
func (h *Handler) ListRecognitionGroups(c *gin.Context) {
	if !h.recognitionAvailable(c) {
		return
	}
	collectionID, err := uuid.Parse(c.Param("collection_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid collection_id"})
		return
	}
	kind := c.Query("kind")
	switch kind {
	case "", models.RecognitionKindFace, models.RecognitionKindPet, models.RecognitionKindObject:
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid kind"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))

	groups, err := h.recognition.ListGroups(c.Request.Context(), userID, collectionID, kind, c.Query("labeled") == "true")
	if err != nil {
		recognitionError(c, err, "could not list groups")
		return
	}
	c.JSON(http.StatusOK, gin.H{"groups": groups})
}

// GetRecognitionGroupFiles handles GET /api/v1/recognition/groups/:group_id/files.
// Returns the group's files in the same paginated shape as the media listing
// so clients reuse their media tiles.
func (h *Handler) GetRecognitionGroupFiles(c *gin.Context) {
	if !h.recognitionAvailable(c) {
		return
	}
	groupID, err := uuid.Parse(c.Param("group_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid group_id"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))

	files, err := h.recognition.GroupFiles(c.Request.Context(), userID, groupID, parsePage(c, "file"))
	if err != nil {
		recognitionError(c, err, "could not list group files")
		return
	}
	c.JSON(http.StatusOK, files)
}

// UpdateRecognitionGroup handles PATCH /api/v1/recognition/groups/:group_id.
// Body: {"label": string} — empty string clears the user label.
func (h *Handler) UpdateRecognitionGroup(c *gin.Context) {
	if !h.recognitionAvailable(c) {
		return
	}
	groupID, err := uuid.Parse(c.Param("group_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid group_id"})
		return
	}
	var body struct {
		Label string `json:"label"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}
	if len(body.Label) > maxGroupLabelLen*4 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "label too long"})
		return
	}
	// Same rules as file/folder display names: trim, strip CRLF/path chars,
	// cap length. (HTML-escaping is the clients' render-time concern.)
	label := sanitize.Name(body.Label, maxGroupLabelLen)
	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	group, err := h.recognition.LabelGroup(c.Request.Context(), userID, username, groupID, label)
	if err != nil {
		recognitionError(c, err, "could not update group")
		return
	}
	c.JSON(http.StatusOK, group)
}

// MergeRecognitionGroups handles POST /api/v1/recognition/groups/:group_id/merge.
// Body: {"source_group_ids": [uuid, ...]} — the sources are folded into the
// URL group. All groups must share a kind (and species for pets).
func (h *Handler) MergeRecognitionGroups(c *gin.Context) {
	if !h.recognitionAvailable(c) {
		return
	}
	targetID, err := uuid.Parse(c.Param("group_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid group_id"})
		return
	}
	var body struct {
		SourceGroupIDs []uuid.UUID `json:"source_group_ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.SourceGroupIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "source_group_ids required"})
		return
	}
	for _, id := range body.SourceGroupIDs {
		if id == targetID {
			c.JSON(http.StatusBadRequest, gin.H{"error": "cannot merge a group into itself"})
			return
		}
	}
	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	group, err := h.recognition.MergeGroups(c.Request.Context(), userID, username, targetID, body.SourceGroupIDs)
	if err != nil {
		recognitionError(c, err, "could not merge groups")
		return
	}
	c.JSON(http.StatusOK, group)
}

// DeleteRecognitionGroup handles DELETE /api/v1/recognition/groups/:group_id.
// Removes the group and its memberships; detections are kept.
func (h *Handler) DeleteRecognitionGroup(c *gin.Context) {
	if !h.recognitionAvailable(c) {
		return
	}
	groupID, err := uuid.Parse(c.Param("group_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid group_id"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	if err := h.recognition.DeleteGroup(c.Request.Context(), userID, username, groupID); err != nil {
		recognitionError(c, err, "could not delete group")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GetRecognitionThumb handles GET /api/v1/recognition/detections/:detection_id/thumb.
// Streams the decrypted face/pet crop inline (cookie-authenticated <img>
// URL, like the file preview endpoint).
func (h *Handler) GetRecognitionThumb(c *gin.Context) {
	if !h.recognitionAvailable(c) {
		return
	}
	detectionID, err := uuid.Parse(c.Param("detection_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid detection_id"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	data, err := h.recognition.DetectionThumb(c.Request.Context(), userID, username, detectionID)
	if err != nil {
		recognitionError(c, err, "could not retrieve thumbnail")
		return
	}
	c.Header("Cache-Control", "private, max-age=3600")
	c.Data(http.StatusOK, "image/jpeg", data)
}
