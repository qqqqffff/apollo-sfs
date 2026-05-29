package sfs

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// ResolvePath walks the folder chain identified by segments under userID's
// namespace. When createMissing is true, any folder in the chain that does
// not yet exist is created in the same transaction the caller passes — so
// downstream failures (quota, conflict, etc.) roll back the partial
// creations.
//
// Returns the leaf folder's ID, or nil when segments is empty (= root).
// The caller is responsible for the transaction lifecycle; this function
// only reads/writes through the supplied *db.Queries.
func ResolvePath(ctx context.Context, q *db.Queries, userID uuid.UUID, segments []string, createMissing bool) (*uuid.UUID, error) {
	var parent *uuid.UUID
	for _, name := range segments {
		f, err := q.FindFolderByParentAndName(ctx, userID, parent, name)
		if err == nil {
			id := f.ID
			parent = &id
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("resolve path %q: %w", name, err)
		}
		if !createMissing {
			return nil, fmt.Errorf("resolve path: folder %q not found", name)
		}
		created, err := q.CreateFolder(ctx, &models.Folder{
			UserID:   userID,
			ParentID: parent,
			Name:     name,
			Kind:     models.FolderKindRegular,
		})
		if err != nil {
			return nil, fmt.Errorf("resolve path: create %q: %w", name, err)
		}
		id := created.ID
		parent = &id
	}
	return parent, nil
}

// LookupFolderByPath is the read-only convenience wrapper used by /list.
// Returns the resolved folder ID or nil for root; an empty segments slice
// always returns (nil, nil).
func LookupFolderByPath(ctx context.Context, q *db.Queries, userID uuid.UUID, segments []string) (*uuid.UUID, error) {
	if len(segments) == 0 {
		return nil, nil
	}
	return ResolvePath(ctx, q, userID, segments, false)
}
