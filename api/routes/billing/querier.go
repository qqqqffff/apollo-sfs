package billing

import (
	"context"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// Querier is the subset of *db.Queries used by the billing handler.
type Querier interface {
	GetUserByUsername(ctx context.Context, username string) (*models.User, error)
	CreateStorageOrder(ctx context.Context, o *models.StorageOrder) error
	GetStorageOrderByPayPalOrderID(ctx context.Context, orderID string) (*models.StorageOrder, error)
	MarkStorageOrderCaptured(ctx context.Context, orderID, captureID string, raw []byte) (bool, error)
	AddUserQuota(ctx context.Context, username string, bytesAdded int64) (int64, error)
	GetUserDrive(ctx context.Context, username string) (*models.UserDriveAllocation, error)
	GetDriveAvailableBytes(ctx context.Context, driveID uuid.UUID) (int64, error)
	GetServer(ctx context.Context, id uuid.UUID) (*models.Server, error)
	GetServerCapacity(ctx context.Context, serverID uuid.UUID, driveType string) (*db.ServerCapacity, error)
	ListUserOrders(ctx context.Context, username string) ([]db.AdminOrder, error)
}

// Compile-time check.
var _ Querier = (*db.Queries)(nil)
