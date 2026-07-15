package admin

import (
	"context"

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
	ListAdminUsers(ctx context.Context, f db.ListUsersFilter, limit, offset int) ([]models.User, int, error)
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
	RenameServer(ctx context.Context, id uuid.UUID, name string) error
	GetServer(ctx context.Context, id uuid.UUID) (*models.Server, error)
	GetServerByEndpoint(ctx context.Context, endpoint string) (*models.Server, error)
	ListServers(ctx context.Context) ([]models.Server, error)
	DeleteServer(ctx context.Context, id uuid.UUID) error
	GetDrive(ctx context.Context, id uuid.UUID) (*models.Drive, error)
	ListDrives(ctx context.Context, serverID uuid.UUID) ([]models.Drive, error)
	CreateDrive(ctx context.Context, p db.CreateDriveParams) (*models.Drive, error)
	UpdateDrive(ctx context.Context, id uuid.UUID, p db.UpdateDriveParams) (*models.Drive, error)
	UpsertDrive(ctx context.Context, p db.UpsertDriveParams) (*models.Drive, error)
	AdoptNodeDrive(ctx context.Context, serverID, nodeID uuid.UUID, p db.UpsertDriveParams) (*models.Drive, error)
	ReassignDriveToServer(ctx context.Context, driveID, serverID uuid.UUID, nodeID *uuid.UUID) error
	DeleteDrive(ctx context.Context, id uuid.UUID) error
	DeactivateMissingDrives(ctx context.Context, serverID uuid.UUID, keepIDs []uuid.UUID) error
	UpdateDriveCapacity(ctx context.Context, id uuid.UUID, capacityBytes int64) (*models.Drive, error)
	AutoSyncDriveCapacities(ctx context.Context, capacityBytes int64) error
	ListAllNodeDisks(ctx context.Context) ([]models.NodeDisk, error)

	// Nodes (storage-node layer between servers and drives)
	GetNodeSummaries(ctx context.Context) ([]models.NodeSummary, error)
	GetNode(ctx context.Context, id uuid.UUID) (*models.Node, error)
	CreateNode(ctx context.Context, p db.CreateNodeParams) (*models.Node, error)
	UpdateNode(ctx context.Context, id uuid.UUID, p db.UpdateNodeParams) (*models.Node, error)
	UpsertNode(ctx context.Context, p db.CreateNodeParams, isActive bool) (*models.Node, error)
	DeleteNode(ctx context.Context, id uuid.UUID) error
	DeactivateMissingNodes(ctx context.Context, serverID uuid.UUID, keepIDs []uuid.UUID) error
	AssignDriveToNode(ctx context.Context, driveID uuid.UUID, nodeID *uuid.UUID) error

	// Alarm subscriptions
	ListAlarmSubscriptions(ctx context.Context) ([]models.AlarmSubscription, error)
	ListAlarmSubscriptionsByEmail(ctx context.Context, email string) ([]models.AlarmSubscription, error)
	UpsertAlarmSubscription(ctx context.Context, email, alarmType string, nodeID, driveID *uuid.UUID, threshold float64) (*models.AlarmSubscription, error)
	DeleteAlarmSubscription(ctx context.Context, email, alarmType string, nodeID, driveID *uuid.UUID) error

	// Product pricing (admin pricing page)
	ListPricingServers(ctx context.Context) ([]db.PricingServer, error)
	ListPricingItems(ctx context.Context, serverID uuid.UUID) ([]models.PricingItem, error)
	GetPricingItem(ctx context.Context, id uuid.UUID) (*models.PricingItem, error)
	CreatePricingItem(ctx context.Context, p db.CreatePricingItemParams) (*models.PricingItem, error)
	UpdatePricingItem(ctx context.Context, id uuid.UUID, bytes int64, priceCents, sortOrder int) (*models.PricingItem, error)
	DeletePricingItem(ctx context.Context, id uuid.UUID) error
	ListActivePricingDiscounts(ctx context.Context, serverID uuid.UUID) ([]models.PricingDiscount, error)
	CreatePricingDiscount(ctx context.Context, d *models.PricingDiscount) error
	DeletePricingDiscount(ctx context.Context, id uuid.UUID) error
	ListDiscountRecipients(ctx context.Context, group string, serverID uuid.UUID, storageType string, premiumOnly bool) ([]string, error)

	// Interest form
	ListInterestSubmissions(ctx context.Context, in db.PageInput) (*db.PageResult[models.InterestSubmission], error)
	GetInterestFormSettings(ctx context.Context) (*models.InterestFormSettings, error)
	UpdateInterestFormSettings(ctx context.Context, dailyCap int) (*models.InterestFormSettings, error)
	GetInterestSubmissionByID(ctx context.Context, id uuid.UUID) (*models.InterestSubmission, error)
	MarkInterestSubmissionProvisioned(ctx context.Context, id uuid.UUID, invitationID uuid.UUID) error
	DenyInterestSubmission(ctx context.Context, id uuid.UUID, refundID string) error
}

// AdminInviteService is the subset of *services.InviteService used by admin handlers.
type AdminInviteService interface {
	Create(ctx context.Context, invitedByUserID uuid.UUID, invitedByUsername, email string, initialQuotaBytes int64, grantAdmin bool, grantPremium bool, initialDriveID *uuid.UUID) (*models.Invitation, error)
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
	GetNodeHistoryByHours(ctx context.Context, nodeID uuid.UUID, hours int) ([]models.NodeMetricSnapshot, error)
	GetDriveTempHistoryByHours(ctx context.Context, driveID uuid.UUID, hours int) ([]models.DriveTempSnapshot, error)
	GetNodeDisks(ctx context.Context, nodeID uuid.UUID) ([]models.NodeDisk, error)
	GetNodeDiskTempHistoryByHours(ctx context.Context, diskID uuid.UUID, hours int) ([]models.NodeDiskTempSnapshot, error)
	GetDriveIOHistoryByHours(ctx context.Context, driveID uuid.UUID, hours int) ([]models.DriveIOSnapshot, error)
	GetNodeDiskIOHistoryByHours(ctx context.Context, diskID uuid.UUID, hours int) ([]models.NodeDiskIOSnapshot, error)
	NodeStates(ctx context.Context) ([]models.NodeFrame, error)
	Hub() *services.Hub
}

// Compile-time checks: ensure the concrete types satisfy the interfaces.
var _ AdminQuerier = (*db.Queries)(nil)
var _ AdminInviteService = (*services.InviteService)(nil)
var _ MetricsServicer = (*services.MetricsService)(nil)
