package routes

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
	"apollo-sfs.com/api/sanitize"
)

// Search handles GET /api/v1/search?q=&folder_cursor=&file_cursor=&folder_limit=&file_limit=
//
// Returns a page of folders and files owned by the authenticated user whose
// names contain the query term (case-insensitive). Both lists are independently
// paginated using the same cursor scheme as the folder listing endpoints.
// Passing folder_limit=0 or file_limit=0 skips that list entirely, allowing the
// client to advance one list independently once the other is exhausted.
func (h *Handler) Search(c *gin.Context) {
	q := sanitize.String(strings.TrimSpace(c.Query("q")))
	if q == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "q is required"})
		return
	}
	if len(q) > 200 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "q must be 200 characters or fewer"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	folderPage := parsePage(c, "folder")
	filePage := parsePage(c, "file")

	var subfolders *db.PageResult[models.Folder]
	if folderPage.Skip {
		subfolders = &db.PageResult[models.Folder]{Items: []models.Folder{}}
	} else {
		var err error
		subfolders, err = h.queries.SearchFoldersByUser(c.Request.Context(), userID, q, folderPage)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "search failed"})
			return
		}
	}

	var files *db.PageResult[models.File]
	if filePage.Skip {
		files = &db.PageResult[models.File]{Items: []models.File{}}
	} else {
		var err error
		files, err = h.queries.SearchFilesByUser(c.Request.Context(), userID, q, filePage)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "search failed"})
			return
		}
	}

	c.JSON(http.StatusOK, services.FolderContents{
		Folder:     nil,
		Subfolders: subfolders,
		Files:      files,
	})
}
