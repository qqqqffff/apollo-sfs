package services

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// Rate limit for folder drive-migration requests: at most
// folderDriveMigrationLimit migrations per folder within a rolling
// folderDriveMigrationWindow. Retune here rather than inline.
const (
	folderDriveMigrationLimit  = 3
	folderDriveMigrationWindow = 30 * 24 * time.Hour
)

// DriveMigrationStatus bundles the most recent migration row for a folder (if
// any) with eligibility info so the frontend can show/disable the "change"
// action without a second round trip.
type DriveMigrationStatus struct {
	Migration      *models.FolderDriveMigration `json:"migration"`
	RecentCount    int                          `json:"recent_count"`
	Limit          int                          `json:"limit"`
	WindowDays     int                          `json:"window_days"`
	NextEligibleAt *time.Time                   `json:"next_eligible_at"`
}

// RequestDriveMigration validates and enqueues a folder tier/server change —
// the "move to another server & tier" flow. The folder must be owned by userID,
// toDriveID must be one of the user's current drive allocations, no migration
// for the folder may already be pending/in_progress, and the folder must not
// have hit the rolling rate limit. destParentID, when non-nil, is the
// destination folder the folder is reparented under on the destination drive
// (nil = the destination drive's root); it must be owned by the user, live on
// toDriveID, not be the folder itself or one of its descendants, and not
// already contain a sibling with the folder's name. On success a pending row is
// inserted and the background mover is launched; the row is returned
// immediately (the caller responds 202). The whole subtree's bytes and drive_id
// move together, so a folder subtree never straddles drives.
func (s *FileService) RequestDriveMigration(ctx context.Context, userID uuid.UUID, username string, folderID, toDriveID uuid.UUID, destParentID *uuid.UUID) (*models.FolderDriveMigration, error) {
	// folders and folder_drive_migrations both FORCE row-level security, so any
	// read/write against them must go through a ForUser-scoped q/tx (matching
	// every other write path in this package, e.g. FolderService.Create) or
	// RLS silently hides rows / rejects the insert. GetUserDrives is exempt —
	// user_drive_allocations/drives/servers carry no RLS policy.
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("request drive migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	folder, err := q.GetFolderByID(ctx, folderID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrFolderNotFound
		}
		return nil, fmt.Errorf("request drive migration: get folder: %w", err)
	}
	if folder.UserID != userID {
		return nil, ErrFolderNotFound
	}

	drives, err := s.queries.GetUserDrives(ctx, username, userID.String())
	if err != nil {
		return nil, fmt.Errorf("request drive migration: get user drives: %w", err)
	}
	if !driveIsAllocated(drives, toDriveID) {
		return nil, ErrDriveNotAllocated
	}

	// Validate the destination folder (when one was chosen): owned, on the
	// destination drive, not inside the moving subtree, and no name clash.
	if destParentID != nil {
		if err := s.validateMigrationDestination(ctx, q, userID, *destParentID, folderID, folder.Name, toDriveID, primaryDriveID(drives)); err != nil {
			return nil, err
		}
	} else if err := s.checkDestNameClash(ctx, q, userID, nil, folderID, folder.Name); err != nil {
		// Reparenting to the destination drive's root: still guard the (user,
		// root, name) uniqueness so the reparent at completion can't fail.
		return nil, err
	}

	if _, err := q.GetPendingOrInProgressFolderDriveMigration(ctx, folderID); err == nil {
		return nil, ErrMigrationAlreadyRunning
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("request drive migration: check active migration: %w", err)
	}

	recentCount, err := q.CountRecentFolderDriveMigrations(ctx, folderID)
	if err != nil {
		return nil, fmt.Errorf("request drive migration: count recent: %w", err)
	}
	if recentCount >= folderDriveMigrationLimit {
		oldest, oErr := q.OldestRecentFolderDriveMigrationCreatedAt(ctx, folderID)
		if oErr != nil {
			return nil, fmt.Errorf("request drive migration: %w", ErrMigrationRateLimited)
		}
		nextEligible := oldest.Add(folderDriveMigrationWindow)
		return nil, fmt.Errorf("%w: next available %s", ErrMigrationRateLimited, nextEligible.Format(time.RFC3339))
	}

	migration, err := q.CreateFolderDriveMigration(ctx, folderID, userID, folder.DriveID, toDriveID, destParentID)
	if err != nil {
		return nil, fmt.Errorf("request drive migration: create: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("request drive migration: commit: %w", err)
	}

	go s.runDriveMigration(migration.ID, folderID, userID, username, folder.DriveID, toDriveID, destParentID)

	return migration, nil
}

