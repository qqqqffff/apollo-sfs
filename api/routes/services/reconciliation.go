package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// reconciliationGracePeriod excludes any object or row younger than this from
// being treated as drift. Upload writes the MinIO object before the DB commit;
// delete removes the MinIO object before the DB commit — either half of an
// in-flight request would otherwise look identical to real drift for the
// seconds it takes to complete. Two hours is comfortably longer than any
// upload/delete can legitimately take.
const reconciliationGracePeriod = 2 * time.Hour

// ErrReconciliationAlreadyRunning is returned by RunOnce when a scan (the
// daily heartbeat or a manual admin trigger) is already in progress.
var ErrReconciliationAlreadyRunning = errors.New("reconciliation: a scan is already running")

// ReconciliationService scans every active drive's MinIO bucket against the
// Postgres rows that should reference it (files, video_variants,
// recognition_detections) and repairs the drift it finds:
//   - orphan objects (present in MinIO, no referencing DB row) are deleted
//   - ghost rows (DB row referencing an object that no longer exists) are deleted
//   - abandoned incomplete multipart uploads are aborted
//
// Every finding (deleted, aborted, or an action that itself failed) is
// persisted to reconciliation_findings so an admin can see what happened.
// See docs/storage_reconciliation.md for the full design rationale.
type ReconciliationService struct {
	queries  *db.Queries
	registry *MinIORegistry
	files    *FileService
	running  atomic.Bool
}

// NewReconciliationService constructs a ReconciliationService. files is used to
// repair ghost `files` rows via its existing Delete path (idempotent MinIO
// removal + row delete + quota refund), so a ghost-file repair behaves
// identically to a normal user-initiated delete.
func NewReconciliationService(queries *db.Queries, registry *MinIORegistry, files *FileService) *ReconciliationService {
	return &ReconciliationService{queries: queries, registry: registry, files: files}
}

