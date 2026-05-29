package routes

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/routes/services"
)

// ── Media collection listing ───────────────────────────────────────────────

// parseMediaSort maps the ?sort query param to a db.MediaSort (default taken_at).
func parseMediaSort(c *gin.Context) db.MediaSort {
	switch c.Query("sort") {
	case "created_at":
		return db.MediaSortCreated
	case "name":
		return db.MediaSortName
	default:
		return db.MediaSortTakenAt
	}
}

// parseHiddenFilter maps the ?hidden query param to a db.HiddenFilter.
// "show" includes hidden files; "only" returns just hidden files; default excludes.
func parseHiddenFilter(c *gin.Context) db.HiddenFilter {
	switch c.Query("hidden") {
	case "show":
		return db.HiddenInclude
	case "only":
		return db.HiddenOnly
	default:
		return db.HiddenExclude
	}
}

// GetMediaFolder handles GET /api/v1/folders/:folder_id/media.
// Returns a media collection's subcollections and its media files (physical
// residents plus pointers), ordered by ?sort and filtered by ?hidden.
func (h *Handler) GetMediaFolder(c *gin.Context) {
	folderID, err := uuid.Parse(c.Param("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid folder_id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))

	contents, err := h.folders.GetMediaContents(
		c.Request.Context(),
		folderID, userID,
		parseMediaSort(c),
		parseHiddenFilter(c),
		parsePage(c, "folder"),
		parsePage(c, "file"),
	)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrFolderNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
		case errors.Is(err, services.ErrNotMediaCollection):
			c.JSON(http.StatusBadRequest, gin.H{"error": "folder is not a media collection"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve media collection"})
		}
		return
	}

	c.JSON(http.StatusOK, contents)
}

// ── Hide / unhide ──────────────────────────────────────────────────────────

// HideFile handles PATCH /api/v1/files/:file_id/hide.
func (h *Handler) HideFile(c *gin.Context) { h.setFileHidden(c, true) }

// UnhideFile handles PATCH /api/v1/files/:file_id/unhide.
func (h *Handler) UnhideFile(c *gin.Context) { h.setFileHidden(c, false) }

func (h *Handler) setFileHidden(c *gin.Context, hidden bool) {
	fileID, err := uuid.Parse(c.Param("file_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))

	updated, err := h.files.SetHidden(c.Request.Context(), fileID, userID, hidden)
	if err != nil {
		if errors.Is(err, services.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update file"})
		return
	}

	c.JSON(http.StatusOK, updated)
}

// ── Subcollection pointers ─────────────────────────────────────────────────

// CopyFileToCollection handles POST /api/v1/collections/:collection_id/items/:file_id.
// Adds a pointer placing the file into the subcollection without moving it.
func (h *Handler) CopyFileToCollection(c *gin.Context) {
	collectionID, fileID, ok := parseCollectionAndFile(c)
	if !ok {
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))

	err := h.folders.CopyToSubcollection(c.Request.Context(), userID, collectionID, fileID)
	if err != nil {
		writeCollectionItemError(c, err)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"message": "added to collection"})
}

// RemoveFileFromCollection handles DELETE /api/v1/collections/:collection_id/items/:file_id.
func (h *Handler) RemoveFileFromCollection(c *gin.Context) {
	collectionID, fileID, ok := parseCollectionAndFile(c)
	if !ok {
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))

	if err := h.folders.RemoveFromSubcollection(c.Request.Context(), userID, collectionID, fileID); err != nil {
		writeCollectionItemError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "removed from collection"})
}

type moveCollectionItemRequest struct {
	TargetCollectionID string `json:"target_collection_id" binding:"required"`
}

// MoveCollectionItem handles PATCH /api/v1/collections/:collection_id/items/:file_id/move.
// Body: {"target_collection_id": "<uuid>"}. Repoints the file to another subcollection.
func (h *Handler) MoveCollectionItem(c *gin.Context) {
	collectionID, fileID, ok := parseCollectionAndFile(c)
	if !ok {
		return
	}

	var req moveCollectionItemRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "target_collection_id is required"})
		return
	}
	targetID, err := uuid.Parse(req.TargetCollectionID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "target_collection_id must be a valid UUID"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))

	if err := h.folders.MoveSubcollectionItem(c.Request.Context(), userID, fileID, collectionID, targetID); err != nil {
		writeCollectionItemError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "moved to collection"})
}

// parseCollectionAndFile parses the collection_id and file_id path params,
// writing a 400 and returning ok=false on failure.
func parseCollectionAndFile(c *gin.Context) (collectionID, fileID uuid.UUID, ok bool) {
	collectionID, err := uuid.Parse(c.Param("collection_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid collection_id"})
		return uuid.Nil, uuid.Nil, false
	}
	fileID, err = uuid.Parse(c.Param("file_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file_id"})
		return uuid.Nil, uuid.Nil, false
	}
	return collectionID, fileID, true
}

// writeCollectionItemError maps service errors to HTTP responses.
func writeCollectionItemError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, services.ErrFolderNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "collection not found"})
	case errors.Is(err, services.ErrNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
	case errors.Is(err, services.ErrNotMediaCollection):
		c.JSON(http.StatusBadRequest, gin.H{"error": "folder is not a media collection"})
	case errors.Is(err, services.ErrDuplicateFolderName):
		c.JSON(http.StatusConflict, gin.H{"error": "already in that collection"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update collection"})
	}
}

// ── User preferences ───────────────────────────────────────────────────────

// GetPreferences handles GET /api/v1/me/preferences.
func (h *Handler) GetPreferences(c *gin.Context) {
	username := c.GetString("username")
	prefs, err := h.queries.GetUserPreferences(c.Request.Context(), username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load preferences"})
		return
	}
	c.JSON(http.StatusOK, prefs)
}

type updatePreferencesRequest struct {
	// MediaAutouploadFolderID: a media folder UUID to enable auto-upload, or null
	// to disable it. The field must be present in the body.
	MediaAutouploadFolderID *string `json:"media_autoupload_folder_id"`
}

// UpdatePreferences handles PUT /api/v1/me/preferences.
// Body: {"media_autoupload_folder_id": "<uuid>" | null}.
func (h *Handler) UpdatePreferences(c *gin.Context) {
	var req updatePreferencesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	var folderID *uuid.UUID
	if req.MediaAutouploadFolderID != nil && *req.MediaAutouploadFolderID != "" {
		fid, err := uuid.Parse(*req.MediaAutouploadFolderID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "media_autoupload_folder_id must be a valid UUID"})
			return
		}
		// Verify the folder is owned by the user and is a media collection.
		skip := db.PageInput{Skip: true}
		contents, err := h.folders.GetContents(c.Request.Context(), fid, userID, skip, skip)
		if err != nil {
			if errors.Is(err, services.ErrFolderNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not validate folder"})
			return
		}
		if contents.Folder == nil || contents.Folder.Kind != "media" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "auto-upload target must be a media collection"})
			return
		}
		folderID = &fid
	}

	prefs, err := h.queries.SetMediaAutouploadFolder(c.Request.Context(), username, folderID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save preferences"})
		return
	}
	c.JSON(http.StatusOK, prefs)
}
