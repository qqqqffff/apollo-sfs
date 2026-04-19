package routes

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/routes/services"
	"apollo-sfs.com/api/sanitize"
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
			fmt.Sprintf(`attachment; filename="%s"`, sanitize.ContentDispositionFilename(file.Name)))
	}

	c.Data(http.StatusOK, file.MimeType, plaintext)
}

// ── Stream ────────────────────────────────────────────────────────────────────

// StreamFile handles GET /api/v1/files/:file_id/stream.
//
// For chunked-encrypted video files: parses the Range header, fetches only the
// MinIO chunk bytes that cover the requested range, decrypts those chunks
// concurrently, and returns a 206 Partial Content response. This means a seek
// into a large video fetches ~1–2 MiB from MinIO instead of the full file.
//
// For legacy single-blob files (or non-ranged requests on chunked files):
// decrypts the full blob and delegates to http.ServeContent which handles
// Range, 206, ETag, and all HTTP conditional headers automatically.
func (h *Handler) StreamFile(c *gin.Context) {
	fileID, err := uuid.Parse(c.Param("file_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")
	ctx := c.Request.Context()

	file, err := h.files.GetMetadata(ctx, fileID, userID)
	if err != nil {
		if errors.Is(err, services.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not stream file"})
		return
	}

	c.Writer.Header().Set("Content-Type", file.MimeType)
	c.Writer.Header().Set("Content-Disposition", "inline")
	c.Writer.Header().Set("Accept-Ranges", "bytes")

	rangeHeader := c.Request.Header.Get("Range")

	if services.IsChunked(file) && rangeHeader != "" {
		// Chunked path with a Range header: minimal MinIO fetch + concurrent decrypt.
		rangeStart, rangeEnd, ok := parseRange(rangeHeader, file.SizeBytes)
		if !ok {
			c.Writer.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", file.SizeBytes))
			c.Writer.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}

		chunk, err := h.files.DownloadRange(ctx, file, username, rangeStart, rangeEnd)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not stream range"})
			return
		}

		c.Writer.Header().Set("Content-Range",
			fmt.Sprintf("bytes %d-%d/%d", rangeStart, rangeEnd, file.SizeBytes))
		c.Writer.Header().Set("Content-Length", strconv.Itoa(len(chunk)))
		c.Writer.WriteHeader(http.StatusPartialContent)
		_, _ = c.Writer.Write(chunk)
		return
	}

	// Full-file path (no Range header, or legacy single-blob file):
	// decrypt everything concurrently then let http.ServeContent slice as needed.
	var plaintext []byte
	if services.IsChunked(file) {
		plaintext, err = h.files.DownloadChunked(ctx, file, username)
	} else {
		_, plaintext, err = h.files.Download(ctx, fileID, userID, username)
	}
	if err != nil {
		if errors.Is(err, services.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not stream file"})
		return
	}

	// http.ServeContent handles Range, 206, ETag, Last-Modified, and If-* headers.
	http.ServeContent(c.Writer, c.Request, file.Name, file.UpdatedAt, bytes.NewReader(plaintext))
}

// parseRange parses a single "bytes=start-end" Range header for a resource of
// the given size. Returns the inclusive [start, end] after clamping.
// Returns ok=false for malformed headers, unsatisfiable ranges, or multi-range
// specs (multi-range is rare for video and skipped for simplicity).
func parseRange(header string, size int64) (start, end int64, ok bool) {
	if !strings.HasPrefix(header, "bytes=") {
		return 0, 0, false
	}
	spec := strings.TrimPrefix(header, "bytes=")
	if strings.Contains(spec, ",") {
		return 0, 0, false // multi-range not supported
	}
	dash := strings.IndexByte(spec, '-')
	if dash < 0 {
		return 0, 0, false
	}
	startStr, endStr := spec[:dash], spec[dash+1:]

	if startStr == "" {
		// Suffix range: bytes=-N → last N bytes.
		n, err := strconv.ParseInt(endStr, 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, false
		}
		s := size - n
		if s < 0 {
			s = 0
		}
		return s, size - 1, true
	}

	s, err := strconv.ParseInt(startStr, 10, 64)
	if err != nil || s < 0 || s >= size {
		return 0, 0, false
	}
	if endStr == "" {
		return s, size - 1, true
	}
	e, err := strconv.ParseInt(endStr, 10, 64)
	if err != nil || e < s {
		return 0, 0, false
	}
	if e >= size {
		e = size - 1
	}
	return s, e, true
}

// ── Move ──────────────────────────────────────────────────────────────────────

type moveFileRequest struct {
	FolderID string `json:"folder_id" binding:"required"`
}

// MoveFile handles PATCH /api/v1/files/:file_id/move.
// Body: {"folder_id": "<uuid>"}.
func (h *Handler) MoveFile(c *gin.Context) {
	fileID, err := uuid.Parse(c.Param("file_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file id"})
		return
	}

	var req moveFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id is required"})
		return
	}

	targetFolderID, err := uuid.Parse(sanitize.String(req.FolderID))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))

	moved, err := h.files.Move(c.Request.Context(), fileID, userID, targetFolderID)
	if err != nil {
		if errors.Is(err, services.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		if errors.Is(err, services.ErrFolderNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "target folder not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not move file"})
		return
	}

	c.JSON(http.StatusOK, moved)
}

// ── Update ────────────────────────────────────────────────────────────────────

type updateFileRequest struct {
	Name string `json:"name" binding:"required,max=255"`
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

	req.Name = sanitize.Name(req.Name, 255)
	if req.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name must not be blank"})
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
