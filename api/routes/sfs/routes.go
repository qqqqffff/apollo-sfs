package sfs

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

const (
	presignedUploadTTL   = 15 * time.Minute
	presignedDownloadTTL = 15 * time.Minute
	defaultListLimit     = 50
	maxListLimit         = 200
)

// ── Helpers ───────────────────────────────────────────────────────────────────

// resolveBucket asserts the URL :bucket_id matches the API key's owning
// user, returning the *models.User for further use. The literal alias "me"
// is always accepted.
func (h *Handler) resolveBucket(c *gin.Context) (*models.User, bool) {
	rawUser, ok := c.Get(ctxAPIKeyUser)
	if !ok {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing api key"})
		return nil, false
	}
	user, ok := rawUser.(*models.User)
	if !ok || user == nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "invalid api key context"})
		return nil, false
	}
	bucket := c.Param("bucket_id")
	if bucket != "me" && bucket != user.Username {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "bucket does not match api key owner"})
		return nil, false
	}
	return user, true
}

func (h *Handler) scopes(c *gin.Context) []models.APIKeyScope {
	raw, _ := c.Get(ctxAPIKeyScopes)
	if raw == nil {
		return nil
	}
	sc, _ := raw.([]models.APIKeyScope)
	return sc
}

func (h *Handler) requireScope(c *gin.Context, op, key string) bool {
	if h.keys.Authorize(h.scopes(c), op, key) {
		return true
	}
	c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
		"error":         "scope_required",
		"operation":     op,
		"object_key":    key,
		"detail":        fmt.Sprintf("api key does not grant %q on %q", op, key),
	})
	return false
}

func (h *Handler) audit(ctx *gin.Context, user *models.User, action string, key string) {
	keyIDRaw, _ := ctx.Get(ctxAPIKeyID)
	keyID, _ := keyIDRaw.(uuid.UUID)
	resourceType := "sfs_object"
	resourceName := key
	if err := h.pool.InsertAuditLog(ctx.Request.Context(), db.AuditInput{
		TargetUsername: user.Username,
		ActorUsername:  user.Username,
		Action:         action,
		ResourceType:   &resourceType,
		ResourceID:     uuidPtrOrNil(keyID),
		ResourceName:   &resourceName,
	}); err != nil {
		log.Printf("sfs audit %q: %v", action, err)
	}
}

func uuidPtrOrNil(u uuid.UUID) *uuid.UUID {
	if u == uuid.Nil {
		return nil
	}
	return &u
}

// ── Request bodies ────────────────────────────────────────────────────────────

type putReq struct {
	Key         string `json:"key"          binding:"required"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"   binding:"required,min=1,max=107374182400"`
}

type keyReq struct {
	Key string `json:"key" binding:"required"`
}

type listReq struct {
	Prefix            string `json:"prefix"`
	Limit             int    `json:"limit"`
	ContinuationToken string `json:"continuation_token"`
}

type moveReq struct {
	Key    string `json:"key"     binding:"required"`
	NewKey string `json:"new_key" binding:"required"`
}

// ── /put ──────────────────────────────────────────────────────────────────────

type putResp struct {
	UploadURL string         `json:"upload_url"`
	ExpiresAt time.Time      `json:"expires_at"`
	Metadata  ObjectMetadata `json:"metadata"`
}

