package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gabriel-vasile/mimetype"
	"github.com/google/uuid"
	"github.com/lib/pq"
	"github.com/minio/minio-go/v7"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// ── Config & types ────────────────────────────────────────────────────────────

// FileServiceConfig holds non-dependency configuration for the FileService.
type FileServiceConfig struct {
	// QuotaWarnPct is the usage percentage at which a quota warning email is sent.
	// e.g. 80 means a warning is sent when the user reaches 80 % of their quota.
	QuotaWarnPct int
}

// UploadInput carries the multipart stream and metadata for a file upload.
type UploadInput struct {
	// Username is the authenticated user's preferred_username (for DB lookups).
	Username string
	// UserID is the Keycloak sub UUID (stored as files.user_id FK).
	UserID uuid.UUID
	// FolderID is the target folder. Nil means the file is placed at root.
	FolderID *uuid.UUID
	// Name is the display filename stored in the metadata table.
	Name string
	// MimeType is provided by the client. If empty the service detects it from
	// the file contents. Always treat as a hint; server-detected type is preferred.
	MimeType string
	// DeviceID identifies the mobile device that triggered this upload. Nil for
	// web uploads. Stored on the file row for "synced from this device" display.
	DeviceID *uuid.UUID
	// Source is the upload origin: "web" | "device" | "google_drive" |
	// "google_photos". Blank is normalized to "web" when stored.
	Source string
	// Reader is the raw plaintext byte stream (multipart file reader).
	// The service reads it fully into memory before encrypting; this is required
	// for single-blob AES-256-GCM and for MIME detection. Video files use chunked
	// AES-256-GCM (1 MiB chunks with independent nonces) for range-based streaming.
	Reader io.Reader
}

// ── Service ───────────────────────────────────────────────────────────────────

// userCacheTTL is how long a fetched user record (encrypted key material) is
// kept in memory before the next Range request re-fetches it from Postgres.
// 30 seconds eliminates the DB round-trip on rapid sequential Range requests
// (video seeks, buffer fills) while keeping the window short enough that a
// key-rotation re-wrap is visible within one rotation batch cycle.
const userCacheTTL = 30 * time.Second

type cachedUser struct {
	user      models.User
	expiresAt time.Time
}

// ── Read-ahead cache ──────────────────────────────────────────────────────────

// readAheadSize is the number of plaintext bytes prefetched after each served
// range. Aligned to ChunkSize so we always work on complete encryption chunks.
const readAheadSize = 4 * ChunkSize

// readAheadTTL is how long a prefetched segment lives in the cache before
// expiry. Sequential playback consumes entries well within this window.
const readAheadTTL = 30 * time.Second

// readAheadMaxEntries caps the number of live cache entries. At 4 MiB each
// this bounds read-ahead memory to ~64 MiB across all concurrent streams.
const readAheadMaxEntries = 16

// raKey uniquely identifies a cached plaintext segment.
// objectKey (not file ID) is used so original-quality and variant streams
// for the same file do not collide in the cache.
type raKey struct {
	objectKey string // MinIO object key
	offset    int64  // byte offset of the first plaintext byte in the slice
}

type raEntry struct {
	data      []byte
	expiresAt time.Time
}

type cachedAlloc struct {
	storage   *MinIOService
	driveID   uuid.UUID
	expiresAt time.Time
}

type cachedDrive struct {
	storage   *MinIOService
	expiresAt time.Time
}

// FileService handles encrypted file upload, download, metadata retrieval,
// rename, and deletion. All blobs are AES-256-GCM encrypted before being
// written to MinIO; plaintext never leaves the service boundary.
type FileService struct {
	queries      *db.Queries
	registry     *MinIORegistry
	enc          *EncryptionService
	email        *EmailService
	transcode    *TranscodeService
	meta         *MetadataService
	quotaWarnPct int

	userCacheMu sync.RWMutex
	userCache   map[string]cachedUser

	allocCacheMu sync.RWMutex
	allocCache   map[string]cachedAlloc

	driveCacheMu sync.RWMutex
	driveCache   map[uuid.UUID]cachedDrive

	raMu       sync.Mutex
	raCache    map[raKey]*raEntry
	raInflight map[raKey]struct{} // keys with an active prefetch goroutine
}

// NewFileService constructs a FileService.
func NewFileService(q *db.Queries, registry *MinIORegistry, enc *EncryptionService, email *EmailService, transcode *TranscodeService, meta *MetadataService, cfg FileServiceConfig) *FileService {
	return &FileService{
		queries:      q,
		registry:     registry,
		enc:          enc,
		email:        email,
		transcode:    transcode,
		meta:         meta,
		quotaWarnPct: cfg.QuotaWarnPct,
		userCache:    make(map[string]cachedUser),
		allocCache:   make(map[string]cachedAlloc),
		driveCache:   make(map[uuid.UUID]cachedDrive),
		raCache:      make(map[raKey]*raEntry),
		raInflight:   make(map[raKey]struct{}),
	}
}

// storageFor returns the MinIOService and driveID for the given user. Results
// are cached for userCacheTTL to avoid a DB round-trip on every range request.
func (s *FileService) storageFor(ctx context.Context, username string) (*MinIOService, uuid.UUID, error) {
	s.allocCacheMu.RLock()
	entry, ok := s.allocCache[username]
	s.allocCacheMu.RUnlock()
	if ok && time.Now().Before(entry.expiresAt) {
		return entry.storage, entry.driveID, nil
	}

	alloc, err := s.queries.GetUserDrive(ctx, username)
	if err != nil {
		return nil, uuid.Nil, fmt.Errorf("storage lookup for %q: %w", username, err)
	}
	if alloc == nil {
		return nil, uuid.Nil, fmt.Errorf("storage lookup for %q: no drive allocation", username)
	}
	client, ok := s.registry.ClientForDrive(alloc.Server.ID, alloc.Drive.NodeID, alloc.NodeHasMinIO)
	if !ok {
		return nil, uuid.Nil, fmt.Errorf("storage lookup for %q: no MinIO client for server %s", username, alloc.Server.Name)
	}
	svc := NewMinIOService(client, alloc.Drive.MinioBucket)

	s.allocCacheMu.Lock()
	s.allocCache[username] = cachedAlloc{
		storage:   svc,
		driveID:   alloc.DriveID,
		expiresAt: time.Now().Add(userCacheTTL),
	}
	s.allocCacheMu.Unlock()

	return svc, alloc.DriveID, nil
}

