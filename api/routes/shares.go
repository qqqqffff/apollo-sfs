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
	"apollo-sfs.com/api/sanitize"
)

// Share endpoints let a user grant another account (identified by email)
// access to one file or a folder subtree. Every endpoint here requires normal
// cookie auth — the share token alone never grants access; the caller must be
// logged in as the recipient (or the owner) before anything resolves.

// ── Create ────────────────────────────────────────────────────────────────────

type createShareRequest struct {
	FileID          *string `json:"file_id"`
	FolderID        *string `json:"folder_id"`
	RecipientEmail  string  `json:"recipient_email" binding:"required,max=320"`
	CanDownload     bool    `json:"can_download"`
	CanUpload       bool    `json:"can_upload"`
	IncludeChildren bool    `json:"include_children"`
	Notify          bool    `json:"notify"`
}

// CreateShare handles POST /api/v1/shares.
// Body: {"file_id" XOR "folder_id", "recipient_email", "can_download",
// "can_upload", "include_children", "notify"}.
// Returns the created share including its share_url.
func (h *Handler) CreateShare(c *gin.Context) {
	if h.shares == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sharing is not configured"})
		return
	}

	var req createShareRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "recipient_email is required"})
		return
	}

	in := services.CreateShareInput{
		RecipientEmail:  req.RecipientEmail,
		CanDownload:     req.CanDownload,
		CanUpload:       req.CanUpload,
		IncludeChildren: req.IncludeChildren,
		Notify:          req.Notify,
	}
	if req.FileID != nil && *req.FileID != "" {
		id, err := uuid.Parse(*req.FileID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "file_id must be a valid UUID"})
			return
		}
		in.FileID = &id
	}
	if req.FolderID != nil && *req.FolderID != "" {
		id, err := uuid.Parse(*req.FolderID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
			return
		}
		in.FolderID = &id
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	info, err := h.shares.Create(c.Request.Context(), userID, username, in)
	if err != nil {
		respondShareError(c, err, "could not create share")
		return
	}

	h.logAudit(db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         "share_created",
		ResourceType:   strPtr(info.ItemType),
		ResourceID:     shareTargetID(&info.Share),
		ResourceName:   &info.ItemName,
	})

	c.JSON(http.StatusCreated, info)
}

// ── List / revoke (owner) ─────────────────────────────────────────────────────

