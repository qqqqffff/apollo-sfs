package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/sanitize"
)

// ErrInvalidEmailAddress is returned when the backup target address cannot be
// parsed as a plain email address.
var ErrInvalidEmailAddress = errors.New("invalid email address")

// ErrInvalidEmailProvider is returned for providers other than gmail/microsoft.
var ErrInvalidEmailProvider = errors.New("provider must be gmail or microsoft")

// ErrNotEmailBackupFolder is returned when a folder id passed to the email
// backup endpoints resolves to a folder that is not kind 'email'.
var ErrNotEmailBackupFolder = errors.New("folder is not an email backup folder")

// ErrDuplicateEmailBackup is returned when a provider message has already been
// backed up into the target folder.
var ErrDuplicateEmailBackup = errors.New("email already backed up")

// ErrEmailBackupMessageNotFound is returned when a message id is unknown or
// not owned by the caller.
var ErrEmailBackupMessageNotFound = errors.New("email backup message not found")

// emailBackupFileStore is the subset of *FileService the email backup service
// uses. Defined here so tests can supply a lightweight stub.
type emailBackupFileStore interface {
	Upload(ctx context.Context, in UploadInput) (*models.File, error)
	Download(ctx context.Context, fileID, userID uuid.UUID, username string) (*models.File, []byte, error)
	Delete(ctx context.Context, fileID, userID uuid.UUID, username string) error
}

var _ emailBackupFileStore = (*FileService)(nil)

// emailBackupFolderCreator is the subset of *FolderService the email backup
// service uses.
type emailBackupFolderCreator interface {
	Create(ctx context.Context, userID uuid.UUID, parentID *uuid.UUID, name, kind, username string, driveID *uuid.UUID) (*models.Folder, error)
}

var _ emailBackupFolderCreator = (*FolderService)(nil)

// EmailBackupService backs the user-facing email backup feature. Message
// bodies are stored as regular encrypted files (StoredEmail JSON) through the
// normal upload path — so per-drive quota enforcement and tier routing apply —
// while the email_backup_messages table is the queryable index that renders
// the viewer without decrypting anything.
type EmailBackupService struct {
	queries *db.Queries
	files   emailBackupFileStore
	folders emailBackupFolderCreator
}

// NewEmailBackupService constructs an EmailBackupService.
func NewEmailBackupService(q *db.Queries, files emailBackupFileStore, folders emailBackupFolderCreator) *EmailBackupService {
	return &EmailBackupService{queries: q, files: files, folders: folders}
}

// NormalizeEmailAddress validates and canonicalizes a backup target address:
// parses it (display names tolerated), lower-cases it, and rejects anything
// that isn't a bare user@domain. The result is used as the backup folder name.
func NormalizeEmailAddress(addr string) (string, error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "", ErrInvalidEmailAddress
	}
	parsed, err := mail.ParseAddress(addr)
	if err != nil {
		return "", ErrInvalidEmailAddress
	}
	out := strings.ToLower(parsed.Address)
	if !strings.Contains(out, "@") || len(out) > 254 {
		return "", ErrInvalidEmailAddress
	}
	return out, nil
}

func validEmailBackupProvider(p string) bool {
	return p == models.EmailBackupProviderGmail || p == models.EmailBackupProviderMicrosoft
}

// EnsureFolder returns the user's root-level backup folder for emailAddress,
// creating it (kind 'email', name = the address, uploads pinned to driveID)
// when it doesn't exist yet. An existing folder keeps its current drive pin —
// re-running a backup never silently migrates old mail to a new tier.
// created reports whether a new folder was made.
func (s *EmailBackupService) EnsureFolder(ctx context.Context, userID uuid.UUID, username, emailAddress string, driveID *uuid.UUID) (folder *models.Folder, created bool, err error) {
	addr, err := NormalizeEmailAddress(emailAddress)
	if err != nil {
		return nil, false, err
	}

	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, false, fmt.Errorf("ensure email folder: begin tx: %w", err)
	}
	existing, err := q.GetEmailBackupFolder(ctx, userID, addr)
	_ = tx.Rollback()
	if err == nil {
		return existing, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, false, fmt.Errorf("ensure email folder: %w", err)
	}

	folder, err = s.folders.Create(ctx, userID, nil, addr, models.FolderKindEmail, username, driveID)
	if err != nil {
		return nil, false, err
	}
	return folder, true, nil
}

// EmailBackupMessageInput carries one provider message to back up.
type EmailBackupMessageInput struct {
	Username          string
	UserID            uuid.UUID
	FolderID          uuid.UUID
	Provider          string
	ProviderMessageID string
	Snippet           string
	Starred           bool
	Message           models.StoredEmail
}