// validateMigrationDestination checks that destParentID is a valid target for
// moving folderID (named folderName) onto toDriveID: owned by the user, on the
// destination drive (a NULL drive_id resolves to primaryDrive), not the folder
// itself or one of its descendants, and free of a same-named sibling.
func (s *FileService) validateMigrationDestination(ctx context.Context, q *db.Queries, userID, destParentID, folderID uuid.UUID, folderName string, toDriveID uuid.UUID, primaryDrive *uuid.UUID) error {
	if destParentID == folderID {
		return ErrInvalidMigrationDestination
	}
	dest, err := q.GetFolderByID(ctx, destParentID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrFolderNotFound
		}
		return fmt.Errorf("request drive migration: get destination: %w", err)
	}
	if dest.UserID != userID {
		return ErrFolderNotFound
	}
	// Destination must live on the target drive. Resolve a NULL pin to primary.
	destDrive := dest.DriveID
	if destDrive == nil {
		destDrive = primaryDrive
	}
	if destDrive == nil || *destDrive != toDriveID {
		return ErrInvalidMigrationDestination
	}
	// Can't move a folder into its own subtree.
	inside, err := q.IsFolderDescendant(ctx, folderID, destParentID)
	if err != nil {
		return fmt.Errorf("request drive migration: descendant check: %w", err)
	}
	if inside {
		return ErrInvalidMigrationDestination
	}
	return s.checkDestNameClash(ctx, q, userID, &destParentID, folderID, folderName)
}

// checkDestNameClash rejects the migration when the destination parent (nil =
// root) already contains a different folder with the same name, so the reparent
// at completion can't hit the (user_id, parent_id, name) unique constraint.
func (s *FileService) checkDestNameClash(ctx context.Context, q *db.Queries, userID uuid.UUID, destParentID *uuid.UUID, folderID uuid.UUID, folderName string) error {
	existing, err := q.FindFolderByParentAndName(ctx, userID, destParentID, folderName)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("request drive migration: name-clash check: %w", err)
	}
	if existing.ID != folderID {
		return ErrDuplicateFolderName
	}
	return nil
}

// GetLatestDriveMigration returns the most recent migration row for folderID
// (owned by userID) plus eligibility info. folder must exist and belong to
// userID or ErrFolderNotFound is returned.
func (s *FileService) GetLatestDriveMigration(ctx context.Context, userID, folderID uuid.UUID) (*DriveMigrationStatus, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get latest drive migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	folder, err := q.GetFolderByID(ctx, folderID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrFolderNotFound
		}
		return nil, fmt.Errorf("get latest drive migration: get folder: %w", err)
	}
	if folder.UserID != userID {
		return nil, ErrFolderNotFound
	}

	var latest *models.FolderDriveMigration
	if m, err := q.GetLatestFolderDriveMigration(ctx, folderID); err == nil {
		latest = m
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("get latest drive migration: %w", err)
	}

	recentCount, err := q.CountRecentFolderDriveMigrations(ctx, folderID)
	if err != nil {
		return nil, fmt.Errorf("get latest drive migration: count recent: %w", err)
	}

	var nextEligible *time.Time
	if recentCount >= folderDriveMigrationLimit {
		if oldest, err := q.OldestRecentFolderDriveMigrationCreatedAt(ctx, folderID); err == nil {
			t := oldest.Add(folderDriveMigrationWindow)
			nextEligible = &t
		}
	}

	return &DriveMigrationStatus{
		Migration:      latest,
		RecentCount:    recentCount,
		Limit:          folderDriveMigrationLimit,
		WindowDays:     int(folderDriveMigrationWindow / (24 * time.Hour)),
		NextEligibleAt: nextEligible,
	}, nil
}

