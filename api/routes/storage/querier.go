package storage

import (
	"context"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// Querier is the subset of db.Queries used by this package.
type Querier interface {
	ListServerCapacities(ctx context.Context) ([]db.ServerCapacity, error)
	GetUserStorageBreakdown(ctx context.Context, userID string) (db.UserStorageBreakdown, error)
	GetUserDrive(ctx context.Context, username string) (*models.UserDriveAllocation, error)
	GetUserDrives(ctx context.Context, username, userID string) ([]db.UserDriveInfo, error)
	SetPrimaryDrive(ctx context.Context, username string, driveID uuid.UUID) error
	GetUserByUsername(ctx context.Context, username string) (*models.User, error)
}
