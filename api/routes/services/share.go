package services

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net/mail"
	"strings"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// ── Types ─────────────────────────────────────────────────────────────────────

// CreateShareInput carries the owner's request to share a file or folder.
// Exactly one of FileID / FolderID must be set.
type CreateShareInput struct {
	FileID         *uuid.UUID
	FolderID       *uuid.UUID
	RecipientEmail string
	// CanDownload — file shares: sharee may download; folder shares: sharee may
	// download contained files.
	CanDownload bool
	// CanUpload — folder shares only: sharee may upload into the folder.
	CanUpload bool
	// IncludeChildren — folder shares only: share the whole subtree.
	IncludeChildren bool
	// Notify — send the recipient an email with the share link.
	Notify bool
}

// ShareInfo is a Share enriched with the shared object's display metadata and
// the full share URL. Returned by the list/resolve endpoints so clients render
// names without extra round-trips.
type ShareInfo struct {
	models.Share
	ItemType      string `json:"item_type"` // "file" | "folder"
	ItemName      string `json:"item_name"`
	ItemSizeBytes int64  `json:"item_size_bytes"`
	ItemMimeType  string `json:"item_mime_type,omitempty"`
	// OwnerEmail is populated on recipient-facing listings so the sharee can see
	// who shared the item.
	OwnerEmail string `json:"owner_email,omitempty"`
	ShareURL   string `json:"share_url"`
}

// ── Service ───────────────────────────────────────────────────────────────────

// ShareService implements user-to-user sharing of files and folders.
//
// Access model: a share is validated at this layer (active, recipient email
// matches the logged-in account), after which the underlying file/folder reads
// run inside ForUser(owner) transactions — exactly like the presigned-download
// path — so the RLS policies on files/folders remain the only DB-level
// authority on row visibility.
type ShareService struct {
	queries *db.Queries
	email   *EmailService
	appURL  string
}

// NewShareService constructs a ShareService. emailSvc may be nil in tests;
// notification emails are then skipped.
func NewShareService(q *db.Queries, emailSvc *EmailService, appURL string) *ShareService {
	return &ShareService{queries: q, email: emailSvc, appURL: strings.TrimRight(appURL, "/")}
}

// ── Owner operations ──────────────────────────────────────────────────────────

// Create validates ownership of the target object, inserts the share, and
// (optionally) enqueues the notification email. ownerID/ownerUsername are the
// authenticated caller's Keycloak subject UUID and preferred_username.
func (s *ShareService) Create(ctx context.Context, ownerID uuid.UUID, ownerUsername string, in CreateShareInput) (*ShareInfo, error) {
	if (in.FileID == nil) == (in.FolderID == nil) {
		return nil, ErrShareTarget
	}

	email, err := normalizeEmail(in.RecipientEmail)
	if err != nil {
		return nil, ErrShareBadEmail
	}

	owner, err := s.queries.GetUserByUsername(ctx, ownerUsername)
	if err != nil {
		return nil, fmt.Errorf("create share: get owner: %w", err)
	}
	if strings.EqualFold(owner.Email, email) {
		return nil, ErrShareSelf
	}

	// Verify the target exists and belongs to the caller under RLS, and capture
	// its display metadata for the response.
	info := ShareInfo{ShareURL: ""}
	q, tx, err := s.queries.ForUser(ctx, ownerID)
	if err != nil {
		return nil, fmt.Errorf("create share: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if in.FileID != nil {
		file, err := q.GetFileByID(ctx, *in.FileID)
		if err != nil || file.UserID != ownerID {
			return nil, ErrNotFound
		}
		// File shares carry no folder semantics.
		in.CanUpload = false
		in.IncludeChildren = false
		info.ItemType = "file"
		info.ItemName = file.Name
		info.ItemSizeBytes = file.SizeBytes
		info.ItemMimeType = file.MimeType
	} else {
		folder, err := q.GetFolderByID(ctx, *in.FolderID)
		if err != nil || folder.UserID != ownerID {
			return nil, ErrFolderNotFound
		}
		info.ItemType = "folder"
		info.ItemName = folder.Name
	}

	token, err := generateShareToken()
	if err != nil {
		return nil, fmt.Errorf("create share: generate token: %w", err)
	}

	share, err := s.queries.CreateShare(ctx, &models.Share{
		Token:           token,
		OwnerUserID:     ownerID,
		OwnerUsername:   ownerUsername,
		RecipientEmail:  email,
		FileID:          in.FileID,
		FolderID:        in.FolderID,
		CanDownload:     in.CanDownload,
		CanUpload:       in.CanUpload,
		IncludeChildren: in.IncludeChildren,
	})
	if err != nil {
		if isDuplicateKeyError(err) {
			return nil, ErrShareExists
		}
		return nil, fmt.Errorf("create share: %w", err)
	}

	info.Share = *share
	info.ShareURL = s.shareURL(share.Token)

	if in.Notify && s.email != nil {
		if err := s.email.SendShareNotification(
			ctx, email, owner.Email, info.ItemName, info.ItemType,
			permissionLabel(share), info.ShareURL,
		); err != nil {
			// The share itself succeeded — surfacing an email-queue failure as a
			// request failure would leave the owner believing nothing was shared.
			log.Printf("share %s: enqueue notification to %s: %v", share.ID, email, err)
		}
	}

	return &info, nil
}

// ListByOwner returns the caller's active shares enriched with item metadata.
func (s *ShareService) ListByOwner(ctx context.Context, ownerID uuid.UUID) ([]ShareInfo, error) {
	shares, err := s.queries.ListSharesByOwner(ctx, ownerID)
	if err != nil {
		return nil, err
	}
	return s.enrich(ctx, shares, false)
}

// ListForRecipient returns the active shares addressed to the calling user's
// account email, enriched with item metadata and the owner's email.
func (s *ShareService) ListForRecipient(ctx context.Context, username string) ([]ShareInfo, error) {
	user, err := s.queries.GetUserByUsername(ctx, username)
	if err != nil {
		return nil, fmt.Errorf("list shared-with-me: get user: %w", err)
	}
	shares, err := s.queries.ListSharesForRecipient(ctx, strings.ToLower(user.Email))
	if err != nil {
		return nil, err
	}
	return s.enrich(ctx, shares, true)
}

// Revoke soft-deletes an active share owned by ownerID.
func (s *ShareService) Revoke(ctx context.Context, shareID, ownerID uuid.UUID) error {
	if err := s.queries.RevokeShare(ctx, shareID, ownerID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrShareNotFound
		}
		return err
	}
	return nil
}

