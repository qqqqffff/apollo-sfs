package routes

import (
	"context"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// InviteService is the subset of *services.InviteService used by route handlers.
type InviteService interface {
	Validate(ctx context.Context, token string) (*services.InviteValidation, error)
}

// FileServicer is the subset of *services.FileService used by route handlers.
type FileServicer interface {
	Upload(ctx context.Context, in services.UploadInput) (*models.File, error)
	CheckQuota(ctx context.Context, username string, additionalBytes int64) error
	GetMetadata(ctx context.Context, fileID, userID uuid.UUID) (*models.File, error)
	HasReadyVariant(ctx context.Context, fileID uuid.UUID) bool
	Download(ctx context.Context, fileID, userID uuid.UUID, username string) (*models.File, []byte, error)
	GetVariant(ctx context.Context, fileID uuid.UUID, quality string) (*models.VideoVariant, error)
	DownloadRange(ctx context.Context, file *models.File, username string, rangeStart, rangeEnd int64) ([]byte, error)
	DownloadChunked(ctx context.Context, file *models.File, username string) ([]byte, error)
	Move(ctx context.Context, fileID, userID, newFolderID uuid.UUID) (*models.File, error)
	Rename(ctx context.Context, fileID, userID uuid.UUID, name string) (*models.File, error)
	Delete(ctx context.Context, fileID, userID uuid.UUID, username string) error
	BeginChunkedUpload(ctx context.Context, sess *services.UploadSession) error
	EncryptAndUploadPart(ctx context.Context, sess *services.UploadSession, index int, data []byte)
	FinalizeChunkedUpload(ctx context.Context, sess *services.UploadSession) (*models.File, error)
}

// FolderServicer is the subset of *services.FolderService used by route handlers.
type FolderServicer interface {
	ListRoot(ctx context.Context, userID uuid.UUID, folderPage, filePage db.PageInput) (*services.FolderContents, error)
	GetContents(ctx context.Context, folderID, userID uuid.UUID, folderPage, filePage db.PageInput) (*services.FolderContents, error)
	Create(ctx context.Context, userID uuid.UUID, parentID *uuid.UUID, name string) (*models.Folder, error)
	Rename(ctx context.Context, folderID, userID uuid.UUID, name string) (*models.Folder, error)
	Move(ctx context.Context, folderID, targetID, userID uuid.UUID) (*models.Folder, error)
	Delete(ctx context.Context, folderID, userID uuid.UUID) error
}

// Compile-time checks that the concrete service types satisfy these interfaces.
var _ FileServicer = (*services.FileService)(nil)
var _ FolderServicer = (*services.FolderService)(nil)

// Handler holds shared dependencies for route handlers in the routes package.
// Methods on Handler implement the individual endpoint logic.
// Sub-packages (auth, admin) define their own equivalent structs.
type Handler struct {
	queries         Querier
	files           FileServicer
	folders         FolderServicer
	invites         InviteService
	favorites       *services.FavoriteService
	auth            *services.AuthService
	uploads         *services.UploadSessionStore
	email           *services.EmailService
	turnstileSecret string
	// verifyCaptcha overrides the real Turnstile HTTP call. When nil the
	// production verifyTurnstile function is used.
	verifyCaptcha func(secret, token, ip string) (bool, error)
}

// NewHandler constructs a Handler with the given dependencies.
func NewHandler(q Querier, fileSvc FileServicer, folderSvc FolderServicer, inviteSvc InviteService, favSvc *services.FavoriteService, authSvc *services.AuthService, uploadStore *services.UploadSessionStore, emailSvc *services.EmailService, turnstileSecret string) *Handler {
	return &Handler{
		queries:         q,
		files:           fileSvc,
		folders:         folderSvc,
		invites:         inviteSvc,
		favorites:       favSvc,
		auth:            authSvc,
		uploads:         uploadStore,
		email:           emailSvc,
		turnstileSecret: turnstileSecret,
	}
}

// SetVerifyCaptcha replaces the Turnstile verification function. Intended for
// tests that need to bypass real HTTP calls to Cloudflare.
func SetVerifyCaptcha(h *Handler, fn func(secret, token, ip string) (bool, error)) {
	h.verifyCaptcha = fn
}

// SetInviteService replaces the invite service on an existing Handler.
// Provided so test packages can inject stub implementations.
func SetInviteService(h *Handler, svc InviteService) {
	h.invites = svc
}
