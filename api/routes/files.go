package routes

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
	"apollo-sfs.com/api/sanitize"
)

// ── Upload ────────────────────────────────────────────────────────────────────

type uploadResponse struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	MimeType  string  `json:"mime_type"`
	SizeBytes int64   `json:"size_bytes"`
	FolderID  *string `json:"folder_id"`
}

// UploadFile handles POST /api/v1/files/upload.
// Expects a multipart form with:
//   - "file"      — the binary file field
//   - "folder_id" — UUID of the destination folder
//   - "name"      — optional display name; defaults to the original filename
func (h *Handler) UploadFile(c *gin.Context) {
	fileHeader, err := c.FormFile("file")
	if err != nil {
		if errors.Is(err, http.ErrMissingFile) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "file field is required"})
		} else {
			// ParseMultipartForm failed mid-body — usually a network interruption
			// (e.g. nginx closing the upstream connection due to a timeout).
			log.Printf("upload: read multipart body: %v", err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "upload interrupted — please retry"})
		}
		return
	}

	var folderID *uuid.UUID
	if raw := c.PostForm("folder_id"); raw != "" {
		parsed, err := uuid.Parse(raw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
			return
		}
		folderID = &parsed
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
		log.Printf("upload: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upload failed"})
		return
	}

	var folderIDStr *string
	if file.FolderID != nil {
		s := file.FolderID.String()
		folderIDStr = &s
	}

	h.logAudit(db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         "file_uploaded",
		ResourceType:   strPtr("file"),
		ResourceID:     &file.ID,
		ResourceName:   &file.Name,
	})

	c.JSON(http.StatusCreated, uploadResponse{
		ID:        file.ID.String(),
		Name:      file.Name,
		MimeType:  file.MimeType,
		SizeBytes: file.SizeBytes,
		FolderID:  folderIDStr,
	})
}

// ── Get metadata ──────────────────────────────────────────────────────────────

// fileResponse wraps File metadata with variant availability flags so the
// frontend can render a quality toggle without a separate API call.
type fileResponse struct {
	*models.File
	HasLowVariant bool `json:"has_low_variant"`
}

