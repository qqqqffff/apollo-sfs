package services

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// FavoriteList is returned by List. Files and folders are kept in separate
// slices so the caller does not need a type discriminator.
type FavoriteList struct {
	Files   []models.File   `json:"files"`
	Folders []models.Folder `json:"folders"`
}

// FavoriteService handles favoriting and unfavoriting files and folders.
type FavoriteService struct {
	queries *db.Queries
}

// NewFavoriteService constructs a FavoriteService.
func NewFavoriteService(q *db.Queries) *FavoriteService {
	return &FavoriteService{queries: q}
}

// List returns all files and folders favorited by userID, each ordered newest
// favorite first.
func (s *FavoriteService) List(ctx context.Context, userID uuid.UUID) (*FavoriteList, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list favorites: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	files, err := q.ListFavoritedFiles(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list favorite files: %w", err)
	}
	folders, err := q.ListFavoritedFolders(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list favorite folders: %w", err)
	}

	// Return empty slices rather than null in JSON.
	if files == nil {
		files = []models.File{}
	}
	if folders == nil {
		folders = []models.Folder{}
	}

	return &FavoriteList{Files: files, Folders: folders}, nil
}

// AddFile favorites a file for userID. Returns ErrNotFound if the file does
// not exist. Returns ErrAlreadyFavorited if the user has already favorited it.
func (s *FavoriteService) AddFile(ctx context.Context, userID, fileID uuid.UUID) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("add file favorite: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := q.GetFileByID(ctx, fileID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("get file: %w", err)
	}
	if err := q.AddFileFavorite(ctx, userID, fileID); err != nil {
		if isDuplicateKeyError(err) {
			return ErrAlreadyFavorited
		}
		return fmt.Errorf("add file favorite: %w", err)
	}
	return tx.Commit()
}

// RemoveFile removes the favorite for a file. A no-op (not an error) if the
// file was not favorited.
func (s *FavoriteService) RemoveFile(ctx context.Context, userID, fileID uuid.UUID) error {
	if err := s.queries.RemoveFileFavorite(ctx, userID, fileID); err != nil {
		return fmt.Errorf("remove file favorite: %w", err)
	}
	return nil
}

// AddFolder favorites a folder for userID. Returns ErrFolderNotFound if the
// folder does not exist or is not owned by userID. Returns ErrAlreadyFavorited
// if the user has already favorited the folder.
func (s *FavoriteService) AddFolder(ctx context.Context, userID, folderID uuid.UUID) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("add folder favorite: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := q.GetFolderByID(ctx, folderID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrFolderNotFound
		}
		return fmt.Errorf("get folder: %w", err)
	}
	if err := q.AddFolderFavorite(ctx, userID, folderID); err != nil {
		if isDuplicateKeyError(err) {
			return ErrAlreadyFavorited
		}
		return fmt.Errorf("add folder favorite: %w", err)
	}
	return tx.Commit()
}

// RemoveFolder removes the favorite for a folder. A no-op (not an error) if
// the folder was not favorited.
func (s *FavoriteService) RemoveFolder(ctx context.Context, userID, folderID uuid.UUID) error {
	if err := s.queries.RemoveFolderFavorite(ctx, userID, folderID); err != nil {
		return fmt.Errorf("remove folder favorite: %w", err)
	}
	return nil
}

// ── Sentinel errors ───────────────────────────────────────────────────────────

var ErrAlreadyFavorited = errors.New("item is already in favorites")