// RunOnce performs a single full scan across every active drive. Returns
// ErrReconciliationAlreadyRunning if another scan is already in progress
// (the daily heartbeat and a manual admin trigger share this guard).
func (s *ReconciliationService) RunOnce(ctx context.Context) (*models.ReconciliationRun, error) {
	if !s.running.CompareAndSwap(false, true) {
		return nil, ErrReconciliationAlreadyRunning
	}
	defer s.running.Store(false)

	run, err := s.queries.CreateReconciliationRun(ctx)
	if err != nil {
		return nil, fmt.Errorf("reconciliation: create run: %w", err)
	}

	drives, err := s.queries.ListActiveDrivesWithServer(ctx)
	if err != nil {
		errStr := err.Error()
		run.Error = &errStr
		_ = s.queries.FinishReconciliationRun(ctx, run)
		return run, fmt.Errorf("reconciliation: list drives: %w", err)
	}

	cutoff := time.Now().Add(-reconciliationGracePeriod)

	// Phase 1: list every active drive's objects once, before any diffing.
	// Video-variant and recognition-crop blobs are never moved by a drive-tier
	// migration (a documented V1 limitation of folder_drive_migration.go), so
	// such a blob can legitimately live in a different bucket than its parent
	// file's *current* drive_id — only a whole-fleet view of "is this key
	// present somewhere" can tell a real ghost from one that's simply
	// elsewhere. Primary file objects don't have this problem (Upload/Delete/
	// migration all guarantee a file's blob lives only in its current drive),
	// so those stay scoped per-drive below.
	type scannedDrive struct {
		alloc   *models.UserDriveAllocation
		storage *MinIOService
		objects []minio.ObjectInfo
		present map[string]struct{}
	}
	scanned := make([]scannedDrive, 0, len(drives))
	globalPresent := make(map[string]struct{})
	for i := range drives {
		alloc := &drives[i]
		client, ok := s.registry.ClientForDrive(alloc.Server.ID, alloc.Drive.NodeID, alloc.NodeHasMinIO)
		if !ok {
			log.Printf("reconciliation: run %s: drive %s: no MinIO client for server %s", run.ID, alloc.Drive.ID, alloc.Server.Name)
			continue
		}
		storage := NewMinIOService(client, alloc.Drive.MinioBucket)
		objects, err := storage.ListObjects(ctx)
		if err != nil {
			log.Printf("reconciliation: run %s: drive %s: list objects: %v", run.ID, alloc.Drive.ID, err)
			continue
		}
		run.ObjectsScanned += len(objects)
		run.DrivesScanned++
		present := make(map[string]struct{}, len(objects))
		for _, obj := range objects {
			present[obj.Key] = struct{}{}
			globalPresent[obj.Key] = struct{}{}
		}
		scanned = append(scanned, scannedDrive{alloc: alloc, storage: storage, objects: objects, present: present})
	}

	// Global variant/crop key sets, fetched once (not scoped to any one drive).
	allVariants, err := s.queries.ListAllVideoVariantKeys(ctx)
	if err != nil {
		log.Printf("reconciliation: run %s: list variant keys: %v", run.ID, err)
	}
	allCrops, err := s.queries.ListAllRecognitionCropKeys(ctx)
	if err != nil {
		log.Printf("reconciliation: run %s: list recognition crop keys: %v", run.ID, err)
	}
	run.RowsScanned += len(allVariants) + len(allCrops)
	globalVariantCropKeys := make(map[string]struct{}, len(allVariants)+len(allCrops))
	for _, k := range allVariants {
		globalVariantCropKeys[k.ObjectKey] = struct{}{}
	}
	for _, k := range allCrops {
		globalVariantCropKeys[k.ObjectKey] = struct{}{}
	}

	// Phase 2: per-drive file-row diff, and abandoned multipart uploads (both
	// are correctly single-bucket by design).
	for _, d := range scanned {
		driveID := d.alloc.Drive.ID
		fileKeys, err := s.queries.ListFileKeysByDrive(ctx, driveID)
		if err != nil {
			log.Printf("reconciliation: run %s: drive %s: list file keys: %v", run.ID, driveID, err)
			continue
		}
		run.RowsScanned += len(fileKeys)
		fileKeySet := make(map[string]struct{}, len(fileKeys))
		for _, k := range fileKeys {
			fileKeySet[k.ObjectKey] = struct{}{}
		}

		// Orphan objects: present in this bucket, referenced by nothing —
		// neither a file row on this drive nor a variant/crop row anywhere —
		// and old enough that this isn't just an upload whose DB commit hasn't
		// landed yet.
		for _, obj := range d.objects {
			if obj.LastModified.After(cutoff) {
				continue
			}
			if _, ok := fileKeySet[obj.Key]; ok {
				continue
			}
			if _, ok := globalVariantCropKeys[obj.Key]; ok {
				continue
			}
			run.OrphansFound++
			s.repairOrphanObject(ctx, run, d.storage, driveID, d.alloc.Drive.MinioBucket, obj)
		}

		// Ghost file rows: the row is still there but its object is gone, and
		// old enough that this isn't just a delete whose DB commit hasn't
		// landed yet.
		for _, k := range fileKeys {
			if _, ok := d.present[k.ObjectKey]; ok || k.CreatedAt.After(cutoff) {
				continue
			}
			run.GhostsFound++
			s.repairGhostFileRow(ctx, run, driveID, k)
		}

		// Abandoned multipart uploads: never completed or aborted, no DB row
		// was ever created for them (the upload path only inserts the row
		// after completing the multipart upload), and old enough to rule out
		// one still legitimately in progress.
		uploads, err := d.storage.ListIncompleteMultipartUploads(ctx)
		if err != nil {
			log.Printf("reconciliation: run %s: drive %s: list incomplete multipart uploads: %v", run.ID, driveID, err)
			continue
		}
		for _, u := range uploads {
			if u.Initiated.After(cutoff) {
				continue
			}
			s.repairAbandonedUpload(ctx, run, d.storage, driveID, d.alloc.Drive.MinioBucket, u)
		}
	}

	// Phase 3: global ghost diff for variants/crops — a key not present on any
	// scanned drive, old enough to rule out a delete still in flight.
	for _, k := range allVariants {
		if _, ok := globalPresent[k.ObjectKey]; ok || k.CreatedAt.After(cutoff) {
			continue
		}
		run.GhostsFound++
		s.repairGhostVariantRow(ctx, run, k)
	}
	for _, k := range allCrops {
		if _, ok := globalPresent[k.ObjectKey]; ok || k.CreatedAt.After(cutoff) {
			continue
		}
		run.GhostsFound++
		s.repairGhostCropRow(ctx, run, k)
	}

	if err := s.queries.FinishReconciliationRun(ctx, run); err != nil {
		log.Printf("reconciliation: run %s: record final counts: %v", run.ID, err)
	}
	return run, nil
}