// GetFile handles GET /api/v1/files/:file_id.
// Returns the file metadata (name, type, size, timestamps) without content.
func (h *Handler) GetFile(c *gin.Context) {
	fileID, err := uuid.Parse(c.Param("file_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	ctx := c.Request.Context()

	file, err := h.files.GetMetadata(ctx, fileID, userID)
	if err != nil {
		if errors.Is(err, services.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve file"})
		return
	}

	c.JSON(http.StatusOK, &fileResponse{
		File:          file,
		HasLowVariant: h.files.HasReadyVariant(ctx, file.ID),
	})
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
		log.Printf("serveDecrypted: file=%s user=%s err=%v", fileID, username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve file"})
		return
	}

	mimeType := file.MimeType
	if inline {
		switch {
		case strings.HasPrefix(mimeType, "image/"),
			strings.HasPrefix(mimeType, "video/"),
			strings.HasPrefix(mimeType, "audio/"),
			mimeType == "application/pdf":
			// safe to render inline as-is
		case strings.HasPrefix(mimeType, "text/"):
			mimeType = "text/plain; charset=utf-8"
		default:
			// unknown type — force download instead of inline rendering
			inline = false
		}
	}

	if inline {
		c.Header("Content-Disposition", "inline")
	} else {
		c.Header("Content-Disposition",
			fmt.Sprintf(`attachment; filename="%s"`, sanitize.ContentDispositionFilename(file.Name)))
	}

	c.Data(http.StatusOK, mimeType, plaintext)
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

	// If ?quality=low is requested, swap in the transcoded 480p variant.
	// 404 is returned when the variant does not exist or is not yet ready.
	if c.Query("quality") == services.LowQualityLabel {
		variant, err := h.files.GetVariant(ctx, file.ID, services.LowQualityLabel)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "low-quality variant not available"})
			return
		}
		file = &models.File{
			ID:             file.ID,
			UserID:         file.UserID,
			MimeType:       "video/mp4",
			SizeBytes:      variant.SizeBytes,
			MinIOObjectKey: variant.MinIOObjectKey,
			Nonce:          []byte{}, // always chunked
		}
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

		// Expand small ranges to at least 4 MiB so that probe requests (≤256 KB)
		// and early-playback requests amortise the MinIO round-trip cost across
		// more data. The Content-Range header will report the actual byte span
		// returned, which is valid per RFC 9110 §14.4.
		const minRangeResponse int64 = 4 * services.ChunkSize
		if rangeEnd-rangeStart+1 < minRangeResponse {
			expanded := rangeStart + minRangeResponse - 1
			if expanded > file.SizeBytes-1 {
				expanded = file.SizeBytes - 1
			}
			rangeEnd = expanded
		}

		chunk, err := h.files.DownloadRange(ctx, file, username, rangeStart, rangeEnd)
		if err != nil {
			log.Printf("StreamFile: DownloadRange file=%s user=%s range=%d-%d: %v", fileID, username, rangeStart, rangeEnd, err)
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
		log.Printf("StreamFile: download file=%s user=%s: %v", fileID, username, err)
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

	username := c.GetString("username")
	h.logAudit(db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         "file_renamed",
		ResourceType:   strPtr("file"),
		ResourceID:     &fileID,
		ResourceName:   &updated.Name,
	})

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

	// Fetch name before deletion so it appears in the audit record.
	var deletedName string
	if meta, err := h.files.GetMetadata(c.Request.Context(), fileID, userID); err == nil && meta != nil {
		deletedName = meta.Name
	}

	if err := h.files.Delete(c.Request.Context(), fileID, userID, username); err != nil {
		if errors.Is(err, services.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete file"})
		return
	}

	entry := db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         "file_deleted",
		ResourceType:   strPtr("file"),
		ResourceID:     &fileID,
	}
	if deletedName != "" {
		entry.ResourceName = &deletedName
	}
	h.logAudit(entry)

	c.JSON(http.StatusOK, gin.H{"message": "file deleted"})
}

// ── Chunked upload ────────────────────────────────────────────────────────────

// InitUpload handles POST /api/v1/files/upload/init.
// Creates a chunked-upload session and returns its ID. The client must supply
// the final filename, total number of chunks, and total file size so a quota
// pre-check can reject oversized uploads before any bytes are transferred.
func (h *Handler) InitUpload(c *gin.Context) {
	var req struct {
		Name        string  `json:"name"         binding:"required"`
		TotalChunks int     `json:"total_chunks" binding:"required,min=1"`
		TotalSize   int64   `json:"total_size"   binding:"required,min=1,max=107374182400"`
		FolderID    *string `json:"folder_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	name := sanitize.Name(req.Name, 255)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file name"})
		return
	}

	var folderID *uuid.UUID
	if req.FolderID != nil && *req.FolderID != "" {
		parsed, err := uuid.Parse(*req.FolderID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
			return
		}
		folderID = &parsed
	}

	username := c.GetString("username")
	if err := h.files.CheckQuota(c.Request.Context(), username, req.TotalSize); err != nil {
		if errors.Is(err, services.ErrQuotaExceeded) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "quota check failed"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	sess, err := h.uploads.Create(userID, username, name, folderID, req.TotalChunks, req.TotalSize)
	if err != nil {
		log.Printf("init upload: create session: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create upload session"})
		return
	}

	if err := h.files.BeginChunkedUpload(c.Request.Context(), sess); err != nil {
		h.uploads.Delete(sess.ID)
		log.Printf("init upload: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not initialise upload"})
		return
	}

	h.logAudit(db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         "file_upload_started",
		ResourceType:   strPtr("file"),
		ResourceName:   &name,
	})

	c.JSON(http.StatusCreated, gin.H{"upload_id": sess.ID.String()})
}

// UploadChunk handles POST /api/v1/files/upload/:upload_id/chunk.
// Accepts a multipart form with a "chunk" file field and a "chunk_index" field.
// Chunks may arrive and be retried in any order; duplicates overwrite safely.
func (h *Handler) UploadChunk(c *gin.Context) {
	uploadID, err := uuid.Parse(c.Param("upload_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid upload_id"})
		return
	}

	sess, ok := h.uploads.Get(uploadID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "upload session not found or expired"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	if sess.UserID != userID {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}

	index, err := strconv.Atoi(c.PostForm("chunk_index"))
	if err != nil || index < 0 || index >= sess.TotalChunks {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid chunk_index"})
		return
	}

	fileHeader, err := c.FormFile("chunk")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "chunk field is required"})
		return
	}

	src, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not open chunk"})
		return
	}
	defer src.Close()

	data, err := io.ReadAll(src)
	if err != nil {
		log.Printf("upload chunk %d for %s: read: %v", index, uploadID, err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "upload interrupted — please retry"})
		return
	}

	// Dispatch goroutine: encrypts and uploads to MinIO in the background so this
	// response is returned immediately, allowing the next chunk to begin transferring
	// while the current chunk's encryption+upload runs in parallel.
	sess.DispatchChunk(index)
	go h.files.EncryptAndUploadPart(context.Background(), sess, index, data)

	c.JSON(http.StatusOK, gin.H{
		"chunk_index": index,
		"dispatched":  sess.DispatchedCount(),
		"total":       sess.TotalChunks,
	})
}

// CompleteUpload handles POST /api/v1/files/upload/:upload_id/complete.
// Assembles all chunks, encrypts, stores in MinIO, and creates the DB record.
func (h *Handler) CompleteUpload(c *gin.Context) {
	uploadID, err := uuid.Parse(c.Param("upload_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid upload_id"})
		return
	}

	sess, ok := h.uploads.Get(uploadID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "upload session not found or expired"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	if sess.UserID != userID {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}

	if !sess.AllDispatched() {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":      "not all chunks dispatched",
			"dispatched": sess.DispatchedCount(),
			"total":      sess.TotalChunks,
		})
		return
	}

	// FinalizeChunkedUpload blocks until all background goroutines complete,
	// then completes the MinIO multipart upload and writes the DB record.
	file, err := h.files.FinalizeChunkedUpload(c.Request.Context(), sess)
	if err != nil {
		if errors.Is(err, services.ErrQuotaExceeded) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
		} else if errors.Is(err, services.ErrDuplicateName) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		} else {
			log.Printf("complete upload %s: %v", uploadID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "upload failed"})
		}
		return
	}

	go h.uploads.Delete(uploadID)

	h.logAudit(db.AuditInput{
		TargetUsername: sess.Username,
		ActorUsername:  sess.Username,
		Action:         "file_uploaded",
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

// ── Presigned URLs ────────────────────────────────────────────────────────────

const (
	presignedDownloadTTL      = time.Hour
	presignedUploadTTL        = 6 * time.Hour
	presignedChunkedUploadTTL = 24 * time.Hour
)

// presignResponse is returned by all presign endpoints.
type presignResponse struct {
	DownloadURL string `json:"download_url,omitempty"`
	PreviewURL  string `json:"preview_url,omitempty"`
	URL         string `json:"url,omitempty"`
	UploadID    string `json:"upload_id,omitempty"`
	SessionToken string `json:"session_token,omitempty"`
	ExpiresAt   string `json:"expires_at"`
}

// PresignFile handles POST /api/v1/files/:file_id/presign.
// Issues time-limited download and preview URLs for a file the caller owns.
func (h *Handler) PresignFile(c *gin.Context) {
	fileID, err := uuid.Parse(c.Param("file_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file id"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	username := c.GetString("username")

	if _, err := h.files.GetMetadata(c.Request.Context(), fileID, userID); err != nil {
		if errors.Is(err, services.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not presign file"})
		return
	}

	dlToken, expiresAt, err := h.presign.IssueForFile(fileID.String(), userID.String(), username, services.PresignActionDownload, presignedDownloadTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not generate token"})
		return
	}
	pvToken, _, err := h.presign.IssueForFile(fileID.String(), userID.String(), username, services.PresignActionPreview, presignedDownloadTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not generate token"})
		return
	}

	c.JSON(http.StatusOK, presignResponse{
		DownloadURL: fmt.Sprintf("/api/v1/files/%s/download/p?token=%s", fileID, dlToken),
		PreviewURL:  fmt.Sprintf("/api/v1/files/%s/preview/p?token=%s", fileID, pvToken),
		ExpiresAt:   expiresAt.UTC().Format(time.RFC3339),
	})
}

// DownloadFilePresigned handles GET /api/v1/files/:file_id/download/p.
// Validates the presign token and serves the file as an attachment.
func (h *Handler) DownloadFilePresigned(c *gin.Context) {
	h.servePresigned(c, false)
}

// PreviewFilePresigned handles GET /api/v1/files/:file_id/preview/p.
// Validates the presign token and serves the file inline.
func (h *Handler) PreviewFilePresigned(c *gin.Context) {
	h.servePresigned(c, true)
}

// servePresigned validates a file presign token and streams the decrypted content.
func (h *Handler) servePresigned(c *gin.Context, inline bool) {
	fileIDStr := c.Param("file_id")
	fileID, err := uuid.Parse(fileIDStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file id"})
		return
	}

	action := services.PresignActionDownload
	if inline {
		action = services.PresignActionPreview
	}

	token := c.Query("token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "token is required"})
		return
	}

	claim, err := h.presign.ValidateForFile(token, action)
	if err != nil {
		if errors.Is(err, services.ErrPresignExpired) {
			c.JSON(http.StatusGone, gin.H{"error": "presigned URL has expired"})
			return
		}
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid presigned token"})
		return
	}

	if claim.FileID != fileIDStr {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid presigned token"})
		return
	}

	userID, err := uuid.Parse(claim.UserID)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid presigned token"})
		return
	}

	file, plaintext, err := h.files.Download(c.Request.Context(), fileID, userID, claim.Username)
	if err != nil {
		if errors.Is(err, services.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		log.Printf("servePresigned: file=%s user=%s err=%v", fileID, claim.Username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve file"})
		return
	}

	mimeType := file.MimeType
	if inline {
		switch {
		case strings.HasPrefix(mimeType, "image/"),
			strings.HasPrefix(mimeType, "video/"),
			strings.HasPrefix(mimeType, "audio/"),
			mimeType == "application/pdf":
		case strings.HasPrefix(mimeType, "text/"):
			mimeType = "text/plain; charset=utf-8"
		default:
			inline = false
		}
	}

	if inline {
		c.Header("Content-Disposition", "inline")
	} else {
		c.Header("Content-Disposition",
			fmt.Sprintf(`attachment; filename="%s"`, sanitize.ContentDispositionFilename(file.Name)))
	}

	c.Data(http.StatusOK, mimeType, plaintext)
}

// PresignUpload handles POST /api/v1/files/upload/presign.
// Issues a time-limited presigned URL for a single-file upload.
// Body: { "name", "size", "folder_id" (optional) }
func (h *Handler) PresignUpload(c *gin.Context) {
	var req struct {
		Name     string  `json:"name"     binding:"required"`
		Size     int64   `json:"size"     binding:"required,min=1,max=107374182400"`
		FolderID *string `json:"folder_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	name := sanitize.Name(req.Name, 255)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file name"})
		return
	}

	username := c.GetString("username")
	if err := h.files.CheckQuota(c.Request.Context(), username, req.Size); err != nil {
		if errors.Is(err, services.ErrQuotaExceeded) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "quota check failed"})
		return
	}

	userID := c.GetString("userID")

	var folderIDStr *string
	if req.FolderID != nil && *req.FolderID != "" {
		if _, err := uuid.Parse(*req.FolderID); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
			return
		}
		folderIDStr = req.FolderID
	}

	token, expiresAt, err := h.presign.IssueForUpload(userID, username, folderIDStr, req.Size, presignedUploadTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not generate upload token"})
		return
	}

	c.JSON(http.StatusOK, presignResponse{
		URL:       fmt.Sprintf("/api/v1/files/upload/p?token=%s", token),
		ExpiresAt: expiresAt.UTC().Format(time.RFC3339),
	})
}