// Put is POST /api/v1/sfs/buckets/:bucket_id/put.
// Resolves the destination folder chain (creating missing folders inside
// the transaction so a quota failure rolls them back), pre-checks quota,
// and returns a presigned upload URL. The actual bytes flow to
// /files/upload/p?token=... — see routes/files.go UploadFilePresigned.
func (h *Handler) Put(c *gin.Context) {
	user, ok := h.resolveBucket(c)
	if !ok {
		return
	}
	var req putReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	parsed, err := ParseObjectKey(req.Key)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !h.requireScope(c, "write", parsed.FullPath) {
		return
	}
	if err := h.files.CheckQuota(c.Request.Context(), user.Username, req.SizeBytes); err != nil {
		if errors.Is(err, services.ErrQuotaExceeded) {
			c.AbortWithStatusJSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
			return
		}
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "quota check failed"})
		return
	}

	userID, err := uuid.Parse(user.Username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "invalid user id"})
		return
	}
	q, tx, err := h.pool.ForUser(c.Request.Context(), userID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "begin tx"})
		return
	}
	defer func() { _ = tx.Rollback() }()
	folderID, err := ResolvePath(c.Request.Context(), q, userID, parsed.Segments, true)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := tx.Commit(); err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "commit"})
		return
	}

	var folderIDStr *string
	if folderID != nil {
		s := folderID.String()
		folderIDStr = &s
	}
	token, expires, err := h.presign.IssueForUpload(
		user.Username, user.Username, folderIDStr, req.SizeBytes, presignedUploadTTL,
	)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "presign"})
		return
	}
	parentStr := "root"
	if folderID != nil {
		parentStr = folderID.String()
	}
	metadata := ObjectMetadata{
		Key:            parsed.FullPath,
		Parent:         parentStr,
		CreatedAt:      time.Now().UTC(),
		UpdatedAt:      time.Now().UTC(),
		RemainingQuota: max64(user.StorageQuotaBytes-user.StorageUsedBytes-req.SizeBytes, 0),
		Size:           req.SizeBytes,
		ContentType:    req.ContentType,
		Extension:      parsed.Extension,
	}
	h.audit(c, user, "sfs.put.presign", parsed.FullPath)
	c.JSON(http.StatusOK, putResp{
		UploadURL: fmt.Sprintf("/api/v1/files/upload/p?token=%s&name=%s", token, parsed.Leaf),
		ExpiresAt: expires.UTC(),
		Metadata:  metadata,
	})
}

// ── /get ──────────────────────────────────────────────────────────────────────

type getResp struct {
	DownloadURL string         `json:"download_url"`
	ExpiresAt   time.Time      `json:"expires_at"`
	Metadata    ObjectMetadata `json:"metadata"`
}

// Get is POST /api/v1/sfs/buckets/:bucket_id/get.
// Resolves the file by path, scope-checks, and returns a download presign.
func (h *Handler) Get(c *gin.Context) {
	user, ok := h.resolveBucket(c)
	if !ok {
		return
	}
	var req keyReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	parsed, err := ParseObjectKey(req.Key)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !h.requireScope(c, "read", parsed.FullPath) {
		return
	}
	file, err := h.resolveFile(c, user, parsed)
	if err != nil {
		return
	}
	userID, _ := uuid.Parse(user.Username)
	token, expires, err := h.presign.IssueForFile(
		file.ID.String(), userID.String(), user.Username,
		services.PresignActionDownload, presignedDownloadTTL,
	)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "presign"})
		return
	}
	h.audit(c, user, "sfs.get.presign", parsed.FullPath)
	c.JSON(http.StatusOK, getResp{
		DownloadURL: fmt.Sprintf("/api/v1/files/%s/download/p?token=%s", file.ID, token),
		ExpiresAt:   expires.UTC(),
		Metadata:    BuildMetadata(file, user, parsed.FullPath),
	})
}

// ── /head ─────────────────────────────────────────────────────────────────────

type headResp struct {
	Metadata ObjectMetadata `json:"metadata"`
}

// Head is POST /api/v1/sfs/buckets/:bucket_id/head.
func (h *Handler) Head(c *gin.Context) {
	user, ok := h.resolveBucket(c)
	if !ok {
		return
	}
	var req keyReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	parsed, err := ParseObjectKey(req.Key)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !h.requireScope(c, "read", parsed.FullPath) {
		return
	}
	file, err := h.resolveFile(c, user, parsed)
	if err != nil {
		return
	}
	c.JSON(http.StatusOK, headResp{Metadata: BuildMetadata(file, user, parsed.FullPath)})
}

// ── /delete ───────────────────────────────────────────────────────────────────

// Delete is POST /api/v1/sfs/buckets/:bucket_id/delete.
func (h *Handler) Delete(c *gin.Context) {
	user, ok := h.resolveBucket(c)
	if !ok {
		return
	}
	var req keyReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	parsed, err := ParseObjectKey(req.Key)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !h.requireScope(c, "delete", parsed.FullPath) {
		return
	}
	file, err := h.resolveFile(c, user, parsed)
	if err != nil {
		return
	}
	snapshot := BuildMetadata(file, user, parsed.FullPath)
	userID, _ := uuid.Parse(user.Username)
	if err := h.files.Delete(c.Request.Context(), file.ID, userID, user.Username); err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
		return
	}
	h.audit(c, user, "sfs.delete", parsed.FullPath)
	c.JSON(http.StatusOK, gin.H{"metadata": snapshot})
}

// ── /list ─────────────────────────────────────────────────────────────────────

type listResp struct {
	Objects               []ObjectMetadata `json:"objects"`
	NextContinuationToken string           `json:"next_continuation_token,omitempty"`
}