// storageForDrive returns the MinIOService for a specific drive, cached by drive
// ID. Used to read a file from whichever drive it was stored on, regardless of
// the user's current primary.
func (s *FileService) storageForDrive(ctx context.Context, driveID uuid.UUID) (*MinIOService, error) {
	s.driveCacheMu.RLock()
	entry, ok := s.driveCache[driveID]
	s.driveCacheMu.RUnlock()
	if ok && time.Now().Before(entry.expiresAt) {
		return entry.storage, nil
	}

	alloc, err := s.queries.GetDriveWithServer(ctx, driveID)
	if err != nil {
		return nil, fmt.Errorf("drive lookup %s: %w", driveID, err)
	}
	if alloc == nil {
		return nil, fmt.Errorf("drive lookup %s: not found", driveID)
	}
	client, ok := s.registry.ClientForDrive(alloc.Server.ID, alloc.Drive.NodeID, alloc.NodeHasMinIO)
	if !ok {
		return nil, fmt.Errorf("drive lookup %s: no MinIO client for server %s", driveID, alloc.Server.Name)
	}
	svc := NewMinIOService(client, alloc.Drive.MinioBucket)

	s.driveCacheMu.Lock()
	s.driveCache[driveID] = cachedDrive{storage: svc, expiresAt: time.Now().Add(userCacheTTL)}
	s.driveCacheMu.Unlock()

	return svc, nil
}

// storageForFile resolves the MinIOService for the drive a file lives on. Files
// record their drive at upload; legacy rows without one fall back to the user's
// primary drive.
func (s *FileService) storageForFile(ctx context.Context, username string, file *models.File) (*MinIOService, error) {
	if file.DriveID != nil {
		if svc, err := s.storageForDrive(ctx, *file.DriveID); err == nil {
			return svc, nil
		}
	}
	svc, _, err := s.storageFor(ctx, username)
	return svc, err
}

// resolveUploadDrive chooses the drive a new upload of fileSize bytes should
// land on. When folderDriveID is non-nil (the destination folder has a pinned
// drive) and that drive is still usable, it wins outright. Otherwise the
// user's primary drive wins when it has room; failing that, the owned drive
// with the lowest physical used-percentage that can fit the file is used.
// Falls back to the user's primary allocation when no usage data is available.
// userID is the Keycloak sub UUID (stored as files.user_id) used to compute per-user usage.
func (s *FileService) resolveUploadDrive(ctx context.Context, username string, userID uuid.UUID, fileSize int64, folderDriveID *uuid.UUID) (*MinIOService, uuid.UUID, error) {
	drives, err := s.queries.GetUserDrives(ctx, username, userID.String())
	if err != nil {
		return nil, uuid.Nil, fmt.Errorf("resolve upload drive: %w", err)
	}

	if driveID, ok := pinnedDriveIfValid(drives, folderDriveID, fileSize); ok {
		svc, err := s.storageForDrive(ctx, driveID)
		if err != nil {
			return nil, uuid.Nil, fmt.Errorf("resolve upload drive: %w", err)
		}
		return svc, driveID, nil
	}

	// No multi-drive info (or single drive): use the existing primary path.
	if len(drives) <= 1 {
		return s.storageFor(ctx, username)
	}

	driveID, ok := pickUploadDrive(drives, fileSize)
	if !ok {
		// Nothing has room — let the primary path run so the caller surfaces a
		// normal quota/space error instead of a routing failure.
		return s.storageFor(ctx, username)
	}

	svc, err := s.storageForDrive(ctx, driveID)
	if err != nil {
		return nil, uuid.Nil, fmt.Errorf("resolve upload drive: %w", err)
	}
	return svc, driveID, nil
}

// pinnedDriveIfValid returns the folder-pinned drive when it's still usable:
// active, has room, and still present in the user's current allocations (an
// allocation can be revoked after the folder was created, e.g. a premium
// downgrade). ok=false tells the caller to fall through to pickUploadDrive.
func pinnedDriveIfValid(drives []db.UserDriveInfo, folderDriveID *uuid.UUID, fileSize int64) (uuid.UUID, bool) {
	if folderDriveID == nil {
		return uuid.Nil, false
	}
	for _, d := range drives {
		if d.DriveID == *folderDriveID && d.DriveIsActive && d.ServerIsActive && d.CapacityBytes-d.DriveUsedBytes >= fileSize {
			return d.DriveID, true
		}
	}
	return uuid.Nil, false
}

// pickUploadDrive selects the drive a new upload of fileSize bytes should land
// on: the primary when it has room, otherwise the active owned drive with the
// lowest physical used-percentage that can still fit the file. ok is false when
// no owned drive has room. Pure function — no I/O — so it is unit-tested directly.
func pickUploadDrive(drives []db.UserDriveInfo, fileSize int64) (uuid.UUID, bool) {
	var bestID uuid.UUID
	var bestPct float64
	found := false
	for _, d := range drives {
		if !d.DriveIsActive || !d.ServerIsActive {
			continue
		}
		if d.CapacityBytes-d.DriveUsedBytes < fileSize {
			continue // no room for this file
		}
		if d.IsPrimary {
			return d.DriveID, true // primary wins outright when it fits
		}
		var pct float64
		if d.CapacityBytes > 0 {
			pct = float64(d.DriveUsedBytes) / float64(d.CapacityBytes)
		}
		if !found || pct < bestPct {
			bestID, bestPct, found = d.DriveID, pct, true
		}
	}
	return bestID, found
}

// ── Public operations ─────────────────────────────────────────────────────────