// ── Recipient operations ──────────────────────────────────────────────────────

// ResolveToken looks up an active share by link token and authorizes the
// caller as its recipient (or owner). This is the "prove you are the one the
// object was shared with" step: the caller must be logged in to an account
// whose email matches the share's recipient_email.
func (s *ShareService) ResolveToken(ctx context.Context, token string, callerID uuid.UUID, callerUsername string) (*ShareInfo, error) {
	share, err := s.queries.GetShareByToken(ctx, token)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrShareNotFound
		}
		return nil, err
	}
	return s.authorizeAndEnrich(ctx, share, callerID, callerUsername)
}

// GetInfo loads an active share by ID for its recipient or owner, enriched
// with item metadata. Backs the share view page.
func (s *ShareService) GetInfo(ctx context.Context, shareID, callerID uuid.UUID, callerUsername string) (*ShareInfo, error) {
	share, err := s.queries.GetShareByID(ctx, shareID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrShareNotFound
		}
		return nil, err
	}
	return s.authorizeAndEnrich(ctx, share, callerID, callerUsername)
}

// Authorize loads an active share by ID and verifies the caller is its
// recipient or owner. Used by every shared-content endpoint.
func (s *ShareService) Authorize(ctx context.Context, shareID, callerID uuid.UUID, callerUsername string) (*models.Share, error) {
	share, err := s.queries.GetShareByID(ctx, shareID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrShareNotFound
		}
		return nil, err
	}
	if err := s.authorize(ctx, share, callerID, callerUsername); err != nil {
		return nil, err
	}
	return share, nil
}

