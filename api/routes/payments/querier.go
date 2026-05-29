package payments

import (
	"context"
	"encoding/json"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// Querier is the subset of *db.Queries used by the payments handler. The
// payment service has its own narrow surface; only the handler-direct
// reads/writes (user lookup) live here.
type Querier interface {
	GetUserByUsername(ctx context.Context, username string) (*models.User, error)
}

// Compile-time check.
var _ Querier = (*db.Queries)(nil)

// jsonUnmarshal aliases encoding/json.Unmarshal so handler.go can decode
// without an extra import line.
var jsonUnmarshal = json.Unmarshal
