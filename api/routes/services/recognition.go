package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// Recognition errors surfaced to route handlers. ErrNotMediaCollection is
// shared with the folder service (folder.go).
var (
	ErrRecognitionUnavailable = errors.New("recognition service not configured")
	ErrGroupKindMismatch      = errors.New("groups must share the same kind and species to merge")
)

const (
	recognitionPollInterval = 5 * time.Second
	recognitionMaxAttempts  = 3
	recognitionStaleAfter   = 10 * time.Minute
)

// RecognitionEnqueuer is implemented by RecognitionService and consumed by
// FileService (upload/copy hooks) so the dependency stays one-directional.
type RecognitionEnqueuer interface {
	EnqueueFileIfEnabled(ctx context.Context, file *models.File, username, trigger string)
}

// RecognitionConfig carries the env-derived tuning knobs.
type RecognitionConfig struct {
	URL           string
	Token         string
	Concurrency   int
	MaxKeyframes  int
	FaceThreshold float32
	PetThreshold  float32
}

// RecognitionStatus is the payload of GET /collections/:id/recognition.
type RecognitionStatus struct {
	Enabled          bool                     `json:"enabled"`
	ServiceAvailable bool                     `json:"service_available"`
	Counts           db.RecognitionJobCounts  `json:"counts"`
	Groups           db.RecognitionGroupCounts `json:"groups"`
	StorageBytes     int64                    `json:"storage_bytes"`
}

// RecognitionService orchestrates premium AI indexing: it owns the durable
// job queue worker, decrypts media through FileService, calls the stateless
// inference sidecar, stores detections + encrypted crops, and runs the
// incremental centroid clustering. All user-data DB access goes through
// ForUser so RLS applies (job rows carry the user UUID for exactly this).
type RecognitionService struct {
	queries   *db.Queries
	files     *FileService
	client    *RecognitionClient
	transcode *TranscodeService
	cfg       RecognitionConfig

	// Per-collection locks serialize cluster assignment so concurrent jobs
	// from one collection cannot race group creation.
	mu        sync.Mutex
	collLocks map[uuid.UUID]*sync.Mutex
	runStarts map[uuid.UUID]time.Time
}

// NewRecognitionService wires the recognition orchestrator. client may be nil
// (RECOGNITION_URL unset): every operation then reports unavailability and
// Start is a no-op.
func NewRecognitionService(q *db.Queries, files *FileService, client *RecognitionClient, transcode *TranscodeService, cfg RecognitionConfig) *RecognitionService {
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = 2
	}
	if cfg.MaxKeyframes <= 0 {
		cfg.MaxKeyframes = 20
	}
	if cfg.FaceThreshold <= 0 {
		cfg.FaceThreshold = 0.50
	}
	if cfg.PetThreshold <= 0 {
		cfg.PetThreshold = 0.88
	}
	return &RecognitionService{
		queries:   q,
		files:     files,
		client:    client,
		transcode: transcode,
		cfg:       cfg,
		collLocks: make(map[uuid.UUID]*sync.Mutex),
		runStarts: make(map[uuid.UUID]time.Time),
	}
}

// Available reports whether the sidecar is configured.
func (s *RecognitionService) Available() bool { return s.client != nil }

func (s *RecognitionService) collLock(id uuid.UUID) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.collLocks[id]
	if !ok {
		l = &sync.Mutex{}
		s.collLocks[id] = l
	}
	return l
}

// mediaCollection loads the folder under ForUser and verifies it is a media
// collection owned by userID.
func (s *RecognitionService) mediaCollection(ctx context.Context, q *db.Queries, collectionID uuid.UUID) (*models.Folder, error) {
	folder, err := q.GetFolderByID(ctx, collectionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrFolderNotFound
		}
		return nil, fmt.Errorf("recognition: get folder: %w", err)
	}
	if folder.Kind != models.FolderKindMedia {
		return nil, ErrNotMediaCollection
	}
	return folder, nil
}