// FileForShare resolves which file a shared-file request refers to and
// verifies it falls inside the share's scope. For file shares fileID must be
// nil or equal to the shared file. For folder shares fileID is required and
// must live in the shared folder — or anywhere in its subtree when
// include_children is set. The returned metadata is read under ForUser(owner).
func (s *ShareService) FileForShare(ctx context.Context, share *models.Share, fileID *uuid.UUID) (*models.File, error) {
	q, tx, err := s.queries.ForUser(ctx, share.OwnerUserID)
	if err != nil {
		return nil, fmt.Errorf("share file: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if share.FileID != nil {
		if fileID != nil && *fileID != *share.FileID {
			return nil, ErrNotFound
		}
		file, err := q.GetFileByID(ctx, *share.FileID)
		if err != nil {
			return nil, ErrNotFound
		}
		return file, nil
	}

	if fileID == nil {
		return nil, ErrNotFound
	}
	file, err := q.GetFileByID(ctx, *fileID)
	if err != nil {
		return nil, ErrNotFound
	}
	if file.FolderID == nil {
		return nil, ErrNotFound
	}
	if err := s.folderInScope(ctx, q, share, *file.FolderID); err != nil {
		return nil, err
	}
	return file, nil
}

// ContentsForShare lists a shared folder's children for the sharee.
// subfolderID nil targets the shared folder itself; non-nil targets a
// descendant (allowed only when include_children is set). Subfolders are
// listed only when include_children — without it the share covers just the
// folder's direct files.
func (s *ShareService) ContentsForShare(
	ctx context.Context,
	share *models.Share,
	subfolderID *uuid.UUID,
	folderPage, filePage db.PageInput,
) (*FolderContents, error) {
	if share.FolderID == nil {
		return nil, ErrFolderNotFound
	}

	q, tx, err := s.queries.ForUser(ctx, share.OwnerUserID)
	if err != nil {
		return nil, fmt.Errorf("share contents: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	target := *share.FolderID
	if subfolderID != nil && *subfolderID != target {
		if err := s.folderInScope(ctx, q, share, *subfolderID); err != nil {
			return nil, err
		}
		target = *subfolderID
	}

	folder, err := q.GetFolderByID(ctx, target)
	if err != nil {
		return nil, ErrFolderNotFound
	}

	var subfolders *db.PageResult[models.Folder]
	if !share.IncludeChildren || folderPage.Skip {
		subfolders = emptyFolders()
	} else {
		subfolders, err = q.ListFoldersByParent(ctx, share.OwnerUserID, target, folderPage)
		if err != nil {
			return nil, fmt.Errorf("share contents: subfolders: %w", err)
		}
	}

	var files *db.PageResult[models.File]
	if filePage.Skip {
		files = emptyFiles()
	} else {
		files, err = q.ListFilesByFolder(ctx, target, filePage)
		if err != nil {
			return nil, fmt.Errorf("share contents: files: %w", err)
		}
	}

	return &FolderContents{Folder: folder, Subfolders: subfolders, Files: files}, nil
}

// UploadTargetForShare validates that the sharee may upload through this share
// and returns the destination folder ID. folderID nil targets the shared
// folder; a descendant is allowed only when include_children is set.
func (s *ShareService) UploadTargetForShare(ctx context.Context, share *models.Share, folderID *uuid.UUID) (uuid.UUID, error) {
	if share.FolderID == nil || !share.CanUpload {
		return uuid.Nil, ErrShareForbidden
	}
	target := *share.FolderID
	if folderID != nil && *folderID != target {
		q, tx, err := s.queries.ForUser(ctx, share.OwnerUserID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("share upload target: begin tx: %w", err)
		}
		defer func() { _ = tx.Rollback() }()
		if err := s.folderInScope(ctx, q, share, *folderID); err != nil {
			return uuid.Nil, err
		}
		target = *folderID
	}
	return target, nil
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// authorize returns nil when the caller is the share's owner or its recipient
// (matched by account email, case-insensitively) and the share is active.
func (s *ShareService) authorize(ctx context.Context, share *models.Share, callerID uuid.UUID, callerUsername string) error {
	if share.RevokedAt != nil {
		return ErrShareNotFound
	}
	if callerID == share.OwnerUserID {
		return nil
	}
	caller, err := s.queries.GetUserByUsername(ctx, callerUsername)
	if err != nil {
		return fmt.Errorf("authorize share: get caller: %w", err)
	}
	if !strings.EqualFold(caller.Email, share.RecipientEmail) {
		return ErrShareForbidden
	}
	return nil
}

func (s *ShareService) authorizeAndEnrich(ctx context.Context, share *models.Share, callerID uuid.UUID, callerUsername string) (*ShareInfo, error) {
	if err := s.authorize(ctx, share, callerID, callerUsername); err != nil {
		return nil, err
	}
	infos, err := s.enrich(ctx, []models.Share{*share}, true)
	if err != nil {
		return nil, err
	}
	if len(infos) == 0 {
		return nil, ErrShareNotFound
	}
	return &infos[0], nil
}

// folderInScope verifies folderID belongs to the share's subtree: equal to the
// shared folder, or a descendant of it when include_children is set. q must be
// a ForUser(owner) transaction so the descendant walk runs under RLS.
func (s *ShareService) folderInScope(ctx context.Context, q *db.Queries, share *models.Share, folderID uuid.UUID) error {
	if folderID == *share.FolderID {
		return nil
	}
	if !share.IncludeChildren {
		return ErrNotFound
	}
	inside, err := q.IsFolderDescendant(ctx, *share.FolderID, folderID)
	if err != nil {
		return fmt.Errorf("share scope check: %w", err)
	}
	if !inside {
		return ErrNotFound
	}
	return nil
}

// enrich attaches item metadata (and, for recipient-facing listings, the owner
// email) to each share. Reads are grouped per owner so each owner's rows are
// fetched inside a single ForUser transaction. Shares whose target row has
// vanished are skipped (FK cascades normally prevent this).
func (s *ShareService) enrich(ctx context.Context, shares []models.Share, includeOwner bool) ([]ShareInfo, error) {
	out := make([]ShareInfo, 0, len(shares))

	byOwner := make(map[uuid.UUID][]models.Share)
	order := make([]uuid.UUID, 0)
	for _, sh := range shares {
		if _, seen := byOwner[sh.OwnerUserID]; !seen {
			order = append(order, sh.OwnerUserID)
		}
		byOwner[sh.OwnerUserID] = append(byOwner[sh.OwnerUserID], sh)
	}

	ownerEmails := make(map[uuid.UUID]string)
	for _, ownerID := range order {
		group := byOwner[ownerID]

		if includeOwner {
			if owner, err := s.queries.GetUserByUsername(ctx, group[0].OwnerUsername); err == nil {
				ownerEmails[ownerID] = owner.Email
			}
		}

		q, tx, err := s.queries.ForUser(ctx, ownerID)
		if err != nil {
			return nil, fmt.Errorf("enrich shares: begin tx: %w", err)
		}
		for _, sh := range group {
			info := ShareInfo{Share: sh, ShareURL: s.shareURL(sh.Token), OwnerEmail: ownerEmails[ownerID]}
			if sh.FileID != nil {
				file, err := q.GetFileByID(ctx, *sh.FileID)
				if err != nil {
					continue
				}
				info.ItemType = "file"
				info.ItemName = file.Name
				info.ItemSizeBytes = file.SizeBytes
				info.ItemMimeType = file.MimeType
			} else if sh.FolderID != nil {
				folder, err := q.GetFolderByID(ctx, *sh.FolderID)
				if err != nil {
					continue
				}
				info.ItemType = "folder"
				info.ItemName = folder.Name
			}
			out = append(out, info)
		}
		_ = tx.Rollback()
	}

	return out, nil
}

func (s *ShareService) shareURL(token string) string {
	return s.appURL + "/share/" + token
}

func normalizeEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	if email == "" {
		return "", errors.New("empty email")
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email {
		return "", errors.New("invalid email")
	}
	return email, nil
}

// permissionLabel renders a human-readable permission summary for email copy.
func permissionLabel(share *models.Share) string {
	if share.FileID != nil {
		if share.CanDownload {
			return "view and download"
		}
		return "view only"
	}
	switch {
	case share.CanUpload && share.CanDownload:
		return "view, upload and download"
	case share.CanDownload:
		return "view and download"
	default:
		return "view only"
	}
}

func generateShareToken() (string, error) {
	b := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// ── Sentinel errors ───────────────────────────────────────────────────────────

// ErrShareNotFound is returned when a share does not exist, is revoked, or is
// not visible to the caller in a context where existence should not leak.
var ErrShareNotFound = errors.New("share not found")

// ErrShareForbidden is returned when a logged-in caller is neither the owner
// nor the recipient of the share (their account email does not match).
var ErrShareForbidden = errors.New("this share was sent to a different account")

// ErrShareExists is returned when the recipient already has an active share of
// the same file or folder.
var ErrShareExists = errors.New("this item is already shared with that person")

// ErrShareTarget is returned when the create request does not target exactly
// one file or folder.
var ErrShareTarget = errors.New("exactly one of file_id or folder_id is required")

// ErrShareBadEmail is returned for a missing or malformed recipient email.
var ErrShareBadEmail = errors.New("a valid recipient email is required")

// ErrShareSelf is returned when the owner tries to share an item with their
// own account email.
var ErrShareSelf = errors.New("you cannot share an item with yourself")

// ErrShareDownloadDisabled is returned when a sharee requests a download on a
// share that only permits viewing.
var ErrShareDownloadDisabled = errors.New("downloads are not permitted for this share")