// runDriveMigration physically relocates a folder's ENTIRE subtree (the folder
// plus every descendant folder's files, recursively) onto toDriveID, updating
// progress as it goes, then sets drive_id on the folder and all descendant
// folders to toDriveID and reparents the folder under destParentID (nil = the
// destination drive's root). Under the tier-first model a folder subtree always
// shares one drive, so the move must be recursive. Runs as a background
// goroutine kicked off by RequestDriveMigration, so — mirroring createVariant
// — it takes no ctx parameter and constructs its own context.Background()
// internally: the HTTP request's ctx is cancelled as soon as the 202 response
// is sent, but this job must keep running after that.
// Each file's source storage is resolved from its own drive_id, so a subtree
// whose files were historically spread across drives still consolidates
// correctly; files already on toDriveID are counted without a needless copy.
// Video transcoded low-quality variants are NOT moved by this operation — only
// the primary file object (known V1 limitation).
// On any per-file error the migration is marked failed with the error message,
// leaving already-moved files moved; there is no automatic rollback, matching
// this codebase's existing "surface the error, don't silently retry" style.
func (s *FileService) runDriveMigration(migrationID, folderID, userID uuid.UUID, username string, fromDriveID *uuid.UUID, toDriveID uuid.UUID, destParentID *uuid.UUID) {
	ctx := context.Background()
	_ = fromDriveID // retained for the audit trail; source is resolved per file

	markFailed := func(err error) {
		log.Printf("drive migration: %s: %v", migrationID, err)
		if mErr := s.markMigrationFailed(ctx, userID, migrationID, err.Error()); mErr != nil {
			log.Printf("drive migration: mark failed for %s: %v", migrationID, mErr)
		}
	}

	defer func() {
		if r := recover(); r != nil {
			log.Printf("drive migration: recovered panic for %s: %v", migrationID, r)
			_ = s.markMigrationFailed(ctx, userID, migrationID, fmt.Sprintf("internal error: %v", r))
		}
	}()

	// List every file in the folder subtree (folder + all descendant folders).
	// This job runs across possibly-slow MinIO I/O between database writes, so
	// each write below opens its own short-lived ForUser transaction rather than
	// holding one open (and a connection pinned) for the whole job.
	files, err := s.listMigrationFiles(ctx, userID, folderID)
	if err != nil {
		markFailed(fmt.Errorf("list files: %w", err))
		return
	}

	var totalBytes int64
	for _, f := range files {
		totalBytes += f.SizeBytes
	}
	if err := s.markMigrationInProgress(ctx, userID, migrationID, len(files), totalBytes); err != nil {
		markFailed(fmt.Errorf("mark in progress: %w", err))
		return
	}

	destStorage, err := s.storageForDrive(ctx, toDriveID)
	if err != nil {
		markFailed(fmt.Errorf("resolve destination storage: %w", err))
		return
	}

	var filesMoved int
	var bytesMoved int64
	for i := range files {
		f := &files[i]

		// Skip the byte copy for files already on the destination drive (a
		// partially-consolidated subtree), but still count them toward progress.
		if f.DriveID != nil && *f.DriveID == toDriveID {
			filesMoved++
			bytesMoved += f.SizeBytes
			if err := s.recordFileMovedAndProgress(ctx, userID, f.ID, toDriveID, migrationID, filesMoved, bytesMoved); err != nil {
				markFailed(fmt.Errorf("update drive_id for file %s: %w", f.ID, err))
				return
			}
			continue
		}

		// Resolve the source from the file's own drive so a subtree whose files
		// were historically spread across drives still consolidates correctly.
		sourceStorage, err := s.storageForFile(ctx, username, f)
		if err != nil {
			markFailed(fmt.Errorf("resolve source storage for file %s: %w", f.ID, err))
			return
		}

		obj, err := sourceStorage.GetObject(ctx, f.MinIOObjectKey)
		if err != nil {
			markFailed(fmt.Errorf("get object for file %s: %w", f.ID, err))
			return
		}
		data, err := io.ReadAll(obj)
		_ = obj.Close()
		if err != nil {
			markFailed(fmt.Errorf("read object for file %s: %w", f.ID, err))
			return
		}

		if err := destStorage.PutObject(ctx, f.MinIOObjectKey, bytes.NewReader(data), int64(len(data)), "application/octet-stream"); err != nil {
			markFailed(fmt.Errorf("put object for file %s: %w", f.ID, err))
			return
		}
		if err := sourceStorage.RemoveObject(ctx, f.MinIOObjectKey); err != nil {
			// The copy already landed on the destination; a stale source object is
			// a cleanup nit, not a correctness problem, so this does not fail the
			// migration — but it is logged and recorded in the reconciliation
			// ledger (nil run_id — this happened outside a scheduled scan) so it
			// stays visible until the next reconciliation run finds and deletes
			// the now-orphaned object under the old drive.
			log.Printf("drive migration: %s: remove source object for file %s: %v", migrationID, f.ID, err)
			errStr := err.Error()
			userID := f.UserID
			fileID := f.ID
			if fErr := s.queries.InsertReconciliationFinding(ctx, &models.ReconciliationFinding{
				Kind:      models.ReconciliationKindOrphanObject,
				DriveID:   fromDriveID,
				ObjectKey: f.MinIOObjectKey,
				UserID:    &userID,
				FileID:    &fileID,
				Detail:    fmt.Sprintf("drive migration %s: source object survives after copy to new drive", migrationID),
				Action:    models.ReconciliationActionError,
				Error:     &errStr,
			}); fErr != nil {
				log.Printf("drive migration: %s: record reconciliation finding: %v", migrationID, fErr)
			}
		}

		filesMoved++
		bytesMoved += f.SizeBytes
		if err := s.recordFileMovedAndProgress(ctx, userID, f.ID, toDriveID, migrationID, filesMoved, bytesMoved); err != nil {
			markFailed(fmt.Errorf("update drive_id for file %s: %w", f.ID, err))
			return
		}
	}

	if err := s.completeMigration(ctx, userID, folderID, migrationID, toDriveID, destParentID); err != nil {
		markFailed(fmt.Errorf("finalize: %w", err))
		return
	}
	log.Printf("drive migration: %s: done, moved %d files (%.1f MB)", migrationID, filesMoved, float64(bytesMoved)/(1024*1024))
}

