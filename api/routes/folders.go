package routes

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/routes/services"
	"apollo-sfs.com/api/sanitize"
)

// ── ListFolders ───────────────────────────────────────────────────────────────

// ListFolders handles GET /api/v1/folders.
// Returns the virtual root: top-level subfolders (parent_id IS NULL) and
// root-level files for the authenticated user.
//
// Query params:
//
//	folder_cursor, folder_limit — pagination for the subfolders list
//	file_cursor,   file_limit   — pagination for the files list
func (h *Handler) ListFolders(c *gin.Context) {
	userID, _ := uuid.Parse(c.GetString("userID"))

	contents, err := h.folders.ListRoot(
		c.Request.Context(),
		userID,
		parsePage(c, "folder"),
		parsePage(c, "file"),
	)
	if err != nil {
		log.Printf("ListFolders: userID=%s err=%v", c.GetString("userID"), err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list root contents"})
		return
	}

	c.JSON(http.StatusOK, contents)
}

// ── GetFolder ─────────────────────────────────────────────────────────────────

// GetFolder handles GET /api/v1/folders/:folder_id.
// Returns the folder's own metadata plus its direct children (subfolders and
// files), each independently paginated.
//
// Query params: folder_cursor, folder_limit, file_cursor, file_limit.
func (h *Handler) GetFolder(c *gin.Context) {
	folderID, err := uuid.Parse(c.Param("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid folder_id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))

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

// ── GetFolderAncestors ────────────────────────────────────────────────────────

// GetFolderAncestors handles GET /api/v1/folders/:folder_id/ancestors.
// Returns the breadcrumb chain from root → leaf as a flat array. Used by
// the frontend FolderBreadcrumb component.
func (h *Handler) GetFolderAncestors(c *gin.Context) {
	folderID, err := uuid.Parse(c.Param("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid folder_id"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))
	chain, err := h.folders.GetAncestors(c.Request.Context(), folderID, userID)
	if err != nil {
		log.Printf("GetFolderAncestors: folder=%s user=%s err=%v", folderID, userID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve ancestors"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ancestors": chain})
}

// ── CreateFolder ──────────────────────────────────────────────────────────────

type createFolderRequest struct {
	Name     string  `json:"name"      binding:"required,max=255"`
	ParentID *string `json:"parent_id"` // omit or null → root
	Kind     string  `json:"kind"`      // "regular" (default) or "media"
	DriveID  *string `json:"drive_id"`  // omit or null → dynamic routing (default)
}

// CreateFolder handles POST /api/v1/folders.
// Body: {"name": "Documents", "parent_id": "<uuid>|null", "drive_id": "<uuid>|null"}.
// Omitting parent_id creates a root-level folder. Omitting drive_id leaves the
// folder's uploads on the existing dynamic primary-first/least-full routing.
func (h *Handler) CreateFolder(c *gin.Context) {
	var req createFolderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}

	req.Name = sanitize.Name(req.Name, 255)
	if req.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name must not be blank"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	var parentID *uuid.UUID
	if req.ParentID != nil && *req.ParentID != "" {
		pid, err := uuid.Parse(*req.ParentID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "parent_id must be a valid UUID"})
			return
		}
		parentID = &pid
	}

	var driveID *uuid.UUID
	if req.DriveID != nil && *req.DriveID != "" {
		did, err := uuid.Parse(*req.DriveID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "drive_id must be a valid UUID"})
			return
		}
		driveID = &did
	}

	folder, err := h.folders.Create(c.Request.Context(), userID, parentID, req.Name, req.Kind, username, driveID)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrFolderNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "parent folder not found"})
		case errors.Is(err, services.ErrDuplicateFolderName):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrDriveNotAllocated):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create folder"})
		}
		return
	}

	h.logAudit(db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         "folder_created",
		ResourceType:   strPtr("folder"),
		ResourceID:     &folder.ID,
		ResourceName:   &folder.Name,
	})

	c.JSON(http.StatusCreated, folder)
}

// ── UpdateFolder ──────────────────────────────────────────────────────────────

type updateFolderRequest struct {
	Name string `json:"name" binding:"required,max=255"`
}

// UpdateFolder handles PATCH /api/v1/folders/:folder_id.
// Body: {"name": "New Name"}.
func (h *Handler) UpdateFolder(c *gin.Context) {
	folderID, err := uuid.Parse(c.Param("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid folder_id"})
		return
	}

	var req updateFolderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}

	req.Name = sanitize.Name(req.Name, 255)
	if req.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name must not be blank"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))

	updated, err := h.folders.Rename(c.Request.Context(), folderID, userID, req.Name)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrFolderNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
		case errors.Is(err, services.ErrDuplicateFolderName):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not rename folder"})
		}
		return
	}

	username := c.GetString("username")
	h.logAudit(db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         "folder_renamed",
		ResourceType:   strPtr("folder"),
		ResourceID:     &folderID,
		ResourceName:   &updated.Name,
	})

	c.JSON(http.StatusOK, updated)
}

