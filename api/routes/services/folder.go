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

// ── Types ─────────────────────────────────────────────────────────────────────

// FolderContents is returned by ListRoot and GetContents. It bundles the
// folder's own metadata with paginated lists of its direct children.
// Folder is nil when listing the virtual root (parent_id IS NULL).
type FolderContents struct {
	Folder     *models.Folder              `json:"folder"`
	Subfolders *db.PageResult[models.Folder] `json:"subfolders"`
	Files      *db.PageResult[models.File]   `json:"files"`
}

// ── Service ───────────────────────────────────────────────────────────────────

// FolderService implements folder CRUD and content listing.
// The folder hierarchy is virtual — it exists only in PostgreSQL; MinIO has
// no knowledge of it.
type FolderService struct {
	queries *db.Queries
}

// NewFolderService constructs a FolderService.
func NewFolderService(q *db.Queries) *FolderService {
	return &FolderService{queries: q}
}

// ── Public operations ─────────────────────────────────────────────────────────

// ListRoot returns the top-level folders (parent_id IS NULL) and root-level
// files for the given userID, with independent pagination for each list.
// When folderPage.Skip or filePage.Skip is true the corresponding list is
// returned as an empty page without hitting the database.
func (s *FolderService) ListRoot(
	ctx context.Context,
	userID uuid.UUID,
	folderPage, filePage db.PageInput,
) (*FolderContents, error) {
	var subfolders *db.PageResult[models.Folder]
	if folderPage.Skip {
		subfolders = emptyFolders()
	} else {
		var err error
		subfolders, err = s.queries.ListRootFolders(ctx, userID, folderPage)
		if err != nil {
			return nil, fmt.Errorf("list root folders: %w", err)
		}
	}

	var files *db.PageResult[models.File]
	if filePage.Skip {
		files = emptyFiles()
	} else {
		var err error
		files, err = s.listRootFiles(ctx, userID, filePage)
		if err != nil {
			return nil, fmt.Errorf("list root files: %w", err)
		}
	}

	return &FolderContents{
		Folder:     nil, // root has no parent folder record
		Subfolders: subfolders,
		Files:      files,
	}, nil
}

// GetContents returns a folder's metadata and its direct children (subfolders
// and files). Returns ErrFolderNotFound if the folder does not exist or is not
// owned by userID.
// When folderPage.Skip or filePage.Skip is true the corresponding list is
// returned as an empty page without hitting the database.
func (s *FolderService) GetContents(
	ctx context.Context,
	folderID, userID uuid.UUID,
	folderPage, filePage db.PageInput,
) (*FolderContents, error) {
	folder, err := s.getOwned(ctx, folderID, userID)
	if err != nil {
		return nil, err
	}

	var subfolders *db.PageResult[models.Folder]
	if folderPage.Skip {
		subfolders = emptyFolders()
	} else {
		subfolders, err = s.queries.ListFoldersByParent(ctx, userID, folderID, folderPage)
		if err != nil {
			return nil, fmt.Errorf("list subfolders: %w", err)
		}
	}

	var files *db.PageResult[models.File]
	if filePage.Skip {
		files = emptyFiles()
	} else {
		files, err = s.queries.ListFilesByFolder(ctx, folderID, filePage)
		if err != nil {
			return nil, fmt.Errorf("list files: %w", err)
		}
	}

	return &FolderContents{
		Folder:     folder,
		Subfolders: subfolders,
		Files:      files,
	}, nil
}

// Create inserts a new folder owned by userID. If parentID is non-nil the
// parent folder must exist and be owned by the same user.
// Returns ErrFolderNotFound if the parent does not belong to userID.
// Returns ErrDuplicateFolderName if a sibling with the same name already exists
// (enforced by the DB unique constraint on user_id, parent_id, name).
func (s *FolderService) Create(
	ctx context.Context,
	userID uuid.UUID,
	parentID *uuid.UUID,
	name string,
) (*models.Folder, error) {
	// Verify the parent folder exists and belongs to this user.
	if parentID != nil {
		if _, err := s.getOwned(ctx, *parentID, userID); err != nil {
			return nil, err
		}
	}

	folder, err := s.queries.CreateFolder(ctx, &models.Folder{
		UserID:   userID,
		ParentID: parentID,
		Name:     name,
	})
	if err != nil {
		// The DB unique constraint on (user_id, parent_id, name) produces a
		// duplicate key error when a sibling with the same name already exists.
		if isDuplicateKeyError(err) {
			return nil, ErrDuplicateFolderName
		}
		return nil, fmt.Errorf("create folder: %w", err)
	}
	return folder, nil
}