// ── RLS-scoped helpers ───────────────────────────────────────────────────────
//
// folders, files, and folder_drive_migrations all FORCE row-level security.
// runDriveMigration executes on context.Background() (it outlives the request
// that spawned it), so each discrete write below opens its own short-lived
// ForUser-scoped transaction — matching the convention used everywhere else
// in this package — rather than assuming any ambient session state.

func (s *FileService) listMigrationFiles(ctx context.Context, userID, folderID uuid.UUID) ([]models.File, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	// Recursive: every file in the folder subtree, since the whole subtree moves
	// to the destination drive together.
	return q.ListFilesInFolderSubtree(ctx, folderID)
}

func (s *FileService) markMigrationInProgress(ctx context.Context, userID, migrationID uuid.UUID, totalFiles int, totalBytes int64) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := q.MarkFolderDriveMigrationInProgress(ctx, migrationID, totalFiles, totalBytes); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *FileService) recordFileMovedAndProgress(ctx context.Context, userID, fileID, toDriveID, migrationID uuid.UUID, filesMoved int, bytesMoved int64) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := q.SetFileDriveID(ctx, fileID, toDriveID); err != nil {
		return err
	}
	if err := q.UpdateFolderDriveMigrationProgress(ctx, migrationID, filesMoved, bytesMoved); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *FileService) completeMigration(ctx context.Context, userID, folderID, migrationID, toDriveID uuid.UUID, destParentID *uuid.UUID) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Pin the folder and its whole subtree to the destination drive, then
	// reparent the folder under the chosen destination (nil = destination drive
	// root). The name-clash and cycle checks were validated up front in
	// RequestDriveMigration, so the reparent can't hit the unique constraint.
	if err := q.SetFolderSubtreeDriveID(ctx, folderID, toDriveID); err != nil {
		return err
	}
	if _, err := q.UpdateFolderParent(ctx, folderID, destParentID); err != nil {
		return err
	}
	if err := q.MarkFolderDriveMigrationCompleted(ctx, migrationID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *FileService) markMigrationFailed(ctx context.Context, userID, migrationID uuid.UUID, message string) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := q.MarkFolderDriveMigrationFailed(ctx, migrationID, message); err != nil {
		return err
	}
	return tx.Commit()
}

// ── Sentinel errors ───────────────────────────────────────────────────────────

// ErrMigrationAlreadyRunning is returned when a folder already has a
// pending/in_progress drive migration and a new one is requested.
var ErrMigrationAlreadyRunning = errors.New("a storage change is already in progress for this folder")

// ErrMigrationRateLimited is returned when a folder has reached the rolling
// rate limit for drive-migration requests.
var ErrMigrationRateLimited = errors.New("reached the storage-change limit for this folder")

// ErrInvalidMigrationDestination is returned when the chosen destination folder
// for a drive migration is unusable: it is not on the target drive, is the
// folder being moved or one of its descendants, or is otherwise ineligible.
var ErrInvalidMigrationDestination = errors.New("invalid destination folder for this storage change")
