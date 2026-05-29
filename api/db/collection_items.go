package db

import (
	"context"
	"fmt"

	"github.com/google/uuid"
)

// AddCollectionItem inserts a pointer placing fileID into the subcollection
// collectionID without moving the file's physical home. Returns a duplicate-key
// error (detectable via the service layer) if the pointer already exists.
func (q *Queries) AddCollectionItem(ctx context.Context, userID, collectionID, fileID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		INSERT INTO collection_items (user_id, collection_id, file_id)
		VALUES ($1, $2, $3)
	`, userID, collectionID, fileID)
	if err != nil {
		return fmt.Errorf("AddCollectionItem: %w", err)
	}
	return nil
}

// RemoveCollectionItem deletes the pointer linking fileID to collectionID.
// A no-op (not an error) if the pointer does not exist.
func (q *Queries) RemoveCollectionItem(ctx context.Context, collectionID, fileID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		DELETE FROM collection_items WHERE collection_id = $1 AND file_id = $2
	`, collectionID, fileID)
	if err != nil {
		return fmt.Errorf("RemoveCollectionItem: %w", err)
	}
	return nil
}

// MoveCollectionItem repoints fileID from one subcollection to another.
// Returns a duplicate-key error if a pointer already exists in the target.
func (q *Queries) MoveCollectionItem(ctx context.Context, fileID, fromCollectionID, toCollectionID uuid.UUID) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE collection_items SET collection_id = $3
		WHERE file_id = $1 AND collection_id = $2
	`, fileID, fromCollectionID, toCollectionID)
	if err != nil {
		return fmt.Errorf("MoveCollectionItem: %w", err)
	}
	return nil
}

// IsCollectionItem reports whether a pointer linking fileID to collectionID exists.
func (q *Queries) IsCollectionItem(ctx context.Context, collectionID, fileID uuid.UUID) (bool, error) {
	var exists bool
	err := q.db.QueryRowContext(ctx, `
		SELECT EXISTS(SELECT 1 FROM collection_items WHERE collection_id = $1 AND file_id = $2)
	`, collectionID, fileID).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("IsCollectionItem: %w", err)
	}
	return exists, nil
}
