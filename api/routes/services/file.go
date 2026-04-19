package services

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/gabriel-vasile/mimetype"
	"github.com/google/uuid"

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
	// FolderID is the target folder.
	FolderID uuid.UUID
	// Name is the display filename stored in the metadata table.
	Name string
	// MimeType is provided by the client. If empty the service detects it from
	// the file contents. Always treat as a hint; server-detected type is preferred.
	MimeType string
	// Reader is the raw plaintext byte stream (multipart file reader).
	// The service reads it fully into memory for AES-GCM encryption.
	// TODO: replace with chunked AES-GCM for large-file streaming support.
	Reader io.Reader
}

// ── Service ───────────────────────────────────────────────────────────────────

// FileService handles encrypted file upload, download, metadata retrieval,
// rename, and deletion. All blobs are AES-256-GCM encrypted before being
// written to MinIO; plaintext never leaves the service boundary.
type FileService struct {
	queries      *db.Queries
	storage      *MinIOService
	enc          *EncryptionService
	quotaWarnPct int
}

// NewFileService constructs a FileService.
func NewFileService(q *db.Queries, storage *MinIOService, enc *EncryptionService, cfg FileServiceConfig) *FileService {
	return &FileService{
		queries:      q,
		storage:      storage,
		enc:          enc,
		quotaWarnPct: cfg.QuotaWarnPct,
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
		return nil, fmt.Errorf("upload: save metadata: %w", err)
	}

	// 8. Update the user's running storage total.
	if err := s.queries.AddStorageUsed(ctx, in.Username, fileSize); err != nil {
		return nil, fmt.Errorf("upload: update storage: %w", err)
	}

	// TODO: check quota warning threshold and enqueue email via EmailService.

	return file, nil
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
	if file.FolderID == newFolderID {
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
// decrements the user's storage counter.
// Returns ErrNotFound if the file does not belong to userID.
func (s *FileService) Delete(ctx context.Context, fileID, userID uuid.UUID, username string) error {
	file, err := s.GetMetadata(ctx, fileID, userID)
	if err != nil {
		return err
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

// DownloadRange fetches only the MinIO chunks covering plaintext [rangeStart, rangeEnd]
// for a chunked-encrypted file and decrypts them concurrently. Only the bytes
// that fall within the requested range are returned, minimising both MinIO
// bandwidth and memory usage for large video files.
func (s *FileService) DownloadRange(ctx context.Context, file *models.File, username string, rangeStart, rangeEnd int64) ([]byte, error) {
	userKey, err := s.userKey(ctx, username)
	if err != nil {
		return nil, fmt.Errorf("download range: %w", err)
	}
	defer zeroBytes(userKey)

	totalSize := file.SizeBytes
	numChunks := (totalSize + int64(ChunkSize) - 1) / int64(ChunkSize)

	firstChunkIdx := rangeStart / int64(ChunkSize)
	lastChunkIdx := rangeEnd / int64(ChunkSize)

	// Byte offset of the first needed chunk's start in the MinIO blob.
	blobStart := firstChunkIdx * int64(StoredChunkSize)

	// Stored size of the last needed chunk (may be smaller for the last file chunk).
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
		return nil, fmt.Errorf("download range: fetch chunk blob: %w", err)
	}
	defer rc.Close()

	blobSlice, err := io.ReadAll(rc)
	if err != nil {
		return nil, fmt.Errorf("download range: read chunk blob: %w", err)
	}

	return s.enc.DecryptChunkedRange(userKey, blobSlice, firstChunkIdx, numChunks, totalSize, rangeStart, rangeEnd)
}

// decryptBlob fetches the ciphertext from MinIO and decrypts it with the user's key.
// Handles both legacy single-blob files and chunked-encrypted files transparently.
func (s *FileService) decryptBlob(ctx context.Context, username string, file *models.File) ([]byte, error) {
	userKey, err := s.userKey(ctx, username)
	if err != nil {
		return nil, fmt.Errorf("decrypt blob: %w", err)
	}
	defer zeroBytes(userKey)

	rc, err := s.storage.GetObject(ctx, file.MinIOObjectKey)
	if err != nil {
		return nil, fmt.Errorf("fetch blob: %w", err)
	}
	defer rc.Close()

	data, err := io.ReadAll(rc)
	if err != nil {
		return nil, fmt.Errorf("read blob: %w", err)
	}

	if IsChunked(file) {
		return s.enc.DecryptChunked(userKey, data)
	}
	return s.enc.DecryptFile(userKey, file.Nonce, data)
}

// userKey is a helper that resolves and unwraps the plaintext AES key for username.
// The caller is responsible for zeroing the returned slice after use.
func (s *FileService) userKey(ctx context.Context, username string) ([]byte, error) {
	user, err := s.queries.GetUserByUsername(ctx, username)
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}
	key, err := s.enc.DecryptUserKey(user.EncryptedKey, user.KeyNonce, user.MasterKeyVersion)
	if err != nil {
		return nil, fmt.Errorf("decrypt user key: %w", err)
	}
	return key, nil
}

// objectKeyFor builds the MinIO object key: {userID}/{fileID}.
func objectKeyFor(userID, fileID uuid.UUID) string {
	return userID.String() + "/" + fileID.String()
}

// ── Sentinel errors ───────────────────────────────────────────────────────────

var ErrQuotaExceeded = errors.New("storage quota exceeded")
var ErrNotFound = errors.New("file not found")
var ErrDuplicateName = errors.New("a file with that name already exists in this folder")
