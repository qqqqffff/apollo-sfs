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

// GetAncestors returns the breadcrumb chain from root → leaf ending at
// folderID. Wrapped in ForUser so RLS confirms ownership in a single round
// trip. Returns an empty slice (not nil, not an error) when folderID does
// not belong to userID, matching the "treat-as-not-found" pattern used in
// the rest of the package.
func (s *FolderService) GetAncestors(ctx context.Context, folderID, userID uuid.UUID) ([]models.Folder, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("ancestors: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	return q.GetFolderAncestors(ctx, userID, folderID)
}

// ListRoot returns the top-level folders (parent_id IS NULL) and root-level
// files for the given userID, with independent pagination for each list.
// When folderPage.Skip or filePage.Skip is true the corresponding list is
// returned as an empty page without hitting the database.
func (s *FolderService) ListRoot(
	ctx context.Context,
	userID uuid.UUID,
	folderPage, filePage db.PageInput,
) (*FolderContents, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list root: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var subfolders *db.PageResult[models.Folder]
	if folderPage.Skip {
		subfolders = emptyFolders()
	} else {
		subfolders, err = q.ListRootFolders(ctx, userID, folderPage)
		if err != nil {
			return nil, fmt.Errorf("list root folders: %w", err)
		}
	}

	var files *db.PageResult[models.File]
	if filePage.Skip {
		files = emptyFiles()
	} else {
		files, err = q.ListRootFiles(ctx, userID, filePage)
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
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get contents: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	folder, err := s.getOwned(ctx, q, folderID, userID)
	if err != nil {
		return nil, err
	}

	var subfolders *db.PageResult[models.Folder]
	if folderPage.Skip {
		subfolders = emptyFolders()
	} else {
		subfolders, err = q.ListFoldersByParent(ctx, userID, folderID, folderPage)
		if err != nil {
			return nil, fmt.Errorf("list subfolders: %w", err)
		}
	}

	var files *db.PageResult[models.File]
	if filePage.Skip {
		files = emptyFiles()
	} else {
		files, err = q.ListFilesByFolder(ctx, folderID, filePage)
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
// kind is "regular" or "media"; an empty or unknown value defaults to regular.
// A folder created beneath a media folder inherits the media kind so the whole
// subtree behaves as a collection (its descendants are subcollections).
// Returns ErrFolderNotFound if the parent does not belong to userID.
// Returns ErrDuplicateFolderName if a sibling with the same name already exists
// (enforced by the DB unique constraint on user_id, parent_id, name).
func (s *FolderService) Create(
	ctx context.Context,
	userID uuid.UUID,
	parentID *uuid.UUID,
	name string,
	kind string,
) (*models.Folder, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("create folder: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if kind != models.FolderKindMedia {
		kind = models.FolderKindRegular
	}

	// Verify the parent folder exists and belongs to this user. A child of a
	// media folder is itself a media subcollection.
	if parentID != nil {
		parent, err := s.getOwned(ctx, q, *parentID, userID)
		if err != nil {
			return nil, err
		}
		if parent.Kind == models.FolderKindMedia {
			kind = models.FolderKindMedia
		}
	}

	folder, err := q.CreateFolder(ctx, &models.Folder{
		UserID:   userID,
		ParentID: parentID,
		Name:     name,
		Kind:     kind,
	})
	if err != nil {
		if isDuplicateKeyError(err) {
			return nil, ErrDuplicateFolderName
		}
		return nil, fmt.Errorf("create folder: %w", err)
	}
	return folder, tx.Commit()
}

// GetMediaContents returns a media folder's metadata, its direct subcollections,
// and its media files (physical residents plus pointers), ordered per sort and
// filtered by hidden state. Returns ErrFolderNotFound if the folder does not
// belong to userID, ErrNotMediaCollection if it is not a media folder.
func (s *FolderService) GetMediaContents(
	ctx context.Context,
	folderID, userID uuid.UUID,
	sort db.MediaSort,
	hidden db.HiddenFilter,
	folderPage, filePage db.PageInput,
) (*FolderContents, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get media contents: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	folder, err := s.getOwned(ctx, q, folderID, userID)
	if err != nil {
		return nil, err
	}
	if folder.Kind != models.FolderKindMedia {
		return nil, ErrNotMediaCollection
	}

	var subfolders *db.PageResult[models.Folder]
	if folderPage.Skip {
		subfolders = emptyFolders()
	} else {
		subfolders, err = q.ListFoldersByParent(ctx, userID, folderID, folderPage)
		if err != nil {
			return nil, fmt.Errorf("get media contents: subfolders: %w", err)
		}
	}

	var files *db.PageResult[models.File]
	if filePage.Skip {
		files = emptyFiles()
	} else {
		files, err = q.ListMediaFiles(ctx, folderID, sort, hidden, filePage)
		if err != nil {
			return nil, fmt.Errorf("get media contents: files: %w", err)
		}
	}

	return &FolderContents{
		Folder:     folder,
		Subfolders: subfolders,
		Files:      files,
	}, nil
}

// CopyToSubcollection adds a pointer placing fileID into the subcollection
// collectionID without moving the file's physical home. Both must belong to
// userID and collectionID must be a media folder. A duplicate pointer is a no-op.
func (s *FolderService) CopyToSubcollection(ctx context.Context, userID, collectionID, fileID uuid.UUID) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("copy to subcollection: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	coll, err := s.getOwned(ctx, q, collectionID, userID)
	if err != nil {
		return err
	}
	if coll.Kind != models.FolderKindMedia {
		return ErrNotMediaCollection
	}
	if _, err := q.GetFileByID(ctx, fileID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("copy to subcollection: get file: %w", err)
	}
	if err := q.AddCollectionItem(ctx, userID, collectionID, fileID); err != nil {
		if isDuplicateKeyError(err) {
			return tx.Commit() // already present — treat as success
		}
		return fmt.Errorf("copy to subcollection: %w", err)
	}
	return tx.Commit()
}

// MoveSubcollectionItem repoints fileID from one subcollection to another.
// All ids must belong to userID and the target must be a media folder.
func (s *FolderService) MoveSubcollectionItem(ctx context.Context, userID, fileID, fromCollectionID, toCollectionID uuid.UUID) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("move subcollection item: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := s.getOwned(ctx, q, fromCollectionID, userID); err != nil {
		return err
	}
	target, err := s.getOwned(ctx, q, toCollectionID, userID)
	if err != nil {
		return err
	}
	if target.Kind != models.FolderKindMedia {
		return ErrNotMediaCollection
	}
	if err := q.MoveCollectionItem(ctx, fileID, fromCollectionID, toCollectionID); err != nil {
		if isDuplicateKeyError(err) {
			return ErrDuplicateFolderName
		}
		return fmt.Errorf("move subcollection item: %w", err)
	}
	return tx.Commit()
}

// RemoveFromSubcollection deletes the pointer linking fileID to collectionID.
// The file's physical home is unaffected. A missing pointer is a no-op.
func (s *FolderService) RemoveFromSubcollection(ctx context.Context, userID, collectionID, fileID uuid.UUID) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("remove from subcollection: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := s.getOwned(ctx, q, collectionID, userID); err != nil {
		return err
	}
	if err := q.RemoveCollectionItem(ctx, collectionID, fileID); err != nil {
		return fmt.Errorf("remove from subcollection: %w", err)
	}
	return tx.Commit()
}

// Rename changes a folder's display name. Returns ErrFolderNotFound if the
// folder does not belong to userID.
func (s *FolderService) Rename(
	ctx context.Context,
	folderID, userID uuid.UUID,
	name string,
) (*models.Folder, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("rename folder: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := s.getOwned(ctx, q, folderID, userID); err != nil {
		return nil, err
	}
	updated, err := q.UpdateFolderName(ctx, folderID, name)
	if err != nil {
		if isDuplicateKeyError(err) {
			return nil, ErrDuplicateFolderName
		}
		return nil, fmt.Errorf("rename folder: %w", err)
	}
	return updated, tx.Commit()
}

// Move reparents folderID under targetID. Both folders must be owned by
// userID. Returns ErrFolderCycle if the move would create a cycle (including
// dropping a folder onto itself). Returns ErrDuplicateFolderName if a sibling
// with the same name already exists in the target.
func (s *FolderService) Move(
	ctx context.Context,
	folderID, targetID, userID uuid.UUID,
) (*models.Folder, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("move folder: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := s.getOwned(ctx, q, folderID, userID); err != nil {
		return nil, err
	}
	if _, err := s.getOwned(ctx, q, targetID, userID); err != nil {
		return nil, ErrFolderNotFound
	}

	cycle, err := s.queries.FolderWouldCreateCycle(ctx, folderID, targetID)
	if err != nil {
		return nil, fmt.Errorf("move folder: cycle check: %w", err)
	}
	if cycle {
		return nil, ErrFolderCycle
	}

	updated, err := q.UpdateFolderParent(ctx, folderID, &targetID)
	if err != nil {
		if isDuplicateKeyError(err) {
			return nil, ErrDuplicateFolderName
		}
		return nil, fmt.Errorf("move folder: %w", err)
	}
	return updated, tx.Commit()
}

// Delete removes an empty folder. Returns ErrFolderNotFound if the folder does
// not belong to userID, and ErrFolderNotEmpty if it still contains files or
// subfolders (the caller must delete children first).
func (s *FolderService) Delete(ctx context.Context, folderID, userID uuid.UUID) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("delete folder: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := s.getOwned(ctx, q, folderID, userID); err != nil {
		return err
	}
	hasChildren, err := q.HasFolderChildren(ctx, folderID)
	if err != nil {
		return fmt.Errorf("delete folder: check children: %w", err)
	}
	if hasChildren {
		return ErrFolderNotEmpty
	}
	if err := q.DeleteFolder(ctx, folderID); err != nil {
		return fmt.Errorf("delete folder: %w", err)
	}
	return tx.Commit()
}

// ── Internal helpers ──────────────────────────────────────────────────────────

func emptyFolders() *db.PageResult[models.Folder] {
	return &db.PageResult[models.Folder]{Items: []models.Folder{}}
}

func emptyFiles() *db.PageResult[models.File] {
	return &db.PageResult[models.File]{Items: []models.File{}}
}

// getOwned fetches a folder via a user-scoped query and verifies ownership.
// Returns ErrFolderNotFound for both missing and foreign-owned folders so the
// caller cannot distinguish the two cases (prevents existence leaking).
// q must be a Queries returned by ForUser so RLS is enforced at the DB level.
func (s *FolderService) getOwned(ctx context.Context, q *db.Queries, folderID, userID uuid.UUID) (*models.Folder, error) {
	folder, err := q.GetFolderByID(ctx, folderID)
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

// ErrFolderCycle is returned when a move would make a folder its own descendant.
var ErrFolderCycle = errors.New("cannot move a folder into itself or one of its subfolders")

// ErrNotMediaCollection is returned when an operation requires a media folder
// but the target folder is a regular folder.
var ErrNotMediaCollection = errors.New("folder is not a media collection")