// ListMyShares handles GET /api/v1/shares.
// Returns the caller's active shares enriched with item metadata.
func (h *Handler) ListMyShares(c *gin.Context) {
	if h.shares == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sharing is not configured"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	infos, err := h.shares.ListByOwner(c.Request.Context(), userID)
	if err != nil {
		log.Printf("ListMyShares: user=%s err=%v", userID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list shares"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"shares": infos})
}

// ListSharedWithMe handles GET /api/v1/shares/shared-with-me.
// Returns active shares addressed to the caller's account email.
func (h *Handler) ListSharedWithMe(c *gin.Context) {
	if h.shares == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sharing is not configured"})
		return
	}

	infos, err := h.shares.ListForRecipient(c.Request.Context(), c.GetString("username"))
	if err != nil {
		log.Printf("ListSharedWithMe: user=%s err=%v", c.GetString("username"), err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list shares"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"shares": infos})
}

// RevokeShare handles DELETE /api/v1/shares/:share_id.
// Only the owner may revoke; revocation is immediate for the recipient.
func (h *Handler) RevokeShare(c *gin.Context) {
	if h.shares == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sharing is not configured"})
		return
	}

	shareID, err := uuid.Parse(c.Param("share_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid share id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	if err := h.shares.Revoke(c.Request.Context(), shareID, userID); err != nil {
		respondShareError(c, err, "could not revoke share")
		return
	}

	username := c.GetString("username")
	h.logAudit(db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         "share_revoked",
		ResourceType:   strPtr("share"),
		ResourceID:     &shareID,
	})

	c.JSON(http.StatusOK, gin.H{"message": "share revoked"})
}

// ── Resolve (recipient) ───────────────────────────────────────────────────────

// ResolveShareToken handles GET /api/v1/shares/resolve/:token.
// The landing call for a share link: verifies the logged-in caller is the
// recipient the share was addressed to (by account email) and returns the
// share with item metadata. 403 means "wrong account", 404 means missing or
// revoked.
func (h *Handler) ResolveShareToken(c *gin.Context) {
	if h.shares == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sharing is not configured"})
		return
	}

	token := c.Param("token")
	if token == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "token is required"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	info, err := h.shares.ResolveToken(c.Request.Context(), token, userID, c.GetString("username"))
	if err != nil {
		respondShareError(c, err, "could not resolve share")
		return
	}
	c.JSON(http.StatusOK, info)
}

// GetShare handles GET /api/v1/shares/:share_id.
// Returns the share with item metadata for its recipient or owner.
func (h *Handler) GetShare(c *gin.Context) {
	if h.shares == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sharing is not configured"})
		return
	}

	shareID, err := uuid.Parse(c.Param("share_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid share id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	info, err := h.shares.GetInfo(c.Request.Context(), shareID, userID, c.GetString("username"))
	if err != nil {
		respondShareError(c, err, "could not retrieve share")
		return
	}
	c.JSON(http.StatusOK, info)
}

// ── Shared content access (recipient) ─────────────────────────────────────────

// GetSharedContents handles GET /api/v1/shares/:share_id/contents.
// Lists a shared folder's children for the sharee. ?folder_id= navigates into
// a descendant (only valid when the share includes children). Pagination via
// folder_cursor/folder_limit and file_cursor/file_limit as elsewhere.
func (h *Handler) GetSharedContents(c *gin.Context) {
	share, ok := h.authorizeShare(c)
	if !ok {
		return
	}

	var subfolderID *uuid.UUID
	if raw := c.Query("folder_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
			return
		}
		subfolderID = &id
	}

	contents, err := h.shares.ContentsForShare(
		c.Request.Context(), share, subfolderID,
		parsePage(c, "folder"), parsePage(c, "file"),
	)
	if err != nil {
		respondShareError(c, err, "could not list shared folder")
		return
	}
	c.JSON(http.StatusOK, contents)
}

// GetSharedFile handles GET /api/v1/shares/:share_id/file.
// Returns metadata for the shared file, or — on folder shares — for the file
// given by ?file_id= (which must fall inside the share's scope).
func (h *Handler) GetSharedFile(c *gin.Context) {
	share, ok := h.authorizeShare(c)
	if !ok {
		return
	}

	file, err := h.resolveSharedFile(c, share)
	if err != nil {
		respondShareError(c, err, "could not retrieve file")
		return
	}
	c.JSON(http.StatusOK, file)
}

// PreviewSharedFile handles GET /api/v1/shares/:share_id/file/preview.
// Serves the decrypted file inline — viewing is always permitted on a share.
func (h *Handler) PreviewSharedFile(c *gin.Context) {
	h.serveShared(c, true)
}

// DownloadSharedFile handles GET /api/v1/shares/:share_id/file/download.
// Serves the decrypted file as an attachment. Requires the share's
// can_download permission.
func (h *Handler) DownloadSharedFile(c *gin.Context) {
	h.serveShared(c, false)
}

// serveShared authorizes the share, resolves the target file within its scope,
// and streams the decrypted bytes under the owner's identity.
func (h *Handler) serveShared(c *gin.Context, inline bool) {
	share, ok := h.authorizeShare(c)
	if !ok {
		return
	}

	if !inline && !share.CanDownload {
		respondShareError(c, services.ErrShareDownloadDisabled, "")
		return
	}

	file, err := h.resolveSharedFile(c, share)
	if err != nil {
		respondShareError(c, err, "could not retrieve file")
		return
	}

	// Decrypt as the owner: the blob is sealed under the owner's per-user key
	// and the metadata row is only visible to the owner under RLS.
	_, plaintext, err := h.files.Download(c.Request.Context(), file.ID, share.OwnerUserID, share.OwnerUsername)
	if err != nil {
		log.Printf("serveShared: share=%s file=%s err=%v", share.ID, file.ID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve file"})
		return
	}

	if !inline {
		h.logAudit(db.AuditInput{
			TargetUsername: share.OwnerUsername,
			ActorUsername:  c.GetString("username"),
			Action:         "shared_file_downloaded",
			ResourceType:   strPtr("file"),
			ResourceID:     &file.ID,
			ResourceName:   &file.Name,
		})
	}

	writePlaintext(c, file, plaintext, inline)
}

// UploadToShare handles POST /api/v1/shares/:share_id/upload.
// Multipart form identical to UploadFile ("file", optional "name", optional
// "folder_id" targeting a descendant of the shared folder). Requires the
// share's can_upload permission. The file is stored under the owner's account:
// encrypted with the owner's key and counted against the owner's quota.
func (h *Handler) UploadToShare(c *gin.Context) {
	share, ok := h.authorizeShare(c)
	if !ok {
		return
	}

	var targetFolderID *uuid.UUID
	if raw := c.PostForm("folder_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
			return
		}
		targetFolderID = &id
	}

	target, err := h.shares.UploadTargetForShare(c.Request.Context(), share, targetFolderID)
	if err != nil {
		respondShareError(c, err, "could not upload to shared folder")
		return
	}

	fileHeader, err := c.FormFile("file")
	if err != nil {
		if errors.Is(err, http.ErrMissingFile) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "file field is required"})
		} else {
			log.Printf("share upload: read multipart body: %v", err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "upload interrupted — please retry"})
		}
		return
	}

	name := sanitize.Name(c.PostForm("name"), 255)
	if name == "" {
		name = sanitize.Name(fileHeader.Filename, 255)
	}
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "could not determine a valid file name"})
		return
	}

	src, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not read uploaded file"})
		return
	}
	defer src.Close()

	// The upload runs as the owner (their key, their quota, their storage
	// routing). IgnoreRedirect keeps the file exactly where the sharee put it
	// instead of auto-routing media into the owner's auto-upload collection.
	file, err := h.files.Upload(c.Request.Context(), services.UploadInput{
		Username:       share.OwnerUsername,
		UserID:         share.OwnerUserID,
		FolderID:       &target,
		Name:           name,
		MimeType:       fileHeader.Header.Get("Content-Type"),
		IgnoreRedirect: true,
		Reader:         src,
	})
	if err != nil {
		if errors.Is(err, services.ErrQuotaExceeded) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "the owner's storage quota is full"})
			return
		}
		if errors.Is(err, services.ErrDriveUnavailable) {
			c.JSON(http.StatusInsufficientStorage, gin.H{"error": "the owner's storage has no room on their assigned drive"})
			return
		}
		if errors.Is(err, services.ErrDuplicateName) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		log.Printf("share upload: share=%s err=%v", share.ID, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upload failed"})
		return
	}

	h.logAudit(db.AuditInput{
		TargetUsername: share.OwnerUsername,
		ActorUsername:  c.GetString("username"),
		Action:         "shared_file_uploaded",
		ResourceType:   strPtr("file"),
		ResourceID:     &file.ID,
		ResourceName:   &file.Name,
	})

	var folderIDStr *string
	if file.FolderID != nil {
		s := file.FolderID.String()
		folderIDStr = &s
	}
	c.JSON(http.StatusCreated, uploadResponse{
		ID:        file.ID.String(),
		Name:      file.Name,
		MimeType:  file.MimeType,
		SizeBytes: file.SizeBytes,
		FolderID:  folderIDStr,
	})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// authorizeShare parses :share_id and verifies the caller is the share's