func (s *ReconciliationService) repairOrphanObject(ctx context.Context, run *models.ReconciliationRun, storage *MinIOService, driveID uuid.UUID, bucket string, obj minio.ObjectInfo) {
	f := models.ReconciliationFinding{
		RunID: &run.ID, Kind: models.ReconciliationKindOrphanObject, DriveID: &driveID, Bucket: bucket,
		ObjectKey: obj.Key,
		Detail:    fmt.Sprintf("%d bytes, last modified %s", obj.Size, obj.LastModified.Format(time.RFC3339)),
	}
	if err := storage.RemoveObject(ctx, obj.Key); err != nil {
		f.Action = models.ReconciliationActionError
		errStr := err.Error()
		f.Error = &errStr
	} else {
		f.Action = models.ReconciliationActionDeleted
		run.OrphansDeleted++
	}
	s.recordFinding(ctx, run.ID, f)
}

func (s *ReconciliationService) repairGhostFileRow(ctx context.Context, run *models.ReconciliationRun, driveID uuid.UUID, k db.ReconcileFileKey) {
	fileID := k.ID
	f := models.ReconciliationFinding{
		RunID: &run.ID, Kind: models.ReconciliationKindGhostFileRow, DriveID: &driveID,
		ObjectKey: k.ObjectKey, UserID: &k.UserID, FileID: &fileID,
		Detail: fmt.Sprintf("%d bytes, row created %s, object missing from bucket", k.SizeBytes, k.CreatedAt.Format(time.RFC3339)),
	}
	// username == user_id.String() (see db/03_users.sql) — this reuses the same
	// Delete path a user-initiated delete takes: idempotent MinIO removal (a
	// no-op here, the object is already gone), row delete, and quota refund.
	if err := s.files.Delete(ctx, k.ID, k.UserID, k.UserID.String()); err != nil {
		f.Action = models.ReconciliationActionError
		errStr := err.Error()
		f.Error = &errStr
	} else {
		f.Action = models.ReconciliationActionDeleted
		run.GhostsDeleted++
	}
	s.recordFinding(ctx, run.ID, f)
}

func (s *ReconciliationService) repairGhostVariantRow(ctx context.Context, run *models.ReconciliationRun, k db.ReconcileVariantKey) {
	fileID := k.FileID
	f := models.ReconciliationFinding{
		RunID: &run.ID, Kind: models.ReconciliationKindGhostVariantRow, DriveID: k.DriveID,
		ObjectKey: k.ObjectKey, UserID: &k.UserID, FileID: &fileID,
		Detail: fmt.Sprintf("video variant row created %s, object missing from bucket", k.CreatedAt.Format(time.RFC3339)),
	}
	if err := s.queries.DeleteVideoVariantRow(ctx, k.ID); err != nil {
		f.Action = models.ReconciliationActionError
		errStr := err.Error()
		f.Error = &errStr
	} else {
		f.Action = models.ReconciliationActionDeleted
		run.GhostsDeleted++
	}
	s.recordFinding(ctx, run.ID, f)
}

