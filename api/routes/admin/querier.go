package admin

import (
	"context"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// AdminQuerier is the subset of *db.Queries methods used by admin handlers.
// *db.Queries satisfies this interface implicitly; the interface exists so
// tests can supply lightweight stubs without a real database.
type AdminQuerier interface {
	// Users
	ListUsers(ctx context.Context, in db.PageInput) (*db.PageResult[models.User], error)
	GetUserByUsername(ctx context.Context, username string) (*models.User, error)
	UpdateUserQuota(ctx context.Context, username string, quotaBytes int64) error
	GetUserDrive(ctx context.Context, username string) (*models.UserDriveAllocation, error)
	GetDriveAvailableBytes(ctx context.Context, driveID uuid.UUID) (int64, error)

	// Banned IPs
	ListBannedIPs(ctx context.Context, activeOnly bool, in db.PageInput) (*db.PageResult[models.BannedIP], error)
	UnbanIP(ctx context.Context, id int64) error
	ExtendBan(ctx context.Context, id int64) error
	AddBannedIP(ctx context.Context, ip, jail string) error

	// User bans / suspensions
	CreateBan(ctx context.Context, p db.CreateBanParams) (*models.UserBan, error)
	GetActiveBan(ctx context.Context, username string) (*models.UserBan, error)
	PardonAllActiveBans(ctx context.Context, username, pardonedBy string) error
	ListUserBans(ctx context.Context, activeOnly bool, in db.PageInput) (*db.PageResult[models.UserBan], error)

	// Infrastructure
	GetDriveSummaries(ctx context.Context) ([]models.DriveSummary, error)
	GetMaxAvailableQuota(ctx context.Context) (int64, error)
	CountServersByState(ctx context.Context, state string) (int, error)
	CreateServer(ctx context.Context, p db.CreateServerParams) (*models.Server, error)
	SetServerActive(ctx context.Context, id uuid.UUID, active bool) error
	GetServer(ctx context.Context, id uuid.UUID) (*models.Server, error)
	GetDrive(ctx context.Context, id uuid.UUID) (*models.Drive, error)
	CreateDrive(ctx context.Context, p db.CreateDriveParams) (*models.Drive, error)
	UpdateDrive(ctx context.Context, id uuid.UUID, p db.UpdateDriveParams) (*models.Drive, error)

	// Alarm settings
	GetAlarmSettings(ctx context.Context) (*models.AlarmSettings, error)
	SetAlarmSubscription(ctx context.Context, alarmType, email string, subscribe bool) (*models.AlarmSettings, error)
	ListSnapshotsWindow(ctx context.Context, window time.Duration) ([]models.ServerMetricSnapshot, error)

	// Interest form
	ListInterestSubmissions(ctx context.Context, in db.PageInput) (*db.PageResult[models.InterestSubmission], error)
	GetInterestFormSettings(ctx context.Context) (*models.InterestFormSettings, error)
	UpdateInterestFormSettings(ctx context.Context, dailyCap int) (*models.InterestFormSettings, error)
	GetInterestSubmissionByID(ctx context.Context, id uuid.UUID) (*models.InterestSubmission, error)
	MarkInterestSubmissionProvisioned(ctx context.Context, id uuid.UUID, invitationID uuid.UUID) error
}

// AdminInviteService is the subset of *services.InviteService used by admin handlers.
type AdminInviteService interface {
	Create(ctx context.Context, invitedByUserID uuid.UUID, invitedByUsername, email string, initialQuotaBytes int64, grantAdmin bool, grantPremium bool) (*models.Invitation, error)
	List(ctx context.Context, page db.PageInput) (*db.PageResult[models.Invitation], error)
	InvitationURL(token string) string
	Resend(ctx context.Context, id uuid.UUID, byUsername string) error
	Revoke(ctx context.Context, id uuid.UUID) error
}

// MetricsServicer is the subset of *services.MetricsService used by admin
// handlers. The interface exists so tests can supply lightweight stubs without
// a running metrics background goroutine or a real database.
type MetricsServicer interface {
	GetLatest(ctx context.Context) (*models.ServerMetricSnapshot, error)
	GetHistory(ctx context.Context, page db.PageInput) (*db.PageResult[models.ServerMetricSnapshot], error)
	GetHistoryByHours(ctx context.Context, hours int) ([]models.ServerMetricSnapshot, error)
	GetHistoryByDate(ctx context.Context, date string, page db.PageInput) (*db.PageResult[models.ServerMetricSnapshot], error)
	Hub() *services.Hub
}

// Compile-time checks: ensure the concrete types satisfy the interfaces.
var _ AdminQuerier = (*db.Queries)(nil)
var _ AdminInviteService = (*services.InviteService)(nil)
var _ MetricsServicer = (*services.MetricsService)(nil)