// List is POST /api/v1/sfs/buckets/:bucket_id/list.
func (h *Handler) List(c *gin.Context) {
	user, ok := h.resolveBucket(c)
	if !ok {
		return
	}
	var req listReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	prefix, err := ParsePrefix(req.Prefix)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !h.requireScope(c, "list", prefix.FullPath) {
		return
	}
	limit := req.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}

	userID, err := uuid.Parse(user.Username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "invalid user id"})
		return
	}
	q, tx, err := h.pool.ForUser(c.Request.Context(), userID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "begin tx"})
		return
	}
	defer func() { _ = tx.Rollback() }()

	folderID, err := LookupFolderByPath(c.Request.Context(), q, userID, prefix.Segments)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	pageIn := db.PageInput{Cursor: req.ContinuationToken, Limit: limit}
	var page *db.PageResult[models.File]
	if folderID == nil {
		page, err = q.ListRootFiles(c.Request.Context(), userID, pageIn)
	} else {
		page, err = q.ListFilesByFolder(c.Request.Context(), *folderID, pageIn)
	}
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}

	out := make([]ObjectMetadata, 0, len(page.Items))
	for i := range page.Items {
		f := &page.Items[i]
		fullKey := JoinPath(prefix.Segments, f.Name)
		out = append(out, BuildMetadata(f, user, fullKey))
	}
	c.JSON(http.StatusOK, listResp{
		Objects:               out,
		NextContinuationToken: page.NextToken,
	})
}

// ── /move ─────────────────────────────────────────────────────────────────────

// Move is POST /api/v1/sfs/buckets/:bucket_id/move.
// Scope-checks delete on the source and write on the destination, then
// (re)creates the destination folder chain and re-parents the file row.
// Renaming the file (different leaf) is supported via the underlying
// FileService.Rename — both move and rename happen atomically in the same
// transaction the resolver opens.
func (h *Handler) Move(c *gin.Context) {
	user, ok := h.resolveBucket(c)
	if !ok {
		return
	}
	var req moveReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	src, err := ParseObjectKey(req.Key)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "key: " + err.Error()})
		return
	}
	dst, err := ParseObjectKey(req.NewKey)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "new_key: " + err.Error()})
		return
	}
	if !h.requireScope(c, "delete", src.FullPath) {
		return
	}
	if !h.requireScope(c, "write", dst.FullPath) {
		return
	}
	file, err := h.resolveFile(c, user, src)
	if err != nil {
		return
	}
	userID, _ := uuid.Parse(user.Username)
	q, tx, err := h.pool.ForUser(c.Request.Context(), userID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "begin tx"})
		return
	}
	defer func() { _ = tx.Rollback() }()
	dstFolderID, err := ResolvePath(c.Request.Context(), q, userID, dst.Segments, true)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Rename the file row if the leaf changed.
	if file.Name != dst.Leaf {
		if _, err := q.UpdateFileName(c.Request.Context(), file.ID, dst.Leaf); err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "rename"})
			return
		}
	}
	if dstFolderID != nil {
		moved, err := q.MoveFile(c.Request.Context(), file.ID, *dstFolderID)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "move"})
			return
		}
		file = moved
	} else {
		// Move to root.
		moved, err := q.MoveFileToRoot(c.Request.Context(), file.ID)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "move to root"})
			return
		}
		file = moved
	}
	if err := tx.Commit(); err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "commit"})
		return
	}
	h.audit(c, user, "sfs.move", src.FullPath+" -> "+dst.FullPath)
	c.JSON(http.StatusOK, gin.H{"metadata": BuildMetadata(file, user, dst.FullPath)})
}

// resolveFile walks parsed.Segments to find the target folder, then
// finds the file by name within. Centralises NOT-FOUND mapping.
func (h *Handler) resolveFile(c *gin.Context, user *models.User, parsed *ParsedKey) (*models.File, error) {
	userID, err := uuid.Parse(user.Username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "invalid user id"})
		return nil, err
	}
	q, tx, err := h.pool.ForUser(c.Request.Context(), userID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "begin tx"})
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	folderID, err := LookupFolderByPath(c.Request.Context(), q, userID, parsed.Segments)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "object not found"})
		return nil, err
	}
	file, err := q.FindFileByFolderAndName(c.Request.Context(), userID, folderID, parsed.Leaf)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "object not found"})
			return nil, err
		}
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "lookup"})
		return nil, err
	}
	return file, nil
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