// SetEnabled flips a collection's AI toggle. Enabling scans the collection
// and enqueues jobs for every not-yet-indexed media file; disabling drops
// pending jobs (indexed data is kept unless purge is set, which also deletes
// groups/detections/crops and refunds the crop bytes to the user's quota).
// Returns (files enqueued, bytes freed).
func (s *RecognitionService) SetEnabled(ctx context.Context, userID uuid.UUID, username string, collectionID uuid.UUID, enabled, purge bool) (int, int64, error) {
	if !s.Available() {
		return 0, 0, ErrRecognitionUnavailable
	}
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return 0, 0, fmt.Errorf("recognition set enabled: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	folder, err := s.mediaCollection(ctx, q, collectionID)
	if err != nil {
		return 0, 0, err
	}
	if err := q.SetFolderAIRecognition(ctx, collectionID, enabled); err != nil {
		return 0, 0, fmt.Errorf("recognition set enabled: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, fmt.Errorf("recognition set enabled: commit: %w", err)
	}

	if enabled {
		enqueued, err := s.enqueueCollection(ctx, userID, username, collectionID)
		if err != nil {
			return 0, 0, err
		}
		s.audit(ctx, username, "recognition_enabled", collectionID, folder.Name,
			map[string]any{"files_enqueued": enqueued})
		return enqueued, 0, nil
	}

	if err := s.queries.DeletePendingRecognitionJobs(ctx, collectionID); err != nil {
		return 0, 0, fmt.Errorf("recognition disable: %w", err)
	}
	var freed int64
	if purge {
		freed, err = s.purgeCollection(ctx, userID, username, collectionID)
		if err != nil {
			return 0, 0, err
		}
	}
	s.audit(ctx, username, "recognition_disabled", collectionID, folder.Name,
		map[string]any{"purged": purge, "freed_bytes": freed})
	return 0, freed, nil
}

// enqueueCollection pages through the collection's files (residents plus
// collection_items pointers) and batch-upserts pending jobs for media mimes.
func (s *RecognitionService) enqueueCollection(ctx context.Context, userID uuid.UUID, username string, collectionID uuid.UUID) (int, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("recognition enqueue: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var fileIDs []uuid.UUID
	cursor := ""
	for {
		page, err := q.ListMediaFiles(ctx, collectionID, db.MediaSortCreated, db.HiddenInclude,
			db.MediaFilter{}, db.PageInput{Cursor: cursor, Limit: db.MaxPageLimit})
		if err != nil {
			return 0, fmt.Errorf("recognition enqueue: list files: %w", err)
		}
		for _, f := range page.Items {
			if isMediaMime(f.MimeType) {
				fileIDs = append(fileIDs, f.ID)
			}
		}
		if page.NextToken == "" {
			break
		}
		cursor = page.NextToken
	}
	_ = tx.Rollback()

	total := 0
	for start := 0; start < len(fileIDs); start += db.MaxPageLimit {
		end := min(start+db.MaxPageLimit, len(fileIDs))
		n, err := s.queries.UpsertRecognitionJobs(ctx, userID, username, collectionID, fileIDs[start:end])
		if err != nil {
			return total, fmt.Errorf("recognition enqueue: %w", err)
		}
		total += n
	}
	return total, nil
}

// purgeCollection deletes the collection's recognition data, removes crop
// blobs from MinIO (best-effort, grouped per drive), and refunds quota.
func (s *RecognitionService) purgeCollection(ctx context.Context, userID uuid.UUID, username string, collectionID uuid.UUID) (int64, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("recognition purge: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	crops, err := q.PurgeRecognitionData(ctx, collectionID)
	if err != nil {
		return 0, fmt.Errorf("recognition purge: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("recognition purge: commit: %w", err)
	}

	var freed int64
	for _, crop := range crops {
		freed += crop.SizeBytes
		storage, err := s.storageForCrop(ctx, username, crop.DriveID)
		if err != nil {
			log.Printf("recognition purge: storage for crop %s: %v", crop.ObjectKey, err)
			continue
		}
		if err := storage.RemoveObject(ctx, crop.ObjectKey); err != nil {
			log.Printf("recognition purge: remove crop %s: %v", crop.ObjectKey, err)
		}
	}
	if freed > 0 {
		if err := s.queries.AddStorageUsed(ctx, username, -freed); err != nil {
			return freed, fmt.Errorf("recognition purge: refund quota: %w", err)
		}
	}
	return freed, nil
}

func (s *RecognitionService) storageForCrop(ctx context.Context, username string, driveID *uuid.UUID) (*MinIOService, error) {
	if driveID != nil {
		return s.files.storageForDrive(ctx, *driveID)
	}
	storage, _, err := s.files.storageFor(ctx, username)
	return storage, err
}

// Status returns the toggle state, queue counts, group tallies, and the crop
// storage attributable to the collection.
func (s *RecognitionService) Status(ctx context.Context, userID uuid.UUID, collectionID uuid.UUID) (*RecognitionStatus, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("recognition status: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	folder, err := s.mediaCollection(ctx, q, collectionID)
	if err != nil {
		return nil, err
	}
	groups, err := q.CountRecognitionGroupsByCollection(ctx, collectionID)
	if err != nil {
		return nil, err
	}
	storageBytes, err := q.SumRecognitionStorageForCollection(ctx, collectionID)
	if err != nil {
		return nil, err
	}
	_ = tx.Rollback()

	// Job counts live in the no-RLS queue table; ownership was verified above.
	counts, err := s.queries.CountRecognitionJobsByCollection(ctx, collectionID)
	if err != nil {
		return nil, err
	}
	return &RecognitionStatus{
		Enabled:          folder.AIRecognitionEnabled,
		ServiceAvailable: s.Available(),
		Counts:           *counts,
		Groups:           *groups,
		StorageBytes:     storageBytes,
	}, nil
}

// ListGroups returns a collection's groups (kind/labeled filters optional).
func (s *RecognitionService) ListGroups(ctx context.Context, userID uuid.UUID, collectionID uuid.UUID, kind string, labeledOnly bool) ([]models.RecognitionGroup, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("recognition list groups: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := s.mediaCollection(ctx, q, collectionID); err != nil {
		return nil, err
	}
	return q.ListRecognitionGroupsByCollection(ctx, collectionID, kind, labeledOnly)
}

// GroupFiles pages the files whose detections belong to the group.
func (s *RecognitionService) GroupFiles(ctx context.Context, userID uuid.UUID, groupID uuid.UUID, in db.PageInput) (*db.PageResult[models.File], error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("recognition group files: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := q.GetRecognitionGroup(ctx, groupID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return q.ListRecognitionGroupFiles(ctx, groupID, in)
}

// LabelGroup sets (or clears, with empty string) a group's user label.
func (s *RecognitionService) LabelGroup(ctx context.Context, userID uuid.UUID, username string, groupID uuid.UUID, label string) (*models.RecognitionGroup, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("recognition label: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	group, err := q.GetRecognitionGroup(ctx, groupID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var ptr *string
	trimmed := strings.TrimSpace(label)
	if trimmed != "" {
		ptr = &trimmed
	}
	if err := q.UpdateRecognitionGroupLabel(ctx, groupID, ptr); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("recognition label: commit: %w", err)
	}
	group.UserLabel = ptr
	s.audit(ctx, username, "recognition_group_labeled", groupID, group.AutoLabel,
		map[string]any{"label": trimmed})
	return group, nil
}

// MergeGroups folds the source groups into target. All groups must share the
// same kind (and species, for pets). The target keeps its user label, or
// adopts the first labeled source's when it has none.
func (s *RecognitionService) MergeGroups(ctx context.Context, userID uuid.UUID, username string, targetID uuid.UUID, sourceIDs []uuid.UUID) (*models.RecognitionGroup, error) {
	lockAcquired := false
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("recognition merge: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
		_ = lockAcquired // lock released below before returning
	}()

	target, err := q.GetRecognitionGroup(ctx, targetID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	lock := s.collLock(target.CollectionID)
	lock.Lock()
	defer lock.Unlock()
	lockAcquired = true

	centroid := target.Centroid
	weight := target.MemberCount
	adoptedLabel := target.UserLabel
	for _, srcID := range sourceIDs {
		src, err := q.GetRecognitionGroup(ctx, srcID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, ErrNotFound
			}
			return nil, err
		}
		if src.CollectionID != target.CollectionID || src.Kind != target.Kind ||
			(src.Kind == models.RecognitionKindPet && !equalStrPtr(src.ClassLabel, target.ClassLabel)) {
			return nil, ErrGroupKindMismatch
		}
		if len(src.Centroid) > 0 {
			tc, err1 := bytesToEmbedding(centroid)
			sc, err2 := bytesToEmbedding(src.Centroid)
			if err1 == nil && err2 == nil {
				centroid = embeddingToBytes(mergeCentroids(tc, weight, sc, src.MemberCount))
			}
		}
		weight += src.MemberCount
		if adoptedLabel == nil && src.UserLabel != nil {
			adoptedLabel = src.UserLabel
		}
	}

	if err := q.MergeRecognitionGroups(ctx, targetID, sourceIDs); err != nil {
		return nil, err
	}
	if len(centroid) > 0 {
		if err := q.UpdateRecognitionGroupCentroid(ctx, targetID, centroid, weight); err != nil {
			return nil, err
		}
	}
	if target.UserLabel == nil && adoptedLabel != nil {
		if err := q.UpdateRecognitionGroupLabel(ctx, targetID, adoptedLabel); err != nil {
			return nil, err
		}
		target.UserLabel = adoptedLabel
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("recognition merge: commit: %w", err)
	}

	target.Centroid = centroid
	target.MemberCount = weight
	srcStrs := make([]string, len(sourceIDs))
	for i, id := range sourceIDs {
		srcStrs[i] = id.String()
	}
	s.audit(ctx, username, "recognition_groups_merged", targetID, target.AutoLabel,
		map[string]any{"source_group_ids": srcStrs})
	return target, nil
}

// DeleteGroup removes a group and its memberships; detections are kept and
// become unassigned (they can re-cluster on future indexing runs).
func (s *RecognitionService) DeleteGroup(ctx context.Context, userID uuid.UUID, username string, groupID uuid.UUID) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("recognition delete group: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	group, err := q.GetRecognitionGroup(ctx, groupID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if err := q.DeleteRecognitionGroup(ctx, groupID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("recognition delete group: commit: %w", err)
	}
	s.audit(ctx, username, "recognition_group_deleted", groupID, group.AutoLabel, nil)
	return nil
}

// DetectionThumb returns the decrypted face/pet crop JPEG for a detection.
func (s *RecognitionService) DetectionThumb(ctx context.Context, userID uuid.UUID, username string, detectionID uuid.UUID) ([]byte, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("recognition thumb: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	det, err := q.GetRecognitionDetection(ctx, detectionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if det.ThumbObjectKey == nil {
		return nil, ErrNotFound
	}
	file, err := q.GetFileByID(ctx, det.FileID)
	if err != nil {
		return nil, ErrNotFound
	}
	_ = tx.Rollback()

	storage, err := s.files.storageForFile(ctx, username, file)
	if err != nil {
		return nil, fmt.Errorf("recognition thumb: storage: %w", err)
	}
	obj, err := storage.GetObject(ctx, *det.ThumbObjectKey)
	if err != nil {
		return nil, fmt.Errorf("recognition thumb: fetch: %w", err)
	}
	defer obj.Close()
	ciphertext, err := io.ReadAll(obj)
	if err != nil {
		return nil, fmt.Errorf("recognition thumb: read: %w", err)
	}

	userKey, err := s.files.userKey(ctx, username)
	if err != nil {
		return nil, fmt.Errorf("recognition thumb: key: %w", err)
	}
	defer zeroBytes(userKey)
	plaintext, err := s.files.enc.DecryptFile(userKey, det.ThumbNonce, ciphertext)
	if err != nil {
		return nil, fmt.Errorf("recognition thumb: decrypt: %w", err)
	}
	return plaintext, nil
}

// EnqueueFileIfEnabled adds a freshly uploaded/copied media file to the queue
// of every recognition-enabled collection that contains it (its own folder
// chain plus collection_items pointers). Fire-and-forget: errors are logged,
// durability comes from the job row once inserted.
func (s *RecognitionService) EnqueueFileIfEnabled(ctx context.Context, file *models.File, username, trigger string) {
	if !s.Available() || file == nil || !isMediaMime(file.MimeType) {
		return
	}
	targets := map[uuid.UUID]bool{}

	q, tx, err := s.queries.ForUser(ctx, file.UserID)
	if err != nil {
		log.Printf("recognition enqueue file %s: %v", file.ID, err)
		return
	}
	if file.FolderID != nil {
		if ancestors, err := q.GetFolderAncestors(ctx, file.UserID, *file.FolderID); err == nil {
			for _, a := range ancestors {
				if a.Kind == models.FolderKindMedia && a.AIRecognitionEnabled {
					targets[a.ID] = true
				}
			}
		}
	}
	if pointerColls, err := q.ListEnabledRecognitionCollectionsForFile(ctx, file.ID); err == nil {
		for _, id := range pointerColls {
			targets[id] = true
		}
	}
	_ = tx.Rollback()

	total := 0
	for collID := range targets {
		n, err := s.queries.UpsertRecognitionJobs(ctx, file.UserID, username, collID, []uuid.UUID{file.ID})
		if err != nil {
			log.Printf("recognition enqueue file %s → %s: %v", file.ID, collID, err)
			continue
		}
		total += n
	}
	if total > 0 {
		s.audit(ctx, username, "recognition_files_enqueued", file.ID, file.Name,
			map[string]any{"file_count": total, "trigger": trigger})
	}
}

// audit writes one lifecycle event to the shared audit_logs table. The
// recognition pipeline acts on the owner's behalf, so actor = target.
func (s *RecognitionService) audit(ctx context.Context, username, action string, resourceID uuid.UUID, resourceName string, details map[string]any) {
	resourceType := "collection"
	if strings.HasPrefix(action, "recognition_group") {
		resourceType = "recognition_group"
	} else if action == "recognition_files_enqueued" {
		resourceType = "file"
	}
	var raw json.RawMessage
	if details != nil {
		raw, _ = json.Marshal(details)
	}
	in := db.AuditInput{
		TargetUsername: username,
		ActorUsername:  username,
		Action:         action,
		ResourceType:   &resourceType,
		ResourceID:     &resourceID,
		ResourceName:   &resourceName,
		Details:        raw,
	}
	if err := s.queries.InsertAuditLog(ctx, in); err != nil {
		log.Printf("recognition audit %s: %v", action, err)
	}
}

func equalStrPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
