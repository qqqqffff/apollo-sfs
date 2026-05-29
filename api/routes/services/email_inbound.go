package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// workerNameRe constrains a worker name to characters that are safe both as a
// path segment and as an email local-part. Anything outside this set is
// rejected before it can be used to build a filesystem path.
var workerNameRe = regexp.MustCompile(`^[a-z0-9._-]+$`)

// ErrInvalidWorker is returned when a recipient address cannot be reduced to a
// safe worker name (empty local-part, path-traversal characters, etc.).
var ErrInvalidWorker = errors.New("invalid worker name")

// ErrDuplicateEmail is returned by StoreEmail when a message with the same
// Message-ID has already been stored (SendGrid retried delivery).
var ErrDuplicateEmail = errors.New("duplicate email")

// InboundEmailQuerier is the subset of *db.Queries the inbound email service
// uses. Defined here so tests can supply a lightweight stub.
type InboundEmailQuerier interface {
	InsertInboundEmail(ctx context.Context, e *models.InboundEmail) (bool, error)
	ListInboundEmails(ctx context.Context, workerName string, in db.PageInput) (*db.PageResult[models.InboundEmail], error)
	GetInboundEmail(ctx context.Context, id uuid.UUID) (*models.InboundEmail, error)
	MarkInboundEmailRead(ctx context.Context, id uuid.UUID) error
	DeleteInboundEmail(ctx context.Context, id uuid.UUID) error
	ListEmailWorkers(ctx context.Context) ([]models.WorkerSummary, error)
}

var _ InboundEmailQuerier = (*db.Queries)(nil)

// InboundEmailService stores inbound emails as JSON files on disk and maintains
// the queryable index in Postgres. The storage root is laid out as:
//
//	<storageRoot>/<worker_name>/<YYYY-MM>/<id>.json
type InboundEmailService struct {
	q           InboundEmailQuerier
	storageRoot string
}

// NewInboundEmailService creates the service and ensures the storage root
// exists. storageRoot is the absolute path emails are written under
// (EMAIL_STORAGE_PATH).
func NewInboundEmailService(q InboundEmailQuerier, storageRoot string) (*InboundEmailService, error) {
	if storageRoot == "" {
		return nil, fmt.Errorf("inbound email service: storage root is empty")
	}
	if err := os.MkdirAll(storageRoot, 0o750); err != nil {
		return nil, fmt.Errorf("inbound email service: create storage root %q: %w", storageRoot, err)
	}
	return &InboundEmailService{q: q, storageRoot: storageRoot}, nil
}

// WorkerNameFromAddress reduces a recipient address to a sanitized worker name.
// It accepts both bare addresses ("support@x.com") and addresses with a display
// name ("Support <support@x.com>"), lower-cases the local-part, and validates
// it against workerNameRe. Returns ErrInvalidWorker on anything unsafe.
func WorkerNameFromAddress(addr string) (string, error) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "", ErrInvalidWorker
	}
	// A "To" header may list several recipients; use the first parseable one.
	if list, err := mail.ParseAddressList(addr); err == nil && len(list) > 0 {
		addr = list[0].Address
	} else if parsed, err := mail.ParseAddress(addr); err == nil {
		addr = parsed.Address
	}

	local := addr
	if i := strings.LastIndex(addr, "@"); i >= 0 {
		local = addr[:i]
	}
	local = strings.ToLower(strings.TrimSpace(local))

	// Strip "+suffix" sub-addressing so support+ticket42@ maps to "support".
	if i := strings.IndexByte(local, '+'); i >= 0 {
		local = local[:i]
	}

	if local == "" || !workerNameRe.MatchString(local) {
		return "", ErrInvalidWorker
	}
	return local, nil
}