// Upload reads the plaintext stream from in.Reader, detects the MIME type,
// encrypts the content, streams the ciphertext to MinIO, and inserts the file
// metadata into the DB.
//
// Returns ErrQuotaExceeded when the upload would push the user over their quota.
func (s *FileService) Upload(ctx context.Context, in UploadInput) (*models.File, error) {
	// 1. Load the plaintext into memory — required for AES-256-GCM authentication.
	plaintext, err := io.ReadAll(in.Reader)
	if err != nil {
		return nil, fmt.Errorf("upload: read body: %w", err)
	}

	// 2. Compute SHA-256 for client-side dedup before any transformation.
	rawHash := sha256.Sum256(plaintext)
	hashHex := hex.EncodeToString(rawHash[:])

	// 3. Detect MIME type from actual content; fall back to client-provided hint.
	mimeType := in.MimeType
	if detected := mimetype.Detect(plaintext); detected != nil {
		mimeType = detected.String()
	}

	// 2b. Auto-route image/video uploads to the user's media folder if configured.
	in.FolderID = s.resolveUploadFolder(ctx, in.Username, in.FolderID, mimeType)

	// 2c. For images, extract the capture date and GPS coordinates now (plaintext
	// is already in memory). Videos are probed asynchronously after the blob is stored.
	var takenAt *time.Time
	var latitude, longitude *float64
	if strings.HasPrefix(mimeType, "image/") {
		takenAt = ExtractImageTakenAt(plaintext)
		latitude, longitude = ExtractImageLocation(plaintext)
	}

	// 3. Quota check.
	user, err := s.queries.GetUserByUsername(ctx, in.Username)
	if err != nil {
		return nil, fmt.Errorf("upload: get user: %w", err)
	}
	fileSize := int64(len(plaintext))
	if user.StorageUsedBytes+fileSize > user.StorageQuotaBytes {
		return nil, ErrQuotaExceeded
	}

	// 4. Decrypt the user's AES key.
	userKey, err := s.enc.DecryptUserKey(user.EncryptedKey, user.KeyNonce, user.MasterKeyVersion)
	if err != nil {
		return nil, fmt.Errorf("upload: decrypt user key: %w", err)
	}
	defer zeroBytes(userKey)

	// 5. Encrypt the file.
	// Video files use chunked AES-256-GCM: each 1 MiB chunk gets its own nonce,
	// enabling efficient range-based streaming (only needed chunks are fetched and
	// decrypted). The DB nonce is stored empty to signal chunked mode.
	// All other files use single-blob AES-256-GCM as before.
	var ciphertext, nonce []byte
	if strings.HasPrefix(mimeType, "video/") {
		ciphertext, err = s.enc.EncryptChunked(userKey, plaintext)
		if err != nil {
			return nil, fmt.Errorf("upload: encrypt chunks: %w", err)
		}
		nonce = []byte{} // empty nonce signals chunked mode; per-chunk nonces are embedded inline
	} else {
		ciphertext, nonce, err = s.enc.EncryptFile(userKey, plaintext)
		if err != nil {
			return nil, fmt.Errorf("upload: encrypt: %w", err)
		}
	}

	// 6. Resolve the destination drive: the destination folder's pin if valid,
	// otherwise the user's primary, or the least-full owned drive when the
	// primary can't fit the file.
	var folderDriveID *uuid.UUID
	if in.FolderID != nil {
		if folder, err := s.queries.GetFolderByID(ctx, *in.FolderID); err == nil {
			folderDriveID = folder.DriveID
		}
	}
	storage, driveID, err := s.resolveUploadDrive(ctx, in.Username, in.UserID, fileSize, folderDriveID)
	if err != nil {
		return nil, fmt.Errorf("upload: %w", err)
	}

	// 7. Stream ciphertext to MinIO. Object key: {userID}/{fileID}.
	fileID := uuid.New()
	objectKey := objectKeyFor(in.UserID, fileID)

	if err := storage.PutObject(
		ctx, objectKey,
		bytes.NewReader(ciphertext), int64(len(ciphertext)),
		"application/octet-stream",
	); err != nil {
		return nil, fmt.Errorf("upload: store: %w", err)
	}

	// 8. Insert file metadata into DB within a user-scoped transaction.
	uq, utx, err := s.queries.ForUser(ctx, in.UserID)
	if err != nil {
		_ = storage.RemoveObject(ctx, objectKey)
		return nil, fmt.Errorf("upload: begin tx: %w", err)
	}
	defer func() { _ = utx.Rollback() }()
	file, err := uq.CreateFile(ctx, &models.File{
		ID:             fileID,
		UserID:         in.UserID,
		FolderID:       in.FolderID,
		DriveID:        &driveID,
		Name:           in.Name,
		MimeType:       mimeType,
		SizeBytes:      fileSize,
		MinIOObjectKey: objectKey,
		Nonce:          nonce,
		TakenAt:        takenAt,
		SHA256Hash:     &hashHex,
		DeviceID:       in.DeviceID,
		Source:         in.Source,
		Latitude:       latitude,
		Longitude:      longitude,
	})
	if err != nil {
		// Best-effort cleanup: delete the orphaned MinIO object.
		_ = storage.RemoveObject(ctx, objectKey)
		var pqErr *pq.Error
		if errors.As(err, &pqErr) && pqErr.Code == "23505" {
			return nil, ErrDuplicateName
		}
		return nil, fmt.Errorf("upload: save metadata: %w", err)
	}
	if err := utx.Commit(); err != nil {
		_ = storage.RemoveObject(ctx, objectKey)
		return nil, fmt.Errorf("upload: commit: %w", err)
	}

	// 8. Update the user's running storage total (users table has no RLS).
	if err := s.queries.AddStorageUsed(ctx, in.Username, fileSize); err != nil {
		return nil, fmt.Errorf("upload: update storage: %w", err)
	}

	// 9. Send quota warning / limit email if the upload crossed a threshold.
	// Failures are non-fatal and logged; they must not block the upload response.
	if s.email != nil && s.quotaWarnPct > 0 {
		newUsed := user.StorageUsedBytes + fileSize
		pct := int(newUsed * 100 / user.StorageQuotaBytes)
		prevPct := int(user.StorageUsedBytes * 100 / user.StorageQuotaBytes)
		usedFmt := fmtBytes(newUsed)
		quotaFmt := fmtBytes(user.StorageQuotaBytes)
		switch {
		case pct >= 100 && prevPct < 100:
			if err := s.email.SendQuotaLimit(ctx, user, usedFmt, quotaFmt); err != nil {
				log.Printf("upload: send quota-limit email for %q: %v", in.Username, err)
			}
		case pct >= s.quotaWarnPct && prevPct < s.quotaWarnPct:
			if err := s.email.SendQuotaWarning(ctx, user, pct, usedFmt, quotaFmt); err != nil {
				log.Printf("upload: send quota-warning email for %q: %v", in.Username, err)
			}
		}
	}

	// 10. Kick off background 480p transcoding for video files.
	if strings.HasPrefix(mimeType, "video/") && s.transcode != nil && s.transcode.Available() {
		go s.createVariant(file, in.Username)
	}

	// 11. Probe video capture date in the background (images were done in step 2c).
	if strings.HasPrefix(mimeType, "video/") {
		go s.extractTakenAtAsync(file, in.Username)
	}

	return file, nil
}

// resolveUploadFolder returns the destination folder for an upload. When the
// user has configured a media auto-upload folder and the upload is an image or
// video, every such upload is routed there — UNLESS the user is explicitly
// uploading into a media folder already, in which case that destination wins
// (so per-collection uploads land where the user dropped them).
func (s *FileService) resolveUploadFolder(ctx context.Context, username string, requested *uuid.UUID, mimeType string) *uuid.UUID {
	if !isMediaMime(mimeType) {
		return requested
	}
	// Explicit upload into a media folder: respect it, skip redirect.
	if requested != nil {
		if folder, err := s.queries.GetFolderByID(ctx, *requested); err == nil && folder.Kind == models.FolderKindMedia {
			return requested
		}
	}
	prefs, err := s.queries.GetUserPreferences(ctx, username)
	if err != nil || prefs.MediaAutouploadFolderID == nil {
		return requested
	}
	return prefs.MediaAutouploadFolderID
}

