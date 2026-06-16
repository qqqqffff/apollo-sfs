package expansion

import (
	"context"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// Querier is the subset of *db.Queries used by the expansion handler.
type Querier interface {
	GetUserByUsername(ctx context.Context, username string) (*models.User, error)
	GetServer(ctx context.Context, id uuid.UUID) (*models.Server, error)
	GetUserDrive(ctx context.Context, username string) (*models.UserDriveAllocation, error)
	GetDriveAvailableBytes(ctx context.Context, driveID uuid.UUID) (int64, error)
	AddUserQuota(ctx context.Context, username string, bytesAdded int64) (int64, error)
	ListAdminEmails(ctx context.Context) ([]string, error)

	CreateExpansionRequest(ctx context.Context, p db.CreateExpansionRequestParams) (*models.ServerExpansionRequest, error)
	GetExpansionRequestByID(ctx context.Context, id uuid.UUID) (*models.ServerExpansionRequest, error)
	GetExpansionRequestByPayPalOrderID(ctx context.Context, orderID string) (*models.ServerExpansionRequest, error)
	MarkExpansionRequestCaptured(ctx context.Context, orderID, captureID string) (bool, error)
	MarkExpansionRequestExpanded(ctx context.Context, id uuid.UUID, paymentWindowDays int) (bool, error)
	ListExpansionRequests(ctx context.Context, f db.ExpansionRequestFilter, in db.PageInput) (*db.PageResult[models.ServerExpansionRequest], error)
	FulfillExpansionRequest(ctx context.Context, id uuid.UUID, postQuotaBytes int64) (bool, error)
	CancelExpansionRequest(ctx context.Context, id uuid.UUID, refundID, reason string) (bool, error)
	ExpireExpansionRequest(ctx context.Context, id uuid.UUID, refundID string) error
	ForfeitExpansionRequest(ctx context.Context, id uuid.UUID) error
	ListExpiredOpenRequests(ctx context.Context) ([]models.ServerExpansionRequest, error)
	ListExpiredExpandedRequests(ctx context.Context) ([]models.ServerExpansionRequest, error)
}

// expiryAt returns the canonical expiry time for a new expansion request.
func expiryAt(from time.Time) time.Time {
	return from.AddDate(0, 0, 14)
}

// Compile-time check.
var _ Querier = (*db.Queries)(nil)
