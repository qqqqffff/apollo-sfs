package routes

import (
	"errors"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/routes/services"
)

// ListFavorites handles GET /api/v1/favorites.
// Returns { "files": [...], "folders": [...] } for the authenticated user.
func (h *Handler) ListFavorites(c *gin.Context) {
	userID, _ := uuid.Parse(c.GetString("userID"))

	list, err := h.favorites.List(c.Request.Context(), userID)
	if err != nil {
		log.Printf("ListFavorites: userID=%s err=%v", c.GetString("userID"), err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve favorites"})
		return
	}
	c.JSON(http.StatusOK, list)
}

// FavoriteFile handles POST /api/v1/favorites/files/:file_id.
func (h *Handler) FavoriteFile(c *gin.Context) {
	userID, _ := uuid.Parse(c.GetString("userID"))

	fileID, err := uuid.Parse(c.Param("file_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file_id must be a valid UUID"})
		return
	}

	if err := h.favorites.AddFile(c.Request.Context(), userID, fileID); err != nil {
		switch {
		case errors.Is(err, services.ErrNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
		case errors.Is(err, services.ErrAlreadyFavorited):
			c.JSON(http.StatusConflict, gin.H{"error": "file is already in favorites"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not add favorite"})
		}
		return
	}
	c.Status(http.StatusNoContent)
}

// UnfavoriteFile handles DELETE /api/v1/favorites/files/:file_id.
func (h *Handler) UnfavoriteFile(c *gin.Context) {
	userID, _ := uuid.Parse(c.GetString("userID"))

	fileID, err := uuid.Parse(c.Param("file_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file_id must be a valid UUID"})
		return
	}

	if err := h.favorites.RemoveFile(c.Request.Context(), userID, fileID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not remove favorite"})
		return
	}
	c.Status(http.StatusNoContent)
}

// FavoriteFolder handles POST /api/v1/favorites/folders/:folder_id.
func (h *Handler) FavoriteFolder(c *gin.Context) {
	userID, _ := uuid.Parse(c.GetString("userID"))

	folderID, err := uuid.Parse(c.Param("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
		return
	}

	if err := h.favorites.AddFolder(c.Request.Context(), userID, folderID); err != nil {
		switch {
		case errors.Is(err, services.ErrFolderNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
		case errors.Is(err, services.ErrAlreadyFavorited):
			c.JSON(http.StatusConflict, gin.H{"error": "folder is already in favorites"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not add favorite"})
		}
		return
	}
	c.Status(http.StatusNoContent)
}

// UnfavoriteFolder handles DELETE /api/v1/favorites/folders/:folder_id.
func (h *Handler) UnfavoriteFolder(c *gin.Context) {
	userID, _ := uuid.Parse(c.GetString("userID"))

	folderID, err := uuid.Parse(c.Param("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
		return
	}

	if err := h.favorites.RemoveFolder(c.Request.Context(), userID, folderID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not remove favorite"})
		return
	}
	c.Status(http.StatusNoContent)
}