// isMediaMime reports whether a MIME type is an image or video.
func isMediaMime(mimeType string) bool {
	return strings.HasPrefix(mimeType, "image/") || strings.HasPrefix(mimeType, "video/")
}

// extractTakenAtAsync downloads a stored file, extracts its capture date
// (EXIF for images, ffprobe for videos), and persists it. Best-effort: any
// failure is logged and leaves taken_at null so listings fall back to upload date.
func (s *FileService) extractTakenAtAsync(file *models.File, username string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("metadata: recovered panic for %s: %v", file.ID, r)
		}
	}()
	ctx := context.Background()

	var (
		plaintext []byte
		err       error
	)
	if IsChunked(file) {
		plaintext, err = s.DownloadChunked(ctx, file, username)
	} else {
		_, plaintext, err = s.Download(ctx, file.ID, file.UserID, username)
	}
	if err != nil {
		log.Printf("metadata: download %s: %v", file.ID, err)
		return
	}

	var takenAt *time.Time
	switch {
	case strings.HasPrefix(file.MimeType, "image/"):
		takenAt = ExtractImageTakenAt(plaintext)
	case strings.HasPrefix(file.MimeType, "video/"):
		if s.meta == nil {
			return
		}
		path, cleanup, terr := extractToTempFile(plaintext, mimeToExt(file.MimeType))
		if terr != nil {
			log.Printf("metadata: temp file %s: %v", file.ID, terr)
			return
		}
		defer cleanup()
		takenAt = s.meta.ExtractVideoTakenAt(ctx, path)
	}

	if takenAt == nil {
		return
	}
	if err := s.queries.SetFileTakenAt(ctx, file.ID, *takenAt); err != nil {
		log.Printf("metadata: persist taken_at %s: %v", file.ID, err)
	}
}

// SetHidden toggles a file's hidden flag. Returns ErrNotFound if the file does
// not belong to userID.
func (s *FileService) SetHidden(ctx context.Context, fileID, userID uuid.UUID, hidden bool) (*models.File, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("set hidden: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := q.GetFileByID(ctx, fileID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("set hidden: get file: %w", err)
	}
	updated, err := q.SetFileHidden(ctx, fileID, hidden)
	if err != nil {
		return nil, fmt.Errorf("set hidden: %w", err)
	}
	return updated, tx.Commit()
}

// CheckQuota returns ErrQuotaExceeded when adding additionalBytes would push the
// user over their storage limit. Used by InitUpload for an early rejection.
func (s *FileService) CheckQuota(ctx context.Context, username string, additionalBytes int64) error {
	user, err := s.queries.GetUserByUsername(ctx, username)
	if err != nil {
		return fmt.Errorf("get user: %w", err)
	}
	if user.StorageUsedBytes+additionalBytes > user.StorageQuotaBytes {
		return ErrQuotaExceeded
	}
	return nil
}

// GetMetadata returns a file's metadata from the DB without fetching the blob.
// Returns ErrNotFound when the file does not exist or is not owned by userID.
func (s *FileService) GetMetadata(ctx context.Context, fileID, userID uuid.UUID) (*models.File, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get metadata: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	file, err := q.GetFileByID(ctx, fileID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get metadata: %w", err)
	}
	if file.UserID != userID {
		return nil, ErrNotFound
	}
	return file, nil
}

// Download fetches the encrypted blob from MinIO, decrypts it, and returns the
// file metadata and plaintext bytes ready for streaming to the client.
func (s *FileService) Download(ctx context.Context, fileID, userID uuid.UUID, username string) (*models.File, []byte, error) {
	file, err := s.GetMetadata(ctx, fileID, userID)
	if err != nil {
		return nil, nil, err
	}
	plaintext, err := s.decryptBlob(ctx, username, file)
	if err != nil {
		return nil, nil, fmt.Errorf("download: %w", err)
	}
	return file, plaintext, nil
}

// Rename changes a file's display name.
// Returns ErrNotFound if the file does not belong to userID.
func (s *FileService) Rename(ctx context.Context, fileID, userID uuid.UUID, name string) (*models.File, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("rename: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := q.GetFileByID(ctx, fileID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("rename: get file: %w", err)
	}
	updated, err := q.UpdateFileName(ctx, fileID, name)
	if err != nil {
		return nil, fmt.Errorf("rename: %w", err)
	}
	return updated, tx.Commit()
}

// Move transfers a file to a different folder owned by the same user.
// Returns ErrNotFound if the file does not belong to userID.
// Returns ErrFolderNotFound if the target folder does not belong to userID.
func (s *FileService) Move(ctx context.Context, fileID, userID, newFolderID uuid.UUID) (*models.File, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("move: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	file, err := q.GetFileByID(ctx, fileID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("move: get file: %w", err)
	}
	if file.FolderID != nil && *file.FolderID == newFolderID {
		return file, nil
	}
	if _, err := q.GetFolderByID(ctx, newFolderID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrFolderNotFound
		}
		return nil, fmt.Errorf("move: get target folder: %w", err)
	}
	moved, err := q.MoveFile(ctx, fileID, newFolderID)
	if err != nil {
		return nil, fmt.Errorf("move: %w", err)
	}
	return moved, tx.Commit()
}

// Delete removes the encrypted blob from MinIO, deletes the metadata row, and
// decrements the user's storage counter. Any video variant blobs are also
// removed from MinIO (DB rows are cascade-deleted with the parent file row).
// Returns ErrNotFound if the file does not belong to userID.
func (s *FileService) Delete(ctx context.Context, fileID, userID uuid.UUID, username string) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("delete: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	file, err := q.GetFileByID(ctx, fileID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("delete: get file: %w", err)
	}

	storage, err := s.storageForFile(ctx, username, file)
	if err != nil {
		return fmt.Errorf("delete: %w", err)
	}

	// Best-effort: remove any transcoded variant blobs before the parent row is deleted.
	if variants, err := q.ListVideoVariants(ctx, fileID); err == nil {
		for _, v := range variants {
			_ = storage.RemoveObject(ctx, v.MinIOObjectKey)
		}
	}

	if err := storage.RemoveObject(ctx, file.MinIOObjectKey); err != nil {
		return fmt.Errorf("delete: remove blob: %w", err)
	}
	if err := q.DeleteFile(ctx, fileID, userID); err != nil {
		return fmt.Errorf("delete: remove metadata: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("delete: commit: %w", err)
	}
	// AddStorageUsed touches the users table (no RLS) — use the pool directly.
	if err := s.queries.AddStorageUsed(ctx, username, -file.SizeBytes); err != nil {
		return fmt.Errorf("delete: update storage: %w", err)
	}
	return nil
}