func (s *ReconciliationService) repairGhostCropRow(ctx context.Context, run *models.ReconciliationRun, k db.ReconcileCropKey) {
	fileID := k.FileID
	f := models.ReconciliationFinding{
		RunID: &run.ID, Kind: models.ReconciliationKindGhostRecognition, DriveID: k.DriveID,
		ObjectKey: k.ObjectKey, UserID: &k.UserID, FileID: &fileID,
		Detail: fmt.Sprintf("%d bytes, detection created %s, crop missing from bucket — detection/embedding row kept", k.SizeBytes, k.CreatedAt.Format(time.RFC3339)),
	}
	if err := s.queries.ClearRecognitionCrop(ctx, k.ID); err != nil {
		f.Action = models.ReconciliationActionError
		errStr := err.Error()
		f.Error = &errStr
		s.recordFinding(ctx, run.ID, f)
		return
	}
	// The crop's bytes were counted against the user's quota; refund them now
	// that the (already-missing) blob's row reference is cleared. Best-effort:
	// a failure here doesn't undo the row clear, since retrying that is what
	// would leave the ghost crop reference dangling again.
	if err := s.queries.AddStorageUsed(ctx, k.UserID.String(), -k.SizeBytes); err != nil {
		log.Printf("reconciliation: run %s: refund quota for cleared crop %s: %v", run.ID, k.ID, err)
	}
	f.Action = models.ReconciliationActionDeleted
	run.GhostsDeleted++
	s.recordFinding(ctx, run.ID, f)
}

func (s *ReconciliationService) repairAbandonedUpload(ctx context.Context, run *models.ReconciliationRun, storage *MinIOService, driveID uuid.UUID, bucket string, u minio.ObjectMultipartInfo) {
	f := models.ReconciliationFinding{
		RunID: &run.ID, Kind: models.ReconciliationKindAbandonedMultipart, DriveID: &driveID, Bucket: bucket,
		ObjectKey: u.Key,
		Detail:    fmt.Sprintf("initiated %s, never completed — no DB row was ever created for it", u.Initiated.Format(time.RFC3339)),
	}
	if err := storage.AbortMultipartUpload(ctx, u.Key, u.UploadID); err != nil {
		f.Action = models.ReconciliationActionError
		errStr := err.Error()
		f.Error = &errStr
	} else {
		f.Action = models.ReconciliationActionAborted
		run.AbandonedUploadsAborted++
	}
	s.recordFinding(ctx, run.ID, f)
}

func (s *ReconciliationService) recordFinding(ctx context.Context, runID uuid.UUID, f models.ReconciliationFinding) {
	if err := s.queries.InsertReconciliationFinding(ctx, &f); err != nil {
		log.Printf("reconciliation: run %s: record finding for %s: %v", runID, f.ObjectKey, err)
	}
}

// DailyLoop runs RunOnce once a day at hour:minute in the server's local time
// zone (time.Local — set the TZ env var on the container so this reflects the
// deployment's actual local time; it defaults to UTC otherwise). Intended to
// be started in a goroutine from main once the service is constructed.
func (s *ReconciliationService) DailyLoop(ctx context.Context, hour, minute int) {
	for {
		wait := durationUntilNextLocal(hour, minute)
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			log.Printf("reconciliation: daily heartbeat starting")
			run, err := s.RunOnce(ctx)
			if err != nil {
				log.Printf("reconciliation: daily heartbeat failed: %v", err)
				continue
			}
			log.Printf("reconciliation: daily heartbeat done — %d drives, %d objects, %d rows scanned; %d/%d orphans deleted; %d/%d ghosts deleted; %d abandoned uploads aborted",
				run.DrivesScanned, run.ObjectsScanned, run.RowsScanned,
				run.OrphansDeleted, run.OrphansFound, run.GhostsDeleted, run.GhostsFound, run.AbandonedUploadsAborted)
		}
	}
}

// durationUntilNextLocal returns how long to wait until the next occurrence of
// hour:minute in time.Local, at least one second away (so a slow start right
// at the target minute doesn't immediately refire).
func durationUntilNextLocal(hour, minute int) time.Duration {
	now := time.Now()
	next := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, time.Local)
	if !next.After(now) {
		next = next.AddDate(0, 0, 1)
	}
	return next.Sub(now)
}
