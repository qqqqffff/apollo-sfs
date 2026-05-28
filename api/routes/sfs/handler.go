package sfs

import (
	"context"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/middleware"
	"apollo-sfs.com/api/routes/services"
)

// Querier is the subset of *db.Queries used by SFS handlers. *db.Queries
// satisfies this interface implicitly; the interface exists so tests can
// supply lightweight stubs without a real database.
type Querier interface {
	GetUserByUsername(ctx context.Context, username string) (*models.User, error)
	GetFileByID(ctx context.Context, id uuid.UUID) (*models.File, error)
	ListFilesByFolder(ctx context.Context, folderID uuid.UUID, in db.PageInput) (*db.PageResult[models.File], error)
	ListRootFiles(ctx context.Context, userID uuid.UUID, in db.PageInput) (*db.PageResult[models.File], error)
	FindFolderByParentAndName(ctx context.Context, userID uuid.UUID, parentID *uuid.UUID, name string) (*models.Folder, error)
	CreateFolder(ctx context.Context, f *models.Folder) (*models.Folder, error)
	InsertAuditLog(ctx context.Context, in db.AuditInput) error
}

// FileServicer is the subset of *services.FileService used by SFS handlers.
type FileServicer interface {
	GetMetadata(ctx context.Context, fileID, userID uuid.UUID) (*models.File, error)
	Move(ctx context.Context, fileID, userID, newFolderID uuid.UUID) (*models.File, error)
	Delete(ctx context.Context, fileID, userID uuid.UUID, username string) error
	CheckQuota(ctx context.Context, username string, additionalBytes int64) error
}

// PresignServicer is the subset of *services.PresignService used here.
type PresignServicer interface {
	IssueForFile(fileID, userID, username, action string, expiry time.Duration) (string, time.Time, error)
	IssueForUpload(userID, username string, folderID *string, maxBytes int64, expiry time.Duration) (string, time.Time, error)
}

// APIKeyAuthorizer is the subset of *services.APIKeyService used to enforce
// per-scope permissions inside each handler.
type APIKeyAuthorizer interface {
	Authorize(scopes []models.APIKeyScope, op, objectKey string) bool
}

// Compile-time checks that the concrete types satisfy these interfaces.
var (
	_ Querier            = (*db.Queries)(nil)
	_ FileServicer       = (*services.FileService)(nil)
	_ PresignServicer    = (*services.PresignService)(nil)
	_ APIKeyAuthorizer   = (*services.APIKeyService)(nil)
)

// Handler holds dependencies for all /api/v1/sfs/* endpoints. Constructed
// once at startup in cmd/main.go:setupRouter alongside the admin handler.
type Handler struct {
	queries Querier
	pool    *db.Queries // owning *db.Queries — required to start ForUser txs
	files   FileServicer
	presign PresignServicer
	keys    APIKeyAuthorizer
}

// NewHandler wires an SFS Handler.
func NewHandler(q *db.Queries, files FileServicer, presign PresignServicer, keys APIKeyAuthorizer) *Handler {
	return &Handler{
		queries: q,
		pool:    q,
		files:   files,
		presign: presign,
		keys:    keys,
	}
}

// Context-key helpers — accessed from each route handler.
const (
	ctxAPIKeyID     = middleware.CtxAPIKeyID
	ctxAPIKeyScopes = middleware.CtxAPIKeyScopes
	ctxAPIKeyUser   = middleware.CtxAPIKeyUser
)