// AdminDeleteAllFiles deletes every file owned by username from MinIO and the
// database, then resets the user's storage counters to zero. Intended for the
// permanent-ban flow where all content must be purged immediately.
func (s *FileService) AdminDeleteAllFiles(ctx context.Context, username string) error {
	files, err := s.queries.GetAllUserFiles(ctx, username)
	if err != nil {
		return fmt.Errorf("AdminDeleteAllFiles list: %w", err)
	}

	for _, f := range files {
		// Each file may live on a different drive — resolve per file.
		f := f
		storage, err := s.storageForFile(ctx, username, &f)
		if err != nil {
			log.Printf("AdminDeleteAllFiles: storage for %s: %v", f.ID, err)
			continue
		}
		// Remove video variant blobs first (DB rows cascade-delete with parent).
		if variants, err := s.queries.ListVideoVariants(ctx, f.ID); err == nil {
			for _, v := range variants {
				_ = storage.RemoveObject(ctx, v.MinIOObjectKey)
			}
		}
		_ = storage.RemoveObject(ctx, f.MinIOObjectKey)
	}

	if err := s.queries.DeleteAllUserFileRows(ctx, username); err != nil {
		return fmt.Errorf("AdminDeleteAllFiles delete rows: %w", err)
	}
	if err := s.queries.ResetUserStorage(ctx, username); err != nil {
		return fmt.Errorf("AdminDeleteAllFiles reset storage: %w", err)
	}
	return nil
}

// GetVariant returns the video_variants row for fileID/quality.
// Returns ErrNotFound if no variant exists or it is not yet ready.
func (s *FileService) GetVariant(ctx context.Context, fileID uuid.UUID, quality string) (*models.VideoVariant, error) {
	v, err := s.queries.GetVideoVariant(ctx, fileID, quality)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get variant: %w", err)
	}
	if v.Status != models.VideoVariantStatusReady {
		return nil, ErrNotFound
	}
	return v, nil
}

// HasReadyVariant reports whether a ready low-quality variant exists for fileID.
func (s *FileService) HasReadyVariant(ctx context.Context, fileID uuid.UUID) bool {
	v, err := s.queries.GetVideoVariant(ctx, fileID, LowQualityLabel)
	return err == nil && v.Status == models.VideoVariantStatusReady
}

// createVariant decrypts the source video, transcodes it to 480p with FFmpeg,
// re-encrypts the result, and stores it in MinIO. Runs as a background goroutine
// after a successful video upload. Panics are recovered and logged.
func (s *FileService) createVariant(file *models.File, username string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("transcode: recovered panic for %s: %v", file.ID, r)
			_ = s.queries.MarkVideoVariantFailed(context.Background(), file.ID, LowQualityLabel)
		}
	}()

	ctx := context.Background()
	variantKey := objectKeyFor(file.UserID, uuid.New())

	storage, storErr := s.storageForFile(ctx, username, file)
	if storErr != nil {
		log.Printf("transcode: storage lookup for %s: %v", file.ID, storErr)
		return
	}

	if _, err := s.queries.CreateVideoVariant(ctx, file.ID, LowQualityLabel, variantKey); err != nil {
		log.Printf("transcode: create record for %s: %v", file.ID, err)
		return
	}

	markFailed := func() { _ = s.queries.MarkVideoVariantFailed(ctx, file.ID, LowQualityLabel) }

	log.Printf("transcode: start %s (%.1f MB)", file.ID, float64(file.SizeBytes)/(1024*1024))

	// Decrypt source.
	var (
		plaintext []byte
		err       error
	)
	if IsChunked(file) {
		plaintext, err = s.DownloadChunked(ctx, file, username)
	} else {
		_, plaintext, err = s.Download(ctx, file.ID, file.UserID, username)
	}
	if err != nil {
		log.Printf("transcode: download source for %s: %v", file.ID, err)
		markFailed()
		return
	}

	// Write plaintext to a temp input file so FFmpeg can seek in it.
	ext := mimeToExt(file.MimeType)
	inFile, err := os.CreateTemp("", "transcode-in-*."+ext)
	if err != nil {
		log.Printf("transcode: create temp input for %s: %v", file.ID, err)
		markFailed()
		return
	}
	defer os.Remove(inFile.Name())
	if _, err := inFile.Write(plaintext); err != nil {
		inFile.Close()
		log.Printf("transcode: write temp input for %s: %v", file.ID, err)
		markFailed()
		return
	}
	inFile.Close()
	plaintext = nil // allow GC before allocating output

	// Prepare output temp file.
	outFile, err := os.CreateTemp("", "transcode-out-*.mp4")
	if err != nil {
		log.Printf("transcode: create temp output for %s: %v", file.ID, err)
		markFailed()
		return
	}
	outPath := outFile.Name()
	outFile.Close()
	defer os.Remove(outPath)

	if err := s.transcode.TranscodeTo480p(ctx, inFile.Name(), outPath); err != nil {
		log.Printf("transcode: ffmpeg for %s: %v", file.ID, err)
		markFailed()
		return
	}

	transcoded, err := os.ReadFile(outPath)
	if err != nil {
		log.Printf("transcode: read output for %s: %v", file.ID, err)
		markFailed()
		return
	}
	variantPlaintextSize := int64(len(transcoded))

	userKey, err := s.userKey(ctx, username)
	if err != nil {
		log.Printf("transcode: get user key for %s: %v", file.ID, err)
		markFailed()
		return
	}
	defer zeroBytes(userKey)

	ciphertext, err := s.enc.EncryptChunked(userKey, transcoded)
	transcoded = nil
	if err != nil {
		log.Printf("transcode: encrypt variant for %s: %v", file.ID, err)
		markFailed()
		return
	}

	if err := storage.PutObject(ctx, variantKey, bytes.NewReader(ciphertext), int64(len(ciphertext)), "application/octet-stream"); err != nil {
		log.Printf("transcode: upload variant for %s: %v", file.ID, err)
		markFailed()
		return
	}

	if err := s.queries.MarkVideoVariantReady(ctx, file.ID, LowQualityLabel, variantPlaintextSize); err != nil {
		log.Printf("transcode: mark ready for %s: %v", file.ID, err)
		_ = storage.RemoveObject(ctx, variantKey)
		return
	}
	log.Printf("transcode: done %s → 480p (%.1f MB)", file.ID, float64(variantPlaintextSize)/(1024*1024))
}