// UploadFilePresigned handles POST /api/v1/files/upload/p.
// Validates the presign token and performs the file upload without cookie auth.
func (h *Handler) UploadFilePresigned(c *gin.Context) {
	token := c.Query("token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "token is required"})
		return
	}

	claim, err := h.presign.ValidateForUpload(token)
	if err != nil {
		if errors.Is(err, services.ErrPresignExpired) {
			c.JSON(http.StatusGone, gin.H{"error": "presigned URL has expired"})
			return
		}
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid presigned token"})
		return
	}

	fileHeader, err := c.FormFile("file")
	if err != nil {
		if errors.Is(err, http.ErrMissingFile) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "file field is required"})
		} else {
			log.Printf("presigned upload: read multipart body: %v", err)
			c.JSON(http.StatusBadRequest, gin.H{"error": "upload interrupted — please retry"})
		}
		return
	}

	if fileHeader.Size > claim.MaxBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "file exceeds permitted size"})
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

	var folderID *uuid.UUID
	if claim.FolderID != nil {
		parsed, err := uuid.Parse(*claim.FolderID)
		if err == nil {
			folderID = &parsed
		}
	}

	userID, err := uuid.Parse(claim.UserID)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid presigned token"})
		return
	}

	src, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not read uploaded file"})
		return
	}
	defer src.Close()

	file, err := h.files.Upload(c.Request.Context(), services.UploadInput{
		Username: claim.Username,
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
		log.Printf("presigned upload: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "upload failed"})
		return
	}

	var folderIDStr *string
	if file.FolderID != nil {
		s := file.FolderID.String()
		folderIDStr = &s
	}

	h.logAudit(db.AuditInput{
		TargetUsername: claim.Username,
		ActorUsername:  claim.Username,
		Action:         "file_uploaded",
		ResourceType:   strPtr("file"),
		ResourceID:     &file.ID,
		ResourceName:   &file.Name,
	})

	c.JSON(http.StatusCreated, uploadResponse{
		ID:        file.ID.String(),
		Name:      file.Name,
		MimeType:  file.MimeType,
		SizeBytes: file.SizeBytes,
		FolderID:  folderIDStr,
	})
}

// PresignChunkedUpload handles POST /api/v1/files/upload/presign/init.
// Issues a session token for a presigned chunked upload, reusing the existing
// session infrastructure for chunk tracking.
// Body: same as InitUpload.
func (h *Handler) PresignChunkedUpload(c *gin.Context) {
	var req struct {
		Name        string  `json:"name"         binding:"required"`
		TotalChunks int     `json:"total_chunks" binding:"required,min=1"`
		TotalSize   int64   `json:"total_size"   binding:"required,min=1,max=107374182400"`
		FolderID    *string `json:"folder_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	name := sanitize.Name(req.Name, 255)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid file name"})
		return
	}

	var folderID *uuid.UUID
	if req.FolderID != nil && *req.FolderID != "" {
		parsed, err := uuid.Parse(*req.FolderID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "folder_id must be a valid UUID"})
			return
		}
		folderID = &parsed
	}

	username := c.GetString("username")
	if err := h.files.CheckQuota(c.Request.Context(), username, req.TotalSize); err != nil {
		if errors.Is(err, services.ErrQuotaExceeded) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "quota check failed"})
		return
	}

	userID, _ := uuid.Parse(c.GetString("userID"))
	sess, err := h.uploads.Create(userID, username, name, folderID, req.TotalChunks, req.TotalSize)
	if err != nil {
		log.Printf("presign chunked upload: create session: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create upload session"})
		return
	}

	if err := h.files.BeginChunkedUpload(c.Request.Context(), sess); err != nil {
		h.uploads.Delete(sess.ID)
		log.Printf("presign chunked upload: begin: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not initialise upload"})
		return
	}

	sessionToken, expiresAt, err := h.presign.IssueForChunkedUpload(sess.ID.String(), userID.String(), presignedChunkedUploadTTL)
	if err != nil {
		h.uploads.Delete(sess.ID)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not generate session token"})
		return
	}

	h.logAudit(db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         "file_upload_started",
		ResourceType:   strPtr("file"),
		ResourceName:   &name,
	})

	c.JSON(http.StatusCreated, presignResponse{
		UploadID:     sess.ID.String(),
		SessionToken: sessionToken,
		ExpiresAt:    expiresAt.UTC().Format(time.RFC3339),
	})
}

// UploadChunkPresigned handles POST /api/v1/files/upload/:upload_id/chunk/p.
// Validates the session token and uploads a single chunk without cookie auth.
func (h *Handler) UploadChunkPresigned(c *gin.Context) {
	uploadID, err := uuid.Parse(c.Param("upload_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid upload_id"})
		return
	}

	token := c.Query("token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "token is required"})
		return
	}

	claim, err := h.presign.ValidateForChunkedUpload(token)
	if err != nil {
		if errors.Is(err, services.ErrPresignExpired) {
			c.JSON(http.StatusGone, gin.H{"error": "presigned URL has expired"})
			return
		}
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid presigned token"})
		return
	}

	if claim.SessionID != uploadID.String() {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid presigned token"})
		return
	}

	sess, ok := h.uploads.Get(uploadID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "upload session not found or expired"})
		return
	}

	claimUserID, err := uuid.Parse(claim.UserID)
	if err != nil || sess.UserID != claimUserID {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid presigned token"})
		return
	}

	index, err := strconv.Atoi(c.PostForm("chunk_index"))
	if err != nil || index < 0 || index >= sess.TotalChunks {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid chunk_index"})
		return
	}

	fileHeader, err := c.FormFile("chunk")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "chunk field is required"})
		return
	}

	src, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not open chunk"})
		return
	}
	defer src.Close()

	data, err := io.ReadAll(src)
	if err != nil {
		log.Printf("presigned upload chunk %d for %s: read: %v", index, uploadID, err)
		c.JSON(http.StatusBadRequest, gin.H{"error": "upload interrupted — please retry"})
		return
	}

	sess.DispatchChunk(index)
	go h.files.EncryptAndUploadPart(context.Background(), sess, index, data)

	c.JSON(http.StatusOK, gin.H{
		"chunk_index": index,
		"dispatched":  sess.DispatchedCount(),
		"total":       sess.TotalChunks,
	})
}

// CompleteUploadPresigned handles POST /api/v1/files/upload/:upload_id/complete/p.
// Validates the session token and finalises the chunked upload without cookie auth.
func (h *Handler) CompleteUploadPresigned(c *gin.Context) {
	uploadID, err := uuid.Parse(c.Param("upload_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid upload_id"})
		return
	}

	token := c.Query("token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "token is required"})
		return
	}

	claim, err := h.presign.ValidateForChunkedUpload(token)
	if err != nil {
		if errors.Is(err, services.ErrPresignExpired) {
			c.JSON(http.StatusGone, gin.H{"error": "presigned URL has expired"})
			return
		}
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid presigned token"})
		return
	}

	if claim.SessionID != uploadID.String() {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid presigned token"})
		return
	}

	sess, ok := h.uploads.Get(uploadID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "upload session not found or expired"})
		return
	}

	claimUserID, err := uuid.Parse(claim.UserID)
	if err != nil || sess.UserID != claimUserID {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid presigned token"})
		return
	}

	if !sess.AllDispatched() {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":      "not all chunks dispatched",
			"dispatched": sess.DispatchedCount(),
			"total":      sess.TotalChunks,
		})
		return
	}

	file, err := h.files.FinalizeChunkedUpload(c.Request.Context(), sess)
	if err != nil {
		if errors.Is(err, services.ErrQuotaExceeded) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
		} else if errors.Is(err, services.ErrDuplicateName) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		} else {
			log.Printf("complete presigned upload %s: %v", uploadID, err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "upload failed"})
		}
		return
	}

	go h.uploads.Delete(uploadID)

	h.logAudit(db.AuditInput{
		TargetUsername: sess.Username,
		ActorUsername:  sess.Username,
		Action:         "file_uploaded",
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
