package services

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"

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
	ciphertext, nonce, err := s.enc.EncryptFile(userKey, plaintext)
	if err != nil {
		return nil, fmt.Errorf("upload: encrypt: %w", err)
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

// decryptBlob fetches the ciphertext from MinIO and decrypts it with the user's key.
func (s *FileService) decryptBlob(ctx context.Context, username string, file *models.File) ([]byte, error) {
	user, err := s.queries.GetUserByUsername(ctx, username)
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}

	userKey, err := s.enc.DecryptUserKey(user.EncryptedKey, user.KeyNonce, user.MasterKeyVersion)
	if err != nil {
		return nil, fmt.Errorf("decrypt user key: %w", err)
	}
	defer zeroBytes(userKey)

	// Stream the ciphertext from MinIO.
	rc, err := s.storage.GetObject(ctx, file.MinIOObjectKey)
	if err != nil {
		return nil, fmt.Errorf("fetch blob: %w", err)
	}
	defer rc.Close()

	ciphertext, err := io.ReadAll(rc)
	if err != nil {
		return nil, fmt.Errorf("read blob: %w", err)
	}

	plaintext, err := s.enc.DecryptFile(userKey, file.Nonce, ciphertext)
	if err != nil {
		return nil, fmt.Errorf("decrypt: %w", err)
	}
	return plaintext, nil
}

// objectKeyFor builds the MinIO object key: {userID}/{fileID}.
func objectKeyFor(userID, fileID uuid.UUID) string {
	return userID.String() + "/" + fileID.String()
}

// ── Sentinel errors ───────────────────────────────────────────────────────────

var ErrQuotaExceeded = errors.New("storage quota exceeded")
var ErrNotFound = errors.New("file not found")
var ErrDuplicateName = errors.New("a file with that name already exists in this folder")
