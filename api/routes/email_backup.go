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
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// The email backup feature stores messages from an external mail provider
// (Gmail / Microsoft) as regular encrypted files inside a dedicated folder of
// kind "email" whose name is the backed-up address. Provider OAuth happens
// entirely client-side (mirroring the Google Drive/Photos backup) — the
// browser fetches each message from the provider and posts it here; the
// server never sees provider tokens.

// SetEmailBackupService installs the email backup service on an existing
// Handler. Wired from main once the service is constructed; nil is tolerated
// and causes the email-backup endpoints to return 503 (configured, not crash).
func SetEmailBackupService(h *Handler, svc *services.EmailBackupService) {
	h.emailBackup = svc
}

func (h *Handler) emailBackupOr503(c *gin.Context) *services.EmailBackupService {
	if h.emailBackup == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "email backup is not configured"})
		return nil
	}
	return h.emailBackup
}

// ── Ensure folder ─────────────────────────────────────────────────────────────

type ensureEmailBackupFolderRequest struct {
	EmailAddress string  `json:"email_address" binding:"required,max=320"`
	DriveID      *string `json:"drive_id"` // omit or null → dynamic routing (default)
}

// EnsureEmailBackupFolder handles POST /api/v1/email-backup/folders.
// Body: {"email_address": "user@example.com", "drive_id": "<uuid>|null"}.
// Returns the root-level backup folder for the address, creating it (kind
// "email", uploads pinned to drive_id) when missing — 201 on create, 200 when
// it already existed (the existing drive pin is kept).
func (h *Handler) EnsureEmailBackupFolder(c *gin.Context) {
	svc := h.emailBackupOr503(c)
	if svc == nil {
		return
	}

	var req ensureEmailBackupFolderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email_address is required"})
		return
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

	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	folder, created, err := svc.EnsureFolder(c.Request.Context(), userID, username, req.EmailAddress, driveID)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrInvalidEmailAddress):
			c.JSON(http.StatusBadRequest, gin.H{"error": "email_address must be a valid email address"})
		case errors.Is(err, services.ErrDuplicateFolderName):
			c.JSON(http.StatusConflict, gin.H{"error": "a folder with this name already exists in your root directory"})
		case errors.Is(err, services.ErrDriveNotAllocated):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		default:
			log.Printf("EnsureEmailBackupFolder: user=%s err=%v", username, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create email backup folder"})
		}
		return
	}

	if created {
		h.logAudit(db.AuditInput{
			TargetUsername: username,
			ActorUsername:  username,
			Action:         "email_backup_folder_created",
			ResourceType:   strPtr("folder"),
			ResourceID:     &folder.ID,
			ResourceName:   &folder.Name,
		})
	}

	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	c.JSON(status, gin.H{"folder": folder, "created": created})
}

// ── Backup one message ────────────────────────────────────────────────────────

type backupEmailMessageRequest struct {
	FolderID          string             `json:"folder_id" binding:"required"`
	Provider          string             `json:"provider" binding:"required"`
	ProviderMessageID string             `json:"provider_message_id" binding:"required,max=1024"`
	Snippet           string             `json:"snippet"`
	Starred           bool               `json:"starred"`
	Message           models.StoredEmail `json:"message" binding:"required"`
}

// BackupEmailMessage handles POST /api/v1/email-backup/messages.
// Stores one provider message as an encrypted file in the backup folder plus
// its index row. Responses: 201 stored, 409 already backed up, 413 quota
// exceeded, 507 pinned drive unavailable.
func (h *Handler) BackupEmailMessage(c *gin.Context) {
	svc := h.emailBackupOr503(c)
	if svc == nil {
		return
	}

	var req backupEmailMessageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id, provider, provider_message_id, and message are required"})
		return
	}
	folderID, err := uuid.Parse(req.FolderID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	row, err := svc.BackupMessage(c.Request.Context(), services.EmailBackupMessageInput{
		Username:          username,
		UserID:            userID,
		FolderID:          folderID,
		Provider:          strings.ToLower(strings.TrimSpace(req.Provider)),
		ProviderMessageID: req.ProviderMessageID,
		Snippet:           req.Snippet,
		Starred:           req.Starred,
		Message:           req.Message,
	})
	if err != nil {
		switch {
		case errors.Is(err, services.ErrFolderNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
		case errors.Is(err, services.ErrNotEmailBackupFolder):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrInvalidEmailProvider):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrDuplicateEmailBackup):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrQuotaExceeded):
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrDriveUnavailable):
			c.JSON(http.StatusInsufficientStorage, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrDuplicateName):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		default:
			log.Printf("BackupEmailMessage: user=%s folder=%s err=%v", username, folderID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not back up email"})
		}
		return
	}

	c.JSON(http.StatusCreated, row)
}

// ── Viewer: senders / list / detail / read / delete ──────────────────────────

// ListEmailBackupSenders handles GET /api/v1/email-backup/folders/:folder_id/senders.
// Returns the folder's distinct senders with total and unread counts — the
// user-side analogue of the admin panel's workers sidebar.
func (h *Handler) ListEmailBackupSenders(c *gin.Context) {
	svc := h.emailBackupOr503(c)
	if svc == nil {
		return
	}
	folderID, err := uuid.Parse(c.Param("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid folder_id"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))

	senders, err := svc.ListSenders(c.Request.Context(), folderID, userID)
	if err != nil {
		h.emailBackupFolderError(c, err, folderID)
		return
	}
	c.JSON(http.StatusOK, gin.H{"senders": senders})
}

