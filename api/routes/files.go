package routes

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/routes/services"
)

// ── Upload ────────────────────────────────────────────────────────────────────

type uploadResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	MimeType  string `json:"mime_type"`
	SizeBytes int64  `json:"size_bytes"`
	FolderID  string `json:"folder_id"`
}

// UploadFile handles POST /api/v1/files/upload.
// Expects a multipart form with:
//   - "file"      — the binary file field
//   - "folder_id" — UUID of the destination folder
//   - "name"      — optional display name; defaults to the original filename
func (h *Handler) UploadFile(c *gin.Context) {
	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file field is required"})
		return
	}

	folderID, err := uuid.Parse(c.PostForm("folder_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
		return
	}

	name := c.PostForm("name")
	if name == "" {
		name = fileHeader.Filename
	}

	src, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not read uploaded file"})
		return
	}
	defer src.Close()

	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	// Client-provided Content-Type is a hint; the service re-detects from content.
	file, err := h.files.Upload(c.Request.Context(), services.UploadInput{
		Username: username,
		UserID:   userID,
		FolderID: folderID,
		Name:     name,
		MimeType: fileHeader.Header.Get("Content-Type"),
		Reader:   src,
	})
	if err != nil {
		if errors.Is(err, services.ErrQuotaExceeded) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, services.ErrDuplicateName) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upload failed"})
		return
	}

	c.JSON(http.StatusCreated, uploadResponse{
		ID:        file.ID.String(),
		Name:      file.Name,
		MimeType:  file.MimeType,
		SizeBytes: file.SizeBytes,
		FolderID:  file.FolderID.String(),
	})
}

// ── Get metadata ──────────────────────────────────────────────────────────────

// GetFile handles GET /api/v1/files/:file_id.
// Returns the file metadata (name, type, size, timestamps) without content.
func (h *Handler) GetFile(c *gin.Context) {
	fileID, err := uuid.Parse(c.Param("file_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))

	file, err := h.files.GetMetadata(c.Request.Context(), fileID, userID)
	if err != nil {
		if errors.Is(err, services.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve file"})
		return
	}

	c.JSON(http.StatusOK, file)
}

// ── Download ──────────────────────────────────────────────────────────────────

// DownloadFile handles GET /api/v1/files/:file_id/download.
// Decrypts the blob and streams it to the client with Content-Disposition: attachment.
func (h *Handler) DownloadFile(c *gin.Context) {
	h.serveDecrypted(c, false)
}

// PreviewFile handles GET /api/v1/files/:file_id/preview.
// Same as DownloadFile but uses Content-Disposition: inline so the browser
// renders supported types (images, PDFs) directly.
func (h *Handler) PreviewFile(c *gin.Context) {
	h.serveDecrypted(c, true)
}

// serveDecrypted is shared by DownloadFile and PreviewFile.
// inline=true → Content-Disposition: inline; inline=false → attachment.
func (h *Handler) serveDecrypted(c *gin.Context, inline bool) {
	fileID, err := uuid.Parse(c.Param("file_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	file, plaintext, err := h.files.Download(c.Request.Context(), fileID, userID, username)
	if err != nil {
		if errors.Is(err, services.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve file"})
		return
	}

	if inline {
		c.Header("Content-Disposition", "inline")
	} else {
		c.Header("Content-Disposition",
			fmt.Sprintf(`attachment; filename="%s"`, file.Name))
	}

	c.Data(http.StatusOK, file.MimeType, plaintext)
}

// ── Update ────────────────────────────────────────────────────────────────────

type updateFileRequest struct {
	Name string `json:"name" binding:"required"`
}

// UpdateFile handles PATCH /api/v1/files/:file_id.
// Renames the file. Body: {"name": "new name"}.
func (h *Handler) UpdateFile(c *gin.Context) {
	fileID, err := uuid.Parse(c.Param("file_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file id"})
		return
	}

	var req updateFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))

	updated, err := h.files.Rename(c.Request.Context(), fileID, userID, req.Name)
	if err != nil {
		if errors.Is(err, services.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not rename file"})
		return
	}

	c.JSON(http.StatusOK, updated)
}

// ── Delete ────────────────────────────────────────────────────────────────────

// DeleteFile handles DELETE /api/v1/files/:file_id.
// Removes the encrypted blob from MinIO and the metadata row from the DB.
func (h *Handler) DeleteFile(c *gin.Context) {
	fileID, err := uuid.Parse(c.Param("file_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	if err := h.files.Delete(c.Request.Context(), fileID, userID, username); err != nil {
		if errors.Is(err, services.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete file"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "file deleted"})
}
