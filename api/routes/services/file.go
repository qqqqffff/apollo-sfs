package services

import (
	"bytes"
	"context"
	"database/sql"
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

// FileService handles encrypted file upload, download, metadata retrieval,
// rename, and deletion. All blobs are AES-256-GCM encrypted before being
// written to MinIO; plaintext never leaves the service boundary.
type FileService struct {
	queries      *db.Queries
	storage      *MinIOService
	enc          *EncryptionService
	email        *EmailService
	transcode    *TranscodeService
	quotaWarnPct int

	userCacheMu sync.RWMutex
	userCache   map[string]cachedUser

	raMu       sync.Mutex
	raCache    map[raKey]*raEntry
	raInflight map[raKey]struct{} // keys with an active prefetch goroutine
}

// NewFileService constructs a FileService.
func NewFileService(q *db.Queries, storage *MinIOService, enc *EncryptionService, email *EmailService, transcode *TranscodeService, cfg FileServiceConfig) *FileService {
	return &FileService{
		queries:      q,
		storage:      storage,
		enc:          enc,
		email:        email,
		transcode:    transcode,
		quotaWarnPct: cfg.QuotaWarnPct,
		userCache:    make(map[string]cachedUser),
		raCache:      make(map[raKey]*raEntry),
		raInflight:   make(map[raKey]struct{}),
	}
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

	// 2. Detect MIME type from actual content; fall back to client-provided hint.
	mimeType := in.MimeType
	if detected := mimetype.Detect(plaintext); detected != nil {
		mimeType = detected.String()
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

	// 6. Stream ciphertext to MinIO. Object key: {userID}/{fileID}.
	fileID := uuid.New()
	objectKey := objectKeyFor(in.UserID, fileID)

	if err := s.storage.PutObject(
		ctx, objectKey,
		bytes.NewReader(ciphertext), int64(len(ciphertext)),
		"application/octet-stream",
	); err != nil {
		return nil, fmt.Errorf("upload: store: %w", err)
	}

	// 7. Insert file metadata into DB.
	file, err := s.queries.CreateFile(ctx, &models.File{
		ID:             fileID,
		UserID:         in.UserID,
		FolderID:       in.FolderID,
		Name:           in.Name,
		MimeType:       mimeType,
		SizeBytes:      fileSize,
		MinIOObjectKey: objectKey,
		Nonce:          nonce,
	})
	if err != nil {
		// Best-effort cleanup: delete the orphaned MinIO object.
		_ = s.storage.RemoveObject(ctx, objectKey)
		var pqErr *pq.Error
		if errors.As(err, &pqErr) && pqErr.Code == "23505" {
			return nil, ErrDuplicateName
		}
		return nil, fmt.Errorf("upload: save metadata: %w", err)
	}

	// 8. Update the user's running storage total.
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

	return file, nil
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
	file, err := s.queries.GetFileByID(ctx, fileID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("get metadata: %w", err)
	}
	if file.UserID != userID {
		return nil, ErrNotFound // unified 404 — never reveal foreign files
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
	if _, err := s.GetMetadata(ctx, fileID, userID); err != nil {
		return nil, err
	}
	updated, err := s.queries.UpdateFileName(ctx, fileID, name)
	if err != nil {
		return nil, fmt.Errorf("rename: %w", err)
	}
	return updated, nil
}

// Move transfers a file to a different folder owned by the same user.
// Returns ErrNotFound if the file does not belong to userID.
// Returns ErrFolderNotFound if the target folder does not belong to userID.
func (s *FileService) Move(ctx context.Context, fileID, userID, newFolderID uuid.UUID) (*models.File, error) {
	file, err := s.GetMetadata(ctx, fileID, userID)
	if err != nil {
		return nil, err
	}
	if file.FolderID != nil && *file.FolderID == newFolderID {
		return file, nil
	}
	folder, err := s.queries.GetFolderByID(ctx, newFolderID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrFolderNotFound
		}
		return nil, fmt.Errorf("move: get target folder: %w", err)
	}
	if folder.UserID != userID {
		return nil, ErrFolderNotFound
	}
	moved, err := s.queries.MoveFile(ctx, fileID, newFolderID)
	if err != nil {
		return nil, fmt.Errorf("move: %w", err)
	}
	return moved, nil
}

// Delete removes the encrypted blob from MinIO, deletes the metadata row, and
// decrements the user's storage counter. Any video variant blobs are also
// removed from MinIO (DB rows are cascade-deleted with the parent file row).
// Returns ErrNotFound if the file does not belong to userID.
func (s *FileService) Delete(ctx context.Context, fileID, userID uuid.UUID, username string) error {
	file, err := s.GetMetadata(ctx, fileID, userID)
	if err != nil {
		return err
	}

	// Best-effort: remove any transcoded variant blobs before the parent row is deleted.
	if variants, err := s.queries.ListVideoVariants(ctx, fileID); err == nil {
		for _, v := range variants {
			_ = s.storage.RemoveObject(ctx, v.MinIOObjectKey)
		}
	}

	if err := s.storage.RemoveObject(ctx, file.MinIOObjectKey); err != nil {
		return fmt.Errorf("delete: remove blob: %w", err)
	}
	if err := s.queries.DeleteFile(ctx, fileID); err != nil {
		return fmt.Errorf("delete: remove metadata: %w", err)
	}
	if err := s.queries.AddStorageUsed(ctx, username, -file.SizeBytes); err != nil {
		return fmt.Errorf("delete: update storage: %w", err)
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

	if err := s.storage.PutObject(ctx, variantKey, bytes.NewReader(ciphertext), int64(len(ciphertext)), "application/octet-stream"); err != nil {
		log.Printf("transcode: upload variant for %s: %v", file.ID, err)
		markFailed()
		return
	}

	if err := s.queries.MarkVideoVariantReady(ctx, file.ID, LowQualityLabel, variantPlaintextSize); err != nil {
		log.Printf("transcode: mark ready for %s: %v", file.ID, err)
		_ = s.storage.RemoveObject(ctx, variantKey)
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

	rc, err := s.storage.GetObject(ctx, file.MinIOObjectKey)
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
func (s *FileService) fetchRange(ctx context.Context, file *models.File, username string, rangeStart, rangeEnd int64) ([]byte, error) {
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

	rc, err := s.storage.GetObjectRange(ctx, file.MinIOObjectKey, blobStart, blobEnd)
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
	key := raKey{objectKey: file.MinIOObjectKey, offset: rangeStart}

	if cached, ok := s.raCacheGet(key); ok {
		need := rangeEnd - rangeStart + 1
		if int64(len(cached)) >= need {
			// Prefetch the segment that follows the full cached window, not just rangeEnd.
			s.schedulePrefetch(file, username, rangeStart+int64(len(cached)))
			return cached[:need], nil
		}
		// Cache holds fewer bytes than needed (e.g. near EOF) — fall through.
	}

	data, err := s.fetchRange(ctx, file, username, rangeStart, rangeEnd)
	if err != nil {
		return nil, err
	}
	s.schedulePrefetch(file, username, rangeEnd+1)
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
func (s *FileService) schedulePrefetch(file *models.File, username string, offset int64) {
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
		data, err := s.fetchRange(context.Background(), &fileCopy, username, offset, end)
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

	rc, err := s.storage.GetObject(ctx, file.MinIOObjectKey)
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
	fileID := uuid.New()
	objectKey := objectKeyFor(sess.UserID, fileID)
	uploadID, err := s.storage.CreateMultipartUpload(ctx, objectKey)
	if err != nil {
		zeroBytes(userKey)
		return fmt.Errorf("begin chunked upload: create multipart: %w", err)
	}
	sess.FileID = fileID
	sess.ObjectKey = objectKey
	sess.MinioUploadID = uploadID
	sess.UserKey = userKey
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

	part, err := s.storage.UploadPart(ctx, sess.ObjectKey, sess.MinioUploadID, index+1, ciphertext)
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
		_ = s.storage.AbortMultipartUpload(ctx, sess.ObjectKey, sess.MinioUploadID)
		return nil, fmt.Errorf("finalize: part upload failed: %w", err)
	}

	if err := s.storage.CompleteMultipartUpload(ctx, sess.ObjectKey, sess.MinioUploadID, parts); err != nil {
		_ = s.storage.AbortMultipartUpload(ctx, sess.ObjectKey, sess.MinioUploadID)
		return nil, fmt.Errorf("finalize: complete multipart: %w", err)
	}

	mimeType := sess.MimeType
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	// Read current usage before updating so we can compute threshold crossings below.
	user, userErr := s.queries.GetUserByUsername(ctx, sess.Username)

	file, err := s.queries.CreateFile(ctx, &models.File{
		ID:             sess.FileID,
		UserID:         sess.UserID,
		FolderID:       sess.FolderID,
		Name:           sess.Name,
		MimeType:       mimeType,
		SizeBytes:      sess.TotalSize,
		MinIOObjectKey: sess.ObjectKey,
		Nonce:          []byte{}, // empty nonce signals chunked encryption mode
	})
	if err != nil {
		_ = s.storage.RemoveObject(ctx, sess.ObjectKey)
		var pqErr *pq.Error
		if errors.As(err, &pqErr) && pqErr.Code == "23505" {
			return nil, ErrDuplicateName
		}
		return nil, fmt.Errorf("finalize: save metadata: %w", err)
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

	return file, nil
}

// ── Sentinel errors ───────────────────────────────────────────────────────────

var ErrQuotaExceeded = errors.New("storage quota exceeded")
var ErrNotFound = errors.New("file not found")
var ErrDuplicateName = errors.New("a file with that name already exists in this folder")