// ListEmailBackupMessages handles GET /api/v1/email-backup/folders/:folder_id/messages.
// Query params: sender (exact from_addr filter), cursor, limit.
func (h *Handler) ListEmailBackupMessages(c *gin.Context) {
	svc := h.emailBackupOr503(c)
	if svc == nil {
		return
	}
	folderID, err := uuid.Parse(c.Param("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid folder_id"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))

	pageIn := db.PageInput{Cursor: strings.TrimSpace(c.Query("cursor"))}
	if raw := c.Query("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be a positive integer"})
			return
		}
		pageIn.Limit = n
	}

	page, err := svc.ListMessages(c.Request.Context(), folderID, userID, c.Query("sender"), pageIn)
	if err != nil {
		h.emailBackupFolderError(c, err, folderID)
		return
	}
	c.JSON(http.StatusOK, page)
}

// GetEmailBackupMessage handles GET /api/v1/email-backup/messages/:id.
// Returns the index row plus the decrypted full message body.
func (h *Handler) GetEmailBackupMessage(c *gin.Context) {
	svc := h.emailBackupOr503(c)
	if svc == nil {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid message id"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	detail, err := svc.GetMessage(c.Request.Context(), id, userID, username)
	if err != nil {
		if errors.Is(err, services.ErrEmailBackupMessageNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "email not found"})
			return
		}
		log.Printf("GetEmailBackupMessage: user=%s id=%s err=%v", username, id, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load email"})
		return
	}
	c.JSON(http.StatusOK, detail)
}

// MarkEmailBackupMessageRead handles PATCH /api/v1/email-backup/messages/:id/read.
func (h *Handler) MarkEmailBackupMessageRead(c *gin.Context) {
	svc := h.emailBackupOr503(c)
	if svc == nil {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid message id"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))

	if err := svc.MarkRead(c.Request.Context(), id, userID); err != nil {
		if errors.Is(err, services.ErrEmailBackupMessageNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "email not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not mark email read"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "email marked read"})
}

// DeleteEmailBackupMessage handles DELETE /api/v1/email-backup/messages/:id.
// Removes the backing encrypted file (freeing quota) and the index row.
func (h *Handler) DeleteEmailBackupMessage(c *gin.Context) {
	svc := h.emailBackupOr503(c)
	if svc == nil {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid message id"})
		return
	}
	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	if err := svc.DeleteMessage(c.Request.Context(), id, userID, username); err != nil {
		if errors.Is(err, services.ErrEmailBackupMessageNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "email not found"})
			return
		}
		log.Printf("DeleteEmailBackupMessage: user=%s id=%s err=%v", username, id, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete email"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "email deleted"})
}

// ── Run completion ────────────────────────────────────────────────────────────

type completeEmailBackupRunRequest struct {
	FolderID     *string `json:"folder_id"`
	EmailAddress string  `json:"email_address" binding:"required,max=320"`
	Provider     string  `json:"provider" binding:"required"`
	Uploaded     int     `json:"uploaded"`
	Duplicates   int     `json:"duplicates"`
	Errors       int     `json:"errors"`
	Notify       bool    `json:"notify"`
}

// CompleteEmailBackupRun handles POST /api/v1/email-backup/runs.
// Records a finished backup run; when notify is true the run surfaces in the
// notification bell as an "email backup completed" item.
func (h *Handler) CompleteEmailBackupRun(c *gin.Context) {
	svc := h.emailBackupOr503(c)
	if svc == nil {
		return
	}

	var req completeEmailBackupRunRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "email_address and provider are required"})
		return
	}

	var folderID *uuid.UUID
	if req.FolderID != nil && *req.FolderID != "" {
		fid, err := uuid.Parse(*req.FolderID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
			return
		}
		folderID = &fid
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	run, err := svc.CompleteRun(c.Request.Context(), services.CompleteRunInput{
		Username:     username,
		UserID:       userID,
		FolderID:     folderID,
		EmailAddress: req.EmailAddress,
		Provider:     strings.ToLower(strings.TrimSpace(req.Provider)),
		Uploaded:     req.Uploaded,
		Duplicates:   req.Duplicates,
		Errors:       req.Errors,
		Notify:       req.Notify,
	})
	if err != nil {
		switch {
		case errors.Is(err, services.ErrInvalidEmailAddress):
			c.JSON(http.StatusBadRequest, gin.H{"error": "email_address must be a valid email address"})
		case errors.Is(err, services.ErrInvalidEmailProvider):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		default:
			log.Printf("CompleteEmailBackupRun: user=%s err=%v", username, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not record backup run"})
		}
		return
	}
	c.JSON(http.StatusCreated, run)
}

// emailBackupFolderError maps the shared folder-scoped service errors.
func (h *Handler) emailBackupFolderError(c *gin.Context, err error, folderID uuid.UUID) {
	switch {
	case errors.Is(err, services.ErrFolderNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
	case errors.Is(err, services.ErrNotEmailBackupFolder):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	default:
		log.Printf("email backup: folder=%s err=%v", folderID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load email backup folder"})
	}
}
