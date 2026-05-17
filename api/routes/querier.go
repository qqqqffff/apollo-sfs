package routes

import (
	"context"

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

	// Search
	SearchFoldersByUser(ctx context.Context, userID uuid.UUID, term string, in db.PageInput) (*db.PageResult[models.Folder], error)
	SearchFilesByUser(ctx context.Context, userID uuid.UUID, term string, in db.PageInput) (*db.PageResult[models.File], error)

	// Interest form
	GetInterestFormSettings(ctx context.Context) (*models.InterestFormSettings, error)
	CountInterestSubmissionsToday(ctx context.Context) (int, error)
	CountInterestSubmissionsFromIP(ctx context.Context, ip string) (int, error)
	ExistsInterestSubmissionByEmail(ctx context.Context, email string) (bool, error)
	CreateInterestSubmission(ctx context.Context, s *models.InterestSubmission) error
	ListAdminEmails(ctx context.Context) ([]string, error)
}