// ── MoveFolder ────────────────────────────────────────────────────────────────

type moveFolderRequest struct {
	TargetFolderID string `json:"target_folder_id" binding:"required"`
}

// MoveFolder handles PATCH /api/v1/folders/:folder_id/move.
// Body: {"target_folder_id": "<uuid>"}.
// Reparents the folder under the target. Returns 409 if a cycle would result
// or a sibling with the same name already exists in the target.
func (h *Handler) MoveFolder(c *gin.Context) {
	folderID, err := uuid.Parse(c.Param("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid folder_id"})
		return
	}

	var req moveFolderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "target_folder_id is required"})
		return
	}
	targetID, err := uuid.Parse(req.TargetFolderID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "target_folder_id must be a valid UUID"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))

	updated, err := h.folders.Move(c.Request.Context(), folderID, targetID, userID)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrFolderNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
		case errors.Is(err, services.ErrFolderCycle):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrDuplicateFolderName):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not move folder"})
		}
		return
	}

	c.JSON(http.StatusOK, updated)
}

// ── DeleteFolder ──────────────────────────────────────────────────────────────

// DeleteFolder handles DELETE /api/v1/folders/:folder_id.
// Returns 409 Conflict if the folder still contains files or subfolders.
// The client must delete all children before deleting the parent.
func (h *Handler) DeleteFolder(c *gin.Context) {
	folderID, err := uuid.Parse(c.Param("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid folder_id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))

	if err := h.folders.Delete(c.Request.Context(), folderID, userID); err != nil {
		switch {
		case errors.Is(err, services.ErrFolderNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
		case errors.Is(err, services.ErrFolderNotEmpty):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete folder"})
		}
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "folder deleted"})
}

// ── RequestFolderDriveMigration ───────────────────────────────────────────────

type requestFolderDriveMigrationRequest struct {
	DriveID string `json:"drive_id" binding:"required"`
}

// RequestFolderDriveMigration handles POST /api/v1/folders/:folder_id/drive-migrations.
// Body: {"drive_id": "<uuid>"}.
// Moves the folder's direct files (not recursively into subfolders) onto the
// given drive as a background job and returns the created tracking row
// immediately. Returns 400 if drive_id is not one of the user's allocations,
// 409 if a migration for this folder is already pending/in_progress, and 429
// if the folder has hit the rolling rate limit.
func (h *Handler) RequestFolderDriveMigration(c *gin.Context) {
	folderID, err := uuid.Parse(c.Param("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid folder_id"})
		return
	}

	var req requestFolderDriveMigrationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "drive_id is required"})
		return
	}
	driveID, err := uuid.Parse(req.DriveID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "drive_id must be a valid UUID"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	migration, err := h.files.RequestDriveMigration(c.Request.Context(), userID, username, folderID, driveID)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrFolderNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
		case errors.Is(err, services.ErrDriveNotAllocated):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrMigrationAlreadyRunning):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrMigrationRateLimited):
			c.JSON(http.StatusTooManyRequests, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start storage change"})
		}
		return
	}

	h.logAudit(db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         "folder_drive_migration_requested",
		ResourceType:   strPtr("folder"),
		ResourceID:     &folderID,
	})

	c.JSON(http.StatusAccepted, migration)
}

// ── GetLatestFolderDriveMigration ─────────────────────────────────────────────

// GetLatestFolderDriveMigration handles GET /api/v1/folders/:folder_id/drive-migrations/latest.
// Returns the folder's most recent migration row (if any) plus eligibility
// info (recent_count, limit, window_days, next_eligible_at), so the frontend
// can show/disable the "change" action without a second round trip.
func (h *Handler) GetLatestFolderDriveMigration(c *gin.Context) {
	folderID, err := uuid.Parse(c.Param("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid folder_id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))

	status, err := h.files.GetLatestDriveMigration(c.Request.Context(), userID, folderID)
	if err != nil {
		if errors.Is(err, services.ErrFolderNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve storage-change status"})
		return
	}

	c.JSON(http.StatusOK, status)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// parsePage reads ?{prefix}_cursor and ?{prefix}_limit from the query string
// and returns a PageInput.
// A limit of exactly 0 sets Skip=true (caller signals this list is exhausted).
// Unknown or negative limits are left at 0 (service applies DefaultPageLimit).
func parsePage(c *gin.Context, prefix string) db.PageInput {
	p := db.PageInput{
		Cursor: strings.TrimSpace(c.Query(prefix + "_cursor")),
	}
	if raw := c.Query(prefix + "_limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			switch {
			case n == 0:
				p.Skip = true
			case n > 0:
				p.Limit = n
			}
		}
	}
	return p
}