// recipient or owner. On failure it writes the error response and returns
// ok=false.
func (h *Handler) authorizeShare(c *gin.Context) (*models.Share, bool) {
	if h.shares == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sharing is not configured"})
		return nil, false
	}

	shareID, err := uuid.Parse(c.Param("share_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid share id"})
		return nil, false
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	share, err := h.shares.Authorize(c.Request.Context(), shareID, userID, c.GetString("username"))
	if err != nil {
		respondShareError(c, err, "could not access share")
		return nil, false
	}
	return share, true
}

// resolveSharedFile reads the optional ?file_id= parameter and delegates scope
// validation to the service.
func (h *Handler) resolveSharedFile(c *gin.Context, share *models.Share) (*models.File, error) {
	var fileID *uuid.UUID
	if raw := c.Query("file_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return nil, services.ErrNotFound
		}
		fileID = &id
	}
	return h.shares.FileForShare(c.Request.Context(), share, fileID)
}

// shareTargetID returns the shared object's ID for audit logging.
func shareTargetID(share *models.Share) *uuid.UUID {
	if share.FileID != nil {
		return share.FileID
	}
	return share.FolderID
}

// respondShareError maps share service errors onto HTTP statuses.
// fallback is the 500 message for unexpected errors ("" uses a generic one).
func respondShareError(c *gin.Context, err error, fallback string) {
	switch {
	case errors.Is(err, services.ErrShareNotFound),
		errors.Is(err, services.ErrNotFound),
		errors.Is(err, services.ErrFolderNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
	case errors.Is(err, services.ErrShareForbidden),
		errors.Is(err, services.ErrShareDownloadDisabled):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
	case errors.Is(err, services.ErrShareExists):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	case errors.Is(err, services.ErrShareTarget),
		errors.Is(err, services.ErrShareBadEmail),
		errors.Is(err, services.ErrShareSelf):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	default:
		if fallback == "" {
			fallback = "internal error"
		}
		log.Printf("share endpoint: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": fallback})
	}
}
