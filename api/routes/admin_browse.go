package routes

import (
	"database/sql"
	"errors"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/routes/services"
	"apollo-sfs.com/api/sanitize"
)

func parseUUID(c *gin.Context, param string) (uuid.UUID, error) {
	return uuid.Parse(c.Param(param))
}

// kcID resolves a username to its Keycloak UUID. In tests the resolveKcID
// override is used; in production h.auth.GetUserKcID is called.
func (h *Handler) kcID(c *gin.Context, username string) (uuid.UUID, error) {
	if h.resolveKcID != nil {
		return h.resolveKcID(c.Request.Context(), username)
	}
	return h.auth.GetUserKcID(c.Request.Context(), username)
}

// AdminListUserFolders handles GET /api/v1/admin/users/:user_id/folders.
// Returns the virtual root contents for the specified user (admin only, read-only).
func (h *Handler) AdminListUserFolders(c *gin.Context) {
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	if _, err := h.queries.GetUserByUsername(c.Request.Context(), username); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	userID, err := h.kcID(c, username)
	if err != nil {
		log.Printf("AdminListUserFolders: resolve KC ID for %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not resolve user identity"})
		return
	}

	contents, err := h.folders.ListRoot(
		c.Request.Context(),
		userID,
		parsePage(c, "folder"),
		parsePage(c, "file"),
	)
	if err != nil {
		log.Printf("AdminListUserFolders: username=%s err=%v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list folder contents"})
		return
	}

	c.JSON(http.StatusOK, contents)
}

// AdminGetUserFolder handles GET /api/v1/admin/users/:user_id/folders/:folder_id.
// Returns the folder contents for the specified user (admin only, read-only).
func (h *Handler) AdminGetUserFolder(c *gin.Context) {
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	folderID, err := parseUUID(c, "folder_id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid folder_id"})
		return
	}

	if _, err := h.queries.GetUserByUsername(c.Request.Context(), username); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	userID, err := h.kcID(c, username)
	if err != nil {
		log.Printf("AdminGetUserFolder: resolve KC ID for %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not resolve user identity"})
		return
	}

	contents, err := h.folders.GetContents(
		c.Request.Context(),
		folderID, userID,
		parsePage(c, "folder"),
		parsePage(c, "file"),
	)
	if err != nil {
		if errors.Is(err, services.ErrFolderNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve folder"})
		return
	}

	c.JSON(http.StatusOK, contents)
}

// AdminGetUserFavorites handles GET /api/v1/admin/users/:user_id/favorites.
// Returns the favorites for the specified user (admin only, read-only).
func (h *Handler) AdminGetUserFavorites(c *gin.Context) {
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	if _, err := h.queries.GetUserByUsername(c.Request.Context(), username); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	userID, err := h.kcID(c, username)
	if err != nil {
		log.Printf("AdminGetUserFavorites: resolve KC ID for %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not resolve user identity"})
		return
	}

	list, err := h.favorites.List(c.Request.Context(), userID)
	if err != nil {
		log.Printf("AdminGetUserFavorites: username=%s err=%v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve favorites"})
		return
	}

	c.JSON(http.StatusOK, list)
}