// BackupMessage stores one provider message: the StoredEmail body becomes an
// encrypted file in the backup folder (quota/tier enforced by FileService),
// then the index row is inserted. Returns ErrDuplicateEmailBackup when the
// provider message id is already indexed in this folder, ErrQuotaExceeded /
// ErrDriveUnavailable straight from the upload path.
func (s *EmailBackupService) BackupMessage(ctx context.Context, in EmailBackupMessageInput) (*models.EmailBackupMessage, error) {
	if !validEmailBackupProvider(in.Provider) {
		return nil, ErrInvalidEmailProvider
	}
	if strings.TrimSpace(in.ProviderMessageID) == "" {
		return nil, errors.New("provider message id is required")
	}

	folder, err := s.getOwnedEmailFolder(ctx, in.FolderID, in.UserID)
	if err != nil {
		return nil, err
	}

	// Skip the blob upload entirely when this message is already backed up.
	q, tx, err := s.queries.ForUser(ctx, in.UserID)
	if err != nil {
		return nil, fmt.Errorf("backup message: begin tx: %w", err)
	}
	exists, err := q.ExistsEmailBackupMessage(ctx, folder.ID, in.ProviderMessageID)
	_ = tx.Rollback()
	if err != nil {
		return nil, fmt.Errorf("backup message: dedupe check: %w", err)
	}
	if exists {
		return nil, ErrDuplicateEmailBackup
	}

	receivedAt := in.Message.Date
	if receivedAt.IsZero() {
		receivedAt = time.Now().UTC()
	}

	raw, err := json.MarshalIndent(in.Message, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("backup message: marshal: %w", err)
	}

	file, err := s.files.Upload(ctx, UploadInput{
		Username:       in.Username,
		UserID:         in.UserID,
		FolderID:       &folder.ID,
		Name:           emailBackupFileName(in.Message.Subject, in.ProviderMessageID, receivedAt),
		MimeType:       "application/json",
		Source:         "email_backup_" + in.Provider,
		IgnoreRedirect: true,
		Reader:         bytes.NewReader(raw),
	})
	if err != nil {
		return nil, err
	}

	row := &models.EmailBackupMessage{
		ID:                uuid.New(),
		UserID:            in.UserID,
		FolderID:          folder.ID,
		FileID:            file.ID,
		Provider:          in.Provider,
		ProviderMessageID: in.ProviderMessageID,
		FromAddr:          bareEmailAddress(in.Message.From),
		ToAddr:            bareEmailAddress(in.Message.To),
		Subject:           in.Message.Subject,
		Snippet:           truncateRunes(in.Snippet, 300),
		HasAttachments:    len(in.Message.Attachments) > 0,
		Starred:           in.Starred,
		ReceivedAt:        receivedAt,
		FileName:          file.Name,
		FileSizeBytes:     file.SizeBytes,
	}

	q, tx, err = s.queries.ForUser(ctx, in.UserID)
	if err != nil {
		return nil, fmt.Errorf("backup message: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	inserted, err := q.InsertEmailBackupMessage(ctx, row)
	if err == nil && inserted {
		err = tx.Commit()
	}
	if err != nil {
		// The blob made it up but the index didn't — remove the orphan file.
		_ = s.files.Delete(ctx, file.ID, in.UserID, in.Username)
		return nil, fmt.Errorf("backup message: index insert: %w", err)
	}
	if !inserted {
		// Lost a race with a concurrent backup of the same message.
		_ = s.files.Delete(ctx, file.ID, in.UserID, in.Username)
		return nil, ErrDuplicateEmailBackup
	}
	return row, nil
}

// ListSenders returns the folder's distinct senders with total/unread counts.
func (s *EmailBackupService) ListSenders(ctx context.Context, folderID, userID uuid.UUID) ([]models.EmailBackupSenderSummary, error) {
	if _, err := s.getOwnedEmailFolder(ctx, folderID, userID); err != nil {
		return nil, err
	}
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list senders: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	senders, err := q.ListEmailBackupSenders(ctx, folderID)
	if err != nil {
		return nil, err
	}
	if senders == nil {
		senders = []models.EmailBackupSenderSummary{}
	}
	return senders, nil
}

// ListMessages returns a page of index rows for the folder, optionally scoped
// to one sender address, newest first.
func (s *EmailBackupService) ListMessages(ctx context.Context, folderID, userID uuid.UUID, fromAddr string, in db.PageInput) (*db.PageResult[models.EmailBackupMessage], error) {
	if _, err := s.getOwnedEmailFolder(ctx, folderID, userID); err != nil {
		return nil, err
	}
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list messages: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	return q.ListEmailBackupMessages(ctx, folderID, strings.TrimSpace(fromAddr), in)
}

// GetMessage loads the index row and decrypts the backing file into the full
// message detail. Returns ErrEmailBackupMessageNotFound for unknown/foreign ids.
func (s *EmailBackupService) GetMessage(ctx context.Context, id, userID uuid.UUID, username string) (*models.EmailBackupMessageDetail, error) {
	row, err := s.getOwnedMessage(ctx, id, userID)
	if err != nil {
		return nil, err
	}

	_, plaintext, err := s.files.Download(ctx, row.FileID, userID, username)
	if err != nil {
		return nil, fmt.Errorf("get message %s: download: %w", id, err)
	}
	var msg models.StoredEmail
	if err := json.Unmarshal(plaintext, &msg); err != nil {
		return nil, fmt.Errorf("get message %s: unmarshal: %w", id, err)
	}
	return &models.EmailBackupMessageDetail{EmailBackupMessage: *row, Message: msg}, nil
}

// MarkRead flags a message as read inside the viewer.
func (s *EmailBackupService) MarkRead(ctx context.Context, id, userID uuid.UUID) error {
	if _, err := s.getOwnedMessage(ctx, id, userID); err != nil {
		return err
	}
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("mark read: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := q.MarkEmailBackupMessageRead(ctx, id); err != nil {
		return err
	}
	return tx.Commit()
}

// DeleteMessage removes the backing encrypted file (freeing quota) and the
// index row (the FK cascade also covers the row if the file goes first).
func (s *EmailBackupService) DeleteMessage(ctx context.Context, id, userID uuid.UUID, username string) error {
	row, err := s.getOwnedMessage(ctx, id, userID)
	if err != nil {
		return err
	}
	if err := s.files.Delete(ctx, row.FileID, userID, username); err != nil {
		return fmt.Errorf("delete message %s: delete file: %w", id, err)
	}
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("delete message: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := q.DeleteEmailBackupMessage(ctx, id); err != nil {
		return err
	}
	return tx.Commit()
}

// CompleteRunInput records the outcome of one finished backup run.
type CompleteRunInput struct {
	Username     string
	UserID       uuid.UUID
	FolderID     *uuid.UUID
	EmailAddress string
	Provider     string
	Uploaded     int
	Duplicates   int
	Errors       int
	Notify       bool
}

// CompleteRun logs a finished backup run. Runs with Notify = true surface in
// the notification bell until dismissed or aged out.
func (s *EmailBackupService) CompleteRun(ctx context.Context, in CompleteRunInput) (*models.EmailBackupRun, error) {
	if !validEmailBackupProvider(in.Provider) {
		return nil, ErrInvalidEmailProvider
	}
	addr, err := NormalizeEmailAddress(in.EmailAddress)
	if err != nil {
		return nil, err
	}
	run := &models.EmailBackupRun{
		ID:           uuid.New(),
		Username:     in.Username,
		UserID:       in.UserID,
		FolderID:     in.FolderID,
		EmailAddress: addr,
		Provider:     in.Provider,
		Uploaded:     max(in.Uploaded, 0),
		Duplicates:   max(in.Duplicates, 0),
		Errors:       max(in.Errors, 0),
		Notify:       in.Notify,
		CompletedAt:  time.Now().UTC(),
	}
	if err := s.queries.InsertEmailBackupRun(ctx, run); err != nil {
		return nil, err
	}
	return run, nil
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// getOwnedEmailFolder loads folderID under the caller's RLS context and
// verifies it is an email backup folder. Returns ErrFolderNotFound /
// ErrNotEmailBackupFolder accordingly.
func (s *EmailBackupService) getOwnedEmailFolder(ctx context.Context, folderID, userID uuid.UUID) (*models.Folder, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get email folder: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	folder, err := q.GetFolderByID(ctx, folderID)
	if err != nil || folder == nil || folder.UserID != userID {
		return nil, ErrFolderNotFound
	}
	if folder.Kind != models.FolderKindEmail {
		return nil, ErrNotEmailBackupFolder
	}
	return folder, nil
}

// getOwnedMessage loads a message index row under the caller's RLS context.
func (s *EmailBackupService) getOwnedMessage(ctx context.Context, id, userID uuid.UUID) (*models.EmailBackupMessage, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get message: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	row, err := q.GetEmailBackupMessage(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrEmailBackupMessageNotFound
		}
		return nil, err
	}
	if row.UserID != userID {
		return nil, ErrEmailBackupMessageNotFound
	}
	return row, nil
}

// emailBackupFileName builds the display filename for a backed-up message:
// "<date> <subject> [<id-hash>].email.json". The short provider-message-id
// hash keeps sibling names unique (the files table enforces uniqueness per
// folder) even for identical subjects on the same day.
func emailBackupFileName(subject, providerMessageID string, receivedAt time.Time) string {
	base := sanitize.Name(subject, 120)
	if base == "" {
		base = "(no subject)"
	}
	sum := sha256.Sum256([]byte(providerMessageID))
	return fmt.Sprintf("%s %s [%s].email.json",
		receivedAt.UTC().Format("2006-01-02"), base, hex.EncodeToString(sum[:4]))
}

// bareEmailAddress reduces a header value like `Jane Doe <jane@x.com>` to the
// lower-cased bare address for grouping in the sender sidebar. Unparseable
// values are returned trimmed as-is so nothing is dropped.
func bareEmailAddress(header string) string {
	header = strings.TrimSpace(header)
	if header == "" {
		return ""
	}
	if list, err := mail.ParseAddressList(header); err == nil && len(list) > 0 {
		return strings.ToLower(list[0].Address)
	}
	if parsed, err := mail.ParseAddress(header); err == nil {
		return strings.ToLower(parsed.Address)
	}
	return strings.ToLower(header)
}

// truncateRunes caps s at n Unicode code points.
func truncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}
