package routes

import (
	"context"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// Querier is the subset of *db.Queries methods used directly by route handlers.
// *db.Queries satisfies this interface implicitly (Go structural typing), so no
// production call sites need to change. Define it here so tests can supply stubs.
type Querier interface {
	// Me
	GetUserByUsername(ctx context.Context, username string) (*models.User, error)
	GetActiveSubscriptionForUser(ctx context.Context, username string) (*models.PremiumSubscription, error)

	// Change-password two-factor codes
	CreatePasswordChangeCode(ctx context.Context, username, code string, expiresAt time.Time) error
	ConsumePasswordChangeCode(ctx context.Context, username, code string) (bool, error)

	// Admin per-user storage view
	GetUserStorageBreakdown(ctx context.Context, userID string) (db.UserStorageBreakdown, error)
	GetUserStorageAllocations(ctx context.Context, username, userID string) ([]db.UserStorageAllocation, error)
	CountActiveExpansionRequests(ctx context.Context, username string) (int, error)

	// Admin storage allocation editor
	GetDrive(ctx context.Context, id uuid.UUID) (*models.Drive, error)
	GetServer(ctx context.Context, id uuid.UUID) (*models.Server, error)
	GetDriveAvailableBytes(ctx context.Context, driveID uuid.UUID) (int64, error)
	SaveUserDriveAllocations(ctx context.Context, username string, want []db.SaveAllocationsParams) (int64, error)
	InsertQuotaChangeNotification(ctx context.Context, p db.InsertQuotaChangeNotificationParams) error

	// Notification bell
	ListUserExpansionRequests(ctx context.Context, username string) ([]models.ServerExpansionRequest, error)
	GetLatestExpansionInvoice(ctx context.Context, requestID uuid.UUID) (*models.ExpansionInvoice, error)
	ListSharesForRecipient(ctx context.Context, email string) ([]models.Share, error)
	ListRecentAdminCancelledSubscriptionsForUser(ctx context.Context, username string, since time.Time) ([]models.PremiumSubscription, error)
	ListRecentQuotaChangeNotificationsForUser(ctx context.Context, username string, since time.Time) ([]db.QuotaChangeNotification, error)
	ListRecentEmailBackupRunsForUser(ctx context.Context, username string, since time.Time) ([]models.EmailBackupRun, error)

	// Backup last-sync times (backup pages + opt-in stale-backup reminder)
	GetLastGoogleBackupSync(ctx context.Context, userID uuid.UUID) (*time.Time, error)
	GetLastEmailBackupSync(ctx context.Context, username string) (*time.Time, error)
	SetBackupStaleNotify(ctx context.Context, userID string, enabled bool) (*models.UserPreferences, error)

	// Notification bell — admin-only categories
	ListRecentlyAcceptedInvitations(ctx context.Context, since time.Time) ([]models.Invitation, error)
	ListRecentCapturedOrders(ctx context.Context, since time.Time, limit int) ([]db.AdminOrder, error)
	ListRecentUnreadInboundEmails(ctx context.Context, since time.Time, limit int) ([]models.InboundEmail, error)
	ListRecentlyFiredAlarmSubscriptions(ctx context.Context, since time.Time) ([]models.AlarmSubscription, error)

	// Notification bell — dismissal
	ListDismissedNotificationIDs(ctx context.Context, username string) (map[string]bool, error)
	DismissNotifications(ctx context.Context, username string, ids []string) error

	// User preferences
	GetUserPreferences(ctx context.Context, userID string) (*models.UserPreferences, error)
	SetMediaAutouploadFolder(ctx context.Context, userID string, folderID *uuid.UUID) (*models.UserPreferences, error)
	SetStorageUIPreferences(ctx context.Context, userID string, showButtons, promptEnabled *bool) (*models.UserPreferences, error)

	// Ban / suspension enforcement (checked on every /me call)
	GetActiveBan(ctx context.Context, username string) (*models.UserBan, error)
	AutoPardonExpiredSuspension(ctx context.Context, username string) error
	AddBannedIP(ctx context.Context, ip, jail string) error

	// Search
	SearchFoldersByUser(ctx context.Context, userID uuid.UUID, term string, in db.PageInput) (*db.PageResult[models.Folder], error)
	SearchFilesByUser(ctx context.Context, userID uuid.UUID, term string, in db.PageInput) (*db.PageResult[models.File], error)
	SearchRecognitionGroupsByUser(ctx context.Context, userID uuid.UUID, term string, in db.PageInput) (*db.PageResult[db.RecognitionGroupSearchHit], error)

	// Interest form
	GetInterestFormSettings(ctx context.Context) (*models.InterestFormSettings, error)
	CountInterestSubmissionsToday(ctx context.Context) (int, error)
	CountInterestSubmissionsFromIP(ctx context.Context, ip string) (int, error)
	ExistsInterestSubmissionByEmail(ctx context.Context, email string) (bool, error)
	CreateInterestSubmission(ctx context.Context, s *models.InterestSubmission) error
	ListAdminEmails(ctx context.Context) ([]string, error)

	// Interest form — fixed-plan deposit (no custom storage amounts)
	CreateInterestDepositOrder(ctx context.Context, o *models.InterestDepositOrder) error
	GetInterestDepositOrder(ctx context.Context, orderID string) (*models.InterestDepositOrder, error)
	MarkInterestDepositOrderCaptured(ctx context.Context, orderID, captureID string) error
	ConsumeInterestDepositOrder(ctx context.Context, orderID string) (bool, error)

	// Audit logs
	InsertAuditLog(ctx context.Context, in db.AuditInput) error
	ListAuditLogsForUser(ctx context.Context, username string, in db.PageInput) (*db.PageResult[models.AuditLog], error)

	// Devices (mobile)
	CreateDevice(ctx context.Context, userID uuid.UUID, name, platform string, pushToken *string) (*db.Device, error)
	GetDevice(ctx context.Context, id uuid.UUID) (*db.Device, error)
	UpdateDeviceLastSeen(ctx context.Context, id uuid.UUID, pushToken *string) error
	DeleteDevice(ctx context.Context, id uuid.UUID) error

	// Sync (mobile)
	DeltaSyncFiles(ctx context.Context, userID uuid.UUID, since time.Time) ([]models.File, error)
	DeltaSyncDeleted(ctx context.Context, userID uuid.UUID, since time.Time) ([]uuid.UUID, error)
	FindFileByHash(ctx context.Context, userID uuid.UUID, hash string) (*models.File, error)

	// Feedback (profile page submission; reviewed on the admin feedback page)
	CreateFeedback(ctx context.Context, userID uuid.UUID, username, category, message string) (*models.Feedback, error)
}