// mimeToExt returns a file extension for a video MIME type so FFmpeg can
// auto-detect the input container format from the filename.
func mimeToExt(mimeType string) string {
	switch mimeType {
	case "video/mp4":
		return "mp4"
	case "video/x-matroska":
		return "mkv"
	case "video/webm":
		return "webm"
	case "video/quicktime":
		return "mov"
	case "video/x-msvideo":
		return "avi"
	default:
		return "mp4"
	}
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// IsChunked reports whether f was encrypted with chunked AES-256-GCM.
// Chunked files store an empty Nonce; per-chunk nonces are embedded in the blob.
func IsChunked(f *models.File) bool {
	return len(f.Nonce) == 0
}

// DownloadChunked fetches the full blob for a chunked-encrypted file and
// decrypts all chunks concurrently. Use this when no byte range is required.
func (s *FileService) DownloadChunked(ctx context.Context, file *models.File, username string) ([]byte, error) {
	userKey, err := s.userKey(ctx, username)
	if err != nil {
		return nil, fmt.Errorf("download chunked: %w", err)
	}
	defer zeroBytes(userKey)

	storage, err := s.storageForFile(ctx, username, file)
	if err != nil {
		return nil, fmt.Errorf("download chunked: %w", err)
	}

	rc, err := storage.GetObject(ctx, file.MinIOObjectKey)
	if err != nil {
		return nil, fmt.Errorf("download chunked: fetch blob: %w", err)
	}
	defer rc.Close()

	blob, err := io.ReadAll(rc)
	if err != nil {
		return nil, fmt.Errorf("download chunked: read blob: %w", err)
	}
	return s.enc.DecryptChunked(userKey, blob)
}

// fetchRange fetches and decrypts plaintext bytes [rangeStart, rangeEnd] for a
// chunked-encrypted file, bypassing the read-ahead cache. It is the inner
// implementation shared by DownloadRange and the prefetch goroutine.
func (s *FileService) fetchRange(ctx context.Context, storage *MinIOService, file *models.File, username string, rangeStart, rangeEnd int64) ([]byte, error) {
	userKey, err := s.userKey(ctx, username)
	if err != nil {
		return nil, fmt.Errorf("fetch range: %w", err)
	}
	defer zeroBytes(userKey)

	totalSize := file.SizeBytes
	numChunks := (totalSize + int64(ChunkSize) - 1) / int64(ChunkSize)

	firstChunkIdx := rangeStart / int64(ChunkSize)
	lastChunkIdx := rangeEnd / int64(ChunkSize)

	blobStart := firstChunkIdx * int64(StoredChunkSize)

	var lastStoredSize int64
	if lastChunkIdx == numChunks-1 {
		lastPlain := totalSize - lastChunkIdx*int64(ChunkSize)
		lastStoredSize = lastPlain + int64(ChunkOverhead)
	} else {
		lastStoredSize = int64(StoredChunkSize)
	}
	blobEnd := blobStart + (lastChunkIdx-firstChunkIdx)*int64(StoredChunkSize) + lastStoredSize - 1

	rc, err := storage.GetObjectRange(ctx, file.MinIOObjectKey, blobStart, blobEnd)
	if err != nil {
		return nil, fmt.Errorf("fetch range: get object: %w", err)
	}
	defer rc.Close()

	blobSlice, err := io.ReadAll(rc)
	if err != nil {
		return nil, fmt.Errorf("fetch range: read: %w", err)
	}

	return s.enc.DecryptChunkedRange(userKey, blobSlice, firstChunkIdx, numChunks, totalSize, rangeStart, rangeEnd)
}

// DownloadRange fetches only the MinIO chunks covering plaintext [rangeStart, rangeEnd]
// for a chunked-encrypted file and decrypts them concurrently. Only the bytes
// that fall within the requested range are returned. A cache hit serves the
// response from RAM; on a miss, fetchRange is called and a prefetch goroutine
// is scheduled for the next segment to hide the latency of the following request.
func (s *FileService) DownloadRange(ctx context.Context, file *models.File, username string, rangeStart, rangeEnd int64) ([]byte, error) {
	storage, err := s.storageForFile(ctx, username, file)
	if err != nil {
		return nil, fmt.Errorf("download range: %w", err)
	}

	key := raKey{objectKey: file.MinIOObjectKey, offset: rangeStart}

	if cached, ok := s.raCacheGet(key); ok {
		need := rangeEnd - rangeStart + 1
		if int64(len(cached)) >= need {
			// Prefetch the segment that follows the full cached window, not just rangeEnd.
			s.schedulePrefetch(storage, file, username, rangeStart+int64(len(cached)))
			return cached[:need], nil
		}
		// Cache holds fewer bytes than needed (e.g. near EOF) — fall through.
	}

	data, err := s.fetchRange(ctx, storage, file, username, rangeStart, rangeEnd)
	if err != nil {
		return nil, err
	}
	s.schedulePrefetch(storage, file, username, rangeEnd+1)
	return data, nil
}

// raCacheGet returns the cached slice for key and removes it from the cache.
// Returns (nil, false) on miss or expiry.
func (s *FileService) raCacheGet(key raKey) ([]byte, bool) {
	s.raMu.Lock()
	defer s.raMu.Unlock()
	e, ok := s.raCache[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(e.expiresAt) {
		delete(s.raCache, key)
		return nil, false
	}
	data := e.data
	delete(s.raCache, key)
	return data, true
}

// raCachePut inserts data into the read-ahead cache under key.
// Expired entries are evicted first; if still at capacity the entry with the
// nearest expiry (oldest) is evicted to make room.
func (s *FileService) raCachePut(key raKey, data []byte) {
	s.raMu.Lock()
	defer s.raMu.Unlock()
	now := time.Now()
	for k, e := range s.raCache {
		if now.After(e.expiresAt) {
			delete(s.raCache, k)
		}
	}
	if len(s.raCache) >= readAheadMaxEntries {
		var (
			oldestKey raKey
			oldestExp time.Time
		)
		for k, e := range s.raCache {
			if oldestExp.IsZero() || e.expiresAt.Before(oldestExp) {
				oldestKey, oldestExp = k, e.expiresAt
			}
		}
		delete(s.raCache, oldestKey)
	}
	s.raCache[key] = &raEntry{data: data, expiresAt: now.Add(readAheadTTL)}
}

// schedulePrefetch launches a background goroutine to fetch and cache the
// segment starting at offset, unless one is already in-flight or cached.
func (s *FileService) schedulePrefetch(storage *MinIOService, file *models.File, username string, offset int64) {
	if offset >= file.SizeBytes {
		return
	}
	key := raKey{objectKey: file.MinIOObjectKey, offset: offset}
	s.raMu.Lock()
	_, inCache := s.raCache[key]
	_, inFlight := s.raInflight[key]
	if inCache || inFlight {
		s.raMu.Unlock()
		return
	}
	s.raInflight[key] = struct{}{}
	s.raMu.Unlock()

	// Snapshot fields needed by the goroutine; do not capture the pointer
	// since the caller may replace file (e.g., StreamFile swaps in a variant).
	fileCopy := *file
	go func() {
		defer func() {
			s.raMu.Lock()
			delete(s.raInflight, key)
			s.raMu.Unlock()
		}()
		end := offset + int64(readAheadSize) - 1
		if end >= fileCopy.SizeBytes {
			end = fileCopy.SizeBytes - 1
		}
		data, err := s.fetchRange(context.Background(), storage, &fileCopy, username, offset, end)
		if err != nil {
			log.Printf("read-ahead: prefetch %s@%d: %v", fileCopy.MinIOObjectKey, offset, err)
			return
		}
		s.raCachePut(key, data)
	}()
}

// decryptBlob fetches the ciphertext from MinIO and decrypts it with the user's key.
// Handles both legacy single-blob files and chunked-encrypted files transparently.
func (s *FileService) decryptBlob(ctx context.Context, username string, file *models.File) ([]byte, error) {
	userKey, err := s.userKey(ctx, username)
	if err != nil {
		log.Printf("decryptBlob: userKey(%s) file=%s: %v", username, file.ID, err)
		return nil, fmt.Errorf("decrypt blob: %w", err)
	}
	defer zeroBytes(userKey)

	storage, err := s.storageForFile(ctx, username, file)
	if err != nil {
		log.Printf("decryptBlob: storageForFile(%s) file=%s: %v", username, file.ID, err)
		return nil, fmt.Errorf("decrypt blob: %w", err)
	}

	rc, err := storage.GetObject(ctx, file.MinIOObjectKey)
	if err != nil {
		log.Printf("decryptBlob: GetObject(%s) file=%s: %v", file.MinIOObjectKey, file.ID, err)
		return nil, fmt.Errorf("fetch blob: %w", err)
	}
	defer rc.Close()

	data, err := io.ReadAll(rc)
	if err != nil {
		log.Printf("decryptBlob: ReadAll(%s) file=%s: %v", file.MinIOObjectKey, file.ID, err)
		return nil, fmt.Errorf("read blob: %w", err)
	}

	chunked := IsChunked(file)
	var plaintext []byte
	if chunked {
		plaintext, err = s.enc.DecryptChunked(userKey, data)
	} else {
		plaintext, err = s.enc.DecryptFile(userKey, file.Nonce, data)
	}
	if err != nil {
		log.Printf("decryptBlob: decrypt(chunked=%v) file=%s nonceLen=%d blobLen=%d: %v", chunked, file.ID, len(file.Nonce), len(data), err)
		return nil, err
	}
	return plaintext, nil
}

// userKey resolves and unwraps the plaintext AES key for username.
// The user record (encrypted key material) is cached for userCacheTTL so that
// rapid sequential Range requests during video playback do not each pay a full
// Postgres round-trip. The plaintext key is derived fresh on every call.
// The caller is responsible for zeroing the returned slice after use.
func (s *FileService) userKey(ctx context.Context, username string) ([]byte, error) {
	s.userCacheMu.RLock()
	entry, ok := s.userCache[username]
	s.userCacheMu.RUnlock()

	var u models.User
	if ok && time.Now().Before(entry.expiresAt) {
		u = entry.user
	} else {
		fetched, err := s.queries.GetUserByUsername(ctx, username)
		if err != nil {
			return nil, fmt.Errorf("get user: %w", err)
		}
		u = *fetched
		s.userCacheMu.Lock()
		s.userCache[username] = cachedUser{user: u, expiresAt: time.Now().Add(userCacheTTL)}
		s.userCacheMu.Unlock()
	}

	key, err := s.enc.DecryptUserKey(u.EncryptedKey, u.KeyNonce, u.MasterKeyVersion)
	if err != nil {
		return nil, fmt.Errorf("decrypt user key: %w", err)
	}
	return key, nil
}

// objectKeyFor builds the MinIO object key: {userID}/{fileID}.
func objectKeyFor(userID, fileID uuid.UUID) string {
	return userID.String() + "/" + fileID.String()
}

// fmtBytes formats a byte count as a human-readable string (e.g. "1.2 GB").
func fmtBytes(n int64) string {
	const (
		KB = 1024
		MB = 1024 * KB
		GB = 1024 * MB
	)
	switch {
	case n >= GB:
		return fmt.Sprintf("%.1f GB", float64(n)/GB)
	case n >= MB:
		return fmt.Sprintf("%.1f MB", float64(n)/MB)
	case n >= KB:
		return fmt.Sprintf("%d KB", n/KB)
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// ── Chunked multipart upload pipeline ────────────────────────────────────────

// BeginChunkedUpload prepares the MinIO multipart upload for sess. It decrypts
// the user's AES key (stored in sess.UserKey), assigns a new file ID and object
// key, and opens a MinIO multipart upload (stored in sess.MinioUploadID).
// Must be called once on a fresh session before any chunks are dispatched.
func (s *FileService) BeginChunkedUpload(ctx context.Context, sess *UploadSession) error {
	user, err := s.queries.GetUserByUsername(ctx, sess.Username)
	if err != nil {
		return fmt.Errorf("begin chunked upload: get user: %w", err)
	}
	userKey, err := s.enc.DecryptUserKey(user.EncryptedKey, user.KeyNonce, user.MasterKeyVersion)
	if err != nil {
		return fmt.Errorf("begin chunked upload: decrypt user key: %w", err)
	}
	// The destination drive (and thus the MinIO bucket the multipart upload is
	// opened against) must be fixed before any chunk is dispatched, so the
	// folder pin is resolved from sess.FolderID as known at session creation.
	var folderDriveID *uuid.UUID
	if sess.FolderID != nil {
		if folder, err := s.queries.GetFolderByID(ctx, *sess.FolderID); err == nil {
			folderDriveID = folder.DriveID
		}
	}
	storage, driveID, err := s.resolveUploadDrive(ctx, sess.Username, sess.UserID, sess.TotalSize, folderDriveID)
	if err != nil {
		zeroBytes(userKey)
		return fmt.Errorf("begin chunked upload: %w", err)
	}
	fileID := uuid.New()
	objectKey := objectKeyFor(sess.UserID, fileID)
	uploadID, err := storage.CreateMultipartUpload(ctx, objectKey)
	if err != nil {
		zeroBytes(userKey)
		return fmt.Errorf("begin chunked upload: create multipart: %w", err)
	}
	sess.FileID = fileID
	sess.ObjectKey = objectKey
	sess.MinioUploadID = uploadID
	sess.UserKey = userKey
	sess.DriveID = driveID
	sess.MinIOStorage = storage
	return nil
}

// EncryptAndUploadPart encrypts data using chunked AES-256-GCM and uploads it
// as MinIO multipart part (index+1). Calls sess.RecordPart when done (success
// or failure). Designed to run in a goroutine so the HTTP response for the chunk
// request can be sent immediately while encryption and upload run in the background.
//
// For the first chunk (index==0) the MIME type is detected and stored in sess.
func (s *FileService) EncryptAndUploadPart(ctx context.Context, sess *UploadSession, index int, data []byte) {
	if index == 0 {
		if detected := mimetype.Detect(data); detected != nil {
			sess.mu.Lock()
			sess.MimeType = detected.String()
			sess.mu.Unlock()
		}
	}

	// Encrypt with the same chunked AES-256-GCM format used by EncryptChunked:
	// the data is split into 1 MiB sub-chunks, each stored as (nonce || ciphertext).
	// Concatenating all parts' bytes produces the identical format as a single-blob
	// EncryptChunked call, so the existing Download/Stream paths work unchanged.
	ciphertext, err := s.enc.EncryptChunked(sess.UserKey, data)
	if err != nil {
		sess.RecordPart(index, minio.CompletePart{}, fmt.Errorf("encrypt part %d: %w", index, err))
		return
	}

	part, err := sess.MinIOStorage.UploadPart(ctx, sess.ObjectKey, sess.MinioUploadID, index+1, ciphertext)
	if err != nil {
		sess.RecordPart(index, minio.CompletePart{}, fmt.Errorf("upload part %d: %w", index, err))
		return
	}
	sess.RecordPart(index, part, nil)
}

// FinalizeChunkedUpload waits for all in-flight encryption goroutines, completes
// the MinIO multipart upload, and inserts the file metadata into the DB.
// sess.Zero is always called before returning to clear key material.
func (s *FileService) FinalizeChunkedUpload(ctx context.Context, sess *UploadSession) (*models.File, error) {
	defer sess.Zero()

	parts, err := sess.Wait()
	if err != nil {
		_ = sess.MinIOStorage.AbortMultipartUpload(ctx, sess.ObjectKey, sess.MinioUploadID)
		return nil, fmt.Errorf("finalize: part upload failed: %w", err)
	}

	if err := sess.MinIOStorage.CompleteMultipartUpload(ctx, sess.ObjectKey, sess.MinioUploadID, parts); err != nil {
		_ = sess.MinIOStorage.AbortMultipartUpload(ctx, sess.ObjectKey, sess.MinioUploadID)
		return nil, fmt.Errorf("finalize: complete multipart: %w", err)
	}

	mimeType := sess.MimeType
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	// Auto-route image/video uploads to the user's media folder if configured.
	sess.FolderID = s.resolveUploadFolder(ctx, sess.Username, sess.FolderID, mimeType)

	// Read current usage before updating so we can compute threshold crossings below.
	user, userErr := s.queries.GetUserByUsername(ctx, sess.Username)

	uq, utx, err := s.queries.ForUser(ctx, sess.UserID)
	if err != nil {
		_ = sess.MinIOStorage.RemoveObject(ctx, sess.ObjectKey)
		return nil, fmt.Errorf("finalize: begin tx: %w", err)
	}
	defer func() { _ = utx.Rollback() }()
	var sha256Hash *string
	if sess.SHA256Hash != "" {
		h := sess.SHA256Hash
		sha256Hash = &h
	}
	file, err := uq.CreateFile(ctx, &models.File{
		ID:             sess.FileID,
		UserID:         sess.UserID,
		FolderID:       sess.FolderID,
		DriveID:        &sess.DriveID,
		Name:           sess.Name,
		MimeType:       mimeType,
		SizeBytes:      sess.TotalSize,
		MinIOObjectKey: sess.ObjectKey,
		Nonce:          []byte{}, // empty nonce signals chunked encryption mode
		SHA256Hash:     sha256Hash,
	})
	if err != nil {
		_ = sess.MinIOStorage.RemoveObject(ctx, sess.ObjectKey)
		var pqErr *pq.Error
		if errors.As(err, &pqErr) && pqErr.Code == "23505" {
			return nil, ErrDuplicateName
		}
		return nil, fmt.Errorf("finalize: save metadata: %w", err)
	}
	if err := utx.Commit(); err != nil {
		_ = sess.MinIOStorage.RemoveObject(ctx, sess.ObjectKey)
		return nil, fmt.Errorf("finalize: commit: %w", err)
	}

	if err := s.queries.AddStorageUsed(ctx, sess.Username, sess.TotalSize); err != nil {
		return nil, fmt.Errorf("finalize: update storage: %w", err)
	}

	if userErr == nil && s.email != nil && s.quotaWarnPct > 0 {
		newUsed := user.StorageUsedBytes + sess.TotalSize
		pct := int(newUsed * 100 / user.StorageQuotaBytes)
		prevPct := int(user.StorageUsedBytes * 100 / user.StorageQuotaBytes)
		usedFmt := fmtBytes(newUsed)
		quotaFmt := fmtBytes(user.StorageQuotaBytes)
		switch {
		case pct >= 100 && prevPct < 100:
			if err := s.email.SendQuotaLimit(ctx, user, usedFmt, quotaFmt); err != nil {
				log.Printf("finalize upload: send quota-limit email for %q: %v", sess.Username, err)
			}
		case pct >= s.quotaWarnPct && prevPct < s.quotaWarnPct:
			if err := s.email.SendQuotaWarning(ctx, user, pct, usedFmt, quotaFmt); err != nil {
				log.Printf("finalize upload: send quota-warning email for %q: %v", sess.Username, err)
			}
		}
	}

	// Kick off background 480p transcoding for video files.
	if strings.HasPrefix(mimeType, "video/") && s.transcode != nil && s.transcode.Available() {
		go s.createVariant(file, sess.Username)
	}

	// Probe capture date in the background for media files.
	if isMediaMime(mimeType) {
		go s.extractTakenAtAsync(file, sess.Username)
	}

	return file, nil
}

// ── Sentinel errors ───────────────────────────────────────────────────────────

var ErrQuotaExceeded = errors.New("storage quota exceeded")
var ErrNotFound = errors.New("file not found")
var ErrDuplicateName = errors.New("a file with that name already exists in this folder")