// StoreEmail writes msg to disk under the worker derived from toAddr and inserts
// the index row. On a duplicate Message-ID it removes the just-written file and
// returns ErrDuplicateEmail. On success it returns the stored index row.
func (s *InboundEmailService) StoreEmail(ctx context.Context, toAddr string, msg models.StoredEmail) (*models.InboundEmail, error) {
	worker, err := WorkerNameFromAddress(toAddr)
	if err != nil {
		return nil, err
	}

	id := uuid.New()
	receivedAt := time.Now().UTC()
	if !msg.Date.IsZero() {
		receivedAt = msg.Date.UTC()
	}

	// <root>/<worker>/<YYYY-MM>/<id>.json
	dir := filepath.Join(s.storageRoot, worker, receivedAt.Format("2006-01"))
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("StoreEmail: create dir %q: %w", dir, err)
	}
	filePath := filepath.Join(dir, id.String()+".json")

	// Defense in depth: the resolved path must stay inside the storage root.
	if !s.withinRoot(filePath) {
		return nil, ErrInvalidWorker
	}

	raw, err := json.MarshalIndent(msg, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("StoreEmail: marshal message: %w", err)
	}
	if err := os.WriteFile(filePath, raw, 0o640); err != nil {
		return nil, fmt.Errorf("StoreEmail: write %q: %w", filePath, err)
	}

	row := &models.InboundEmail{
		ID:             id,
		WorkerName:     worker,
		FromAddr:       msg.From,
		ToAddr:         toAddr,
		Subject:        msg.Subject,
		FilePath:       filePath,
		HasAttachments: len(msg.Attachments) > 0,
		ReceivedAt:     receivedAt,
	}
	if mid := strings.TrimSpace(msg.MessageID); mid != "" {
		row.MessageID = &mid
	}

	inserted, err := s.q.InsertInboundEmail(ctx, row)
	if err != nil {
		_ = os.Remove(filePath)
		return nil, err
	}
	if !inserted {
		// A row with this Message-ID already exists — discard the new file.
		_ = os.Remove(filePath)
		return nil, ErrDuplicateEmail
	}
	return row, nil
}

// ListWorkers returns the worker mailboxes with their total/unread counts.
func (s *InboundEmailService) ListWorkers(ctx context.Context) ([]models.WorkerSummary, error) {
	workers, err := s.q.ListEmailWorkers(ctx)
	if err != nil {
		return nil, err
	}
	if workers == nil {
		workers = []models.WorkerSummary{}
	}
	return workers, nil
}

// ListEmails returns a page of index rows, optionally scoped to one worker.
func (s *InboundEmailService) ListEmails(ctx context.Context, worker string, in db.PageInput) (*db.PageResult[models.InboundEmail], error) {
	if worker != "" {
		sanitized, err := WorkerNameFromAddress(worker + "@local")
		if err != nil {
			return nil, ErrInvalidWorker
		}
		worker = sanitized
	}
	return s.q.ListInboundEmails(ctx, worker, in)
}

// GetEmail loads the index row and reads the backing JSON file from disk.
// Returns sql.ErrNoRows when the id is unknown.
func (s *InboundEmailService) GetEmail(ctx context.Context, id uuid.UUID) (*models.EmailDetail, error) {
	row, err := s.q.GetInboundEmail(ctx, id)
	if err != nil {
		return nil, err
	}

	var msg models.StoredEmail
	raw, err := os.ReadFile(row.FilePath)
	if err != nil {
		// The index row exists but the file is gone — surface as a read error
		// rather than masquerading as "not found".
		return nil, fmt.Errorf("GetEmail: read %q: %w", row.FilePath, err)
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return nil, fmt.Errorf("GetEmail: unmarshal %q: %w", row.FilePath, err)
	}

	return &models.EmailDetail{InboundEmail: *row, Message: msg}, nil
}

// MarkRead flags a message as read.
func (s *InboundEmailService) MarkRead(ctx context.Context, id uuid.UUID) error {
	return s.q.MarkInboundEmailRead(ctx, id)
}

// DeleteEmail removes the backing file from disk and then the index row.
// A missing file is not treated as an error so a half-deleted record can be
// cleaned up. Returns sql.ErrNoRows when the id is unknown.
func (s *InboundEmailService) DeleteEmail(ctx context.Context, id uuid.UUID) error {
	row, err := s.q.GetInboundEmail(ctx, id)
	if err != nil {
		return err
	}
	if err := os.Remove(row.FilePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("DeleteEmail: remove %q: %w", row.FilePath, err)
	}
	return s.q.DeleteInboundEmail(ctx, id)
}

// withinRoot reports whether path resolves to a location inside the storage
// root, guarding against path traversal via a crafted worker name.
func (s *InboundEmailService) withinRoot(path string) bool {
	root, err := filepath.Abs(s.storageRoot)
	if err != nil {
		return false
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