// Rename changes a folder's display name. Returns ErrFolderNotFound if the
// folder does not belong to userID.
func (s *FolderService) Rename(
	ctx context.Context,
	folderID, userID uuid.UUID,
	name string,
) (*models.Folder, error) {
	if _, err := s.getOwned(ctx, folderID, userID); err != nil {
		return nil, err
	}

	updated, err := s.queries.UpdateFolderName(ctx, folderID, name)
	if err != nil {
		if isDuplicateKeyError(err) {
			return nil, ErrDuplicateFolderName
		}
		return nil, fmt.Errorf("rename folder: %w", err)
	}
	return updated, nil
}

// Delete removes an empty folder. Returns ErrFolderNotFound if the folder does
// not belong to userID, and ErrFolderNotEmpty if it still contains files or
// subfolders (the caller must delete children first).
func (s *FolderService) Delete(ctx context.Context, folderID, userID uuid.UUID) error {
	if _, err := s.getOwned(ctx, folderID, userID); err != nil {
		return err
	}

	hasChildren, err := s.queries.HasFolderChildren(ctx, folderID)
	if err != nil {
		return fmt.Errorf("delete folder: check children: %w", err)
	}
	if hasChildren {
		return ErrFolderNotEmpty
	}

	if err := s.queries.DeleteFolder(ctx, folderID); err != nil {
		return fmt.Errorf("delete folder: %w", err)
	}
	return nil
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func emptyFolders() *db.PageResult[models.Folder] {
	return &db.PageResult[models.Folder]{Items: []models.Folder{}}
}

func emptyFiles() *db.PageResult[models.File] {
	return &db.PageResult[models.File]{Items: []models.File{}}
}

// getOwned fetches a folder and verifies it belongs to userID.
// Returns ErrFolderNotFound for both missing and foreign-owned folders so the
// caller cannot distinguish the two cases (prevents existence leaking).
func (s *FolderService) getOwned(ctx context.Context, folderID, userID uuid.UUID) (*models.Folder, error) {
	folder, err := s.queries.GetFolderByID(ctx, folderID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrFolderNotFound
		}
		return nil, fmt.Errorf("get folder: %w", err)
	}
	if folder.UserID != userID {
		return nil, ErrFolderNotFound
	}
	return folder, nil
}

// listRootFiles returns files that are directly in the root (their folder_id
// references a root folder owned by this user). Since files always belong to
// a specific folder in the schema, "root files" means files in any root-level
// folder. This queries files by user across all root folders.
//
// NOTE: The current schema requires every file to have a folder_id — there is
// no concept of truly folder-less files. Root-level files are those whose
// containing folder has parent_id IS NULL. This query fetches them via a join.
func (s *FolderService) listRootFiles(ctx context.Context, userID uuid.UUID, page db.PageInput) (*db.PageResult[models.File], error) {
	return s.queries.ListRootFiles(ctx, userID, page)
}

// isDuplicateKeyError checks whether a DB error is a PostgreSQL unique
// constraint violation (SQLSTATE 23505).
func isDuplicateKeyError(err error) bool {
	return err != nil && (contains(err.Error(), "23505") || contains(err.Error(), "unique constraint") || contains(err.Error(), "duplicate key"))
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && indexStr(s, sub) >= 0)
}

func indexStr(s, sub string) int {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// ── Sentinel errors ───────────────────────────────────────────────────────────

// ErrFolderNotFound is returned when a folder does not exist or does not belong
// to the requesting user. Using a single error prevents leaking folder existence.
var ErrFolderNotFound = errors.New("folder not found")

// ErrFolderNotEmpty is returned when attempting to delete a folder that still
// contains subfolders or files.
var ErrFolderNotEmpty = errors.New("folder is not empty — delete its contents first")

// ErrDuplicateFolderName is returned when a sibling folder with the same name
// already exists in the target parent.
var ErrDuplicateFolderName = errors.New("a folder with that name already exists here")
