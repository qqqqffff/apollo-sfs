package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

const (
	// locationVerificationWindow is how long a verified location stays trusted.
	locationVerificationWindow = 30 * 24 * time.Hour
	// locationTokenMaxAge is how long an emailed verification token stays valid.
	locationTokenMaxAge = 24 * time.Hour
	// locationResendCooldown throttles verification emails per (link, IP): a
	// mount client retries rapidly on 403, and each attempt must not spam the
	// owner's inbox.
	locationResendCooldown = 10 * time.Minute
	// davCredentialTTL is how long a successful Basic-auth credential check is
	// cached, so mount clients (which send credentials on every request) don't
	// hit Keycloak's token endpoint per request.
	davCredentialTTL = 5 * time.Minute
)

// Sentinel errors mapped to HTTP statuses by the route handlers.
var (
	ErrLinkNotFound       = errors.New("file server link not found")
	ErrLinkServerNotOwned = errors.New("you have no storage capacity on that server")
	ErrLinkExists         = errors.New("a link already exists for that server")
	ErrLinkBadCredentials = errors.New("invalid credentials")
	ErrLinkNotPremium     = errors.New("premium membership required")
	ErrLocationUnverified = errors.New("location verification required")
)

// FileServerLinkInfo is a link plus its derived mount URL.
type FileServerLinkInfo struct {
	models.FileServerLink
	MountURL string `json:"mount_url"`
}

// FileServerLinkService owns the lifecycle of premium WebDAV mount links and
// the enhanced-security location ledger.
type FileServerLinkService struct {
	queries *db.Queries
	auth    *AuthService
	email   *EmailService
	appURL  string

	mu    sync.Mutex
	creds map[credKey]time.Time // successful Basic-auth checks, keyed by credential hash
}

// credKey is sha256(linkID | username | password) — never the raw password.
type credKey [32]byte

// NewFileServerLinkService wires a FileServerLinkService.
func NewFileServerLinkService(q *db.Queries, auth *AuthService, email *EmailService, appBaseURL string) *FileServerLinkService {
	return &FileServerLinkService{
		queries: q,
		auth:    auth,
		email:   email,
		appURL:  strings.TrimRight(appBaseURL, "/"),
		creds:   make(map[credKey]time.Time),
	}
}

// MountURL builds the public mount URL for a link token.
func (s *FileServerLinkService) MountURL(token string) string {
	return s.appURL + "/dav/" + token
}

func (s *FileServerLinkService) info(l *models.FileServerLink) *FileServerLinkInfo {
	return &FileServerLinkInfo{FileServerLink: *l, MountURL: s.MountURL(l.Token)}
}

// Create issues a mount link for the given server. The server must carry one
// of the user's drive allocations (ErrLinkServerNotOwned otherwise). When a
// link already exists for (user, server) the existing link is returned with
// created = false — the frontend shows it instead of minting a duplicate.
func (s *FileServerLinkService) Create(ctx context.Context, userID uuid.UUID, username string, serverID uuid.UUID, enhancedSecurity bool) (info *FileServerLinkInfo, created bool, err error) {
	drives, err := s.queries.GetUserDrives(ctx, username, userID.String())
	if err != nil {
		return nil, false, fmt.Errorf("create link: %w", err)
	}
	var driveID uuid.UUID
	found := false
	for _, d := range drives {
		if d.ServerID == serverID {
			driveID = d.DriveID
			found = true
			if d.IsPrimary {
				break
			}
		}
	}
	if !found {
		return nil, false, ErrLinkServerNotOwned
	}

	if existing, err := s.queries.GetFileServerLinkByServer(ctx, username, serverID); err == nil {
		return s.info(existing), false, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, false, fmt.Errorf("create link: lookup existing: %w", err)
	}

	token, err := generateURLToken()
	if err != nil {
		return nil, false, fmt.Errorf("create link: token: %w", err)
	}
	link, err := s.queries.CreateFileServerLink(ctx, &models.FileServerLink{
		Token:            token,
		Username:         username,
		UserID:           userID,
		ServerID:         serverID,
		DriveID:          driveID,
		EnhancedSecurity: enhancedSecurity,
	})
	if err != nil {
		// Concurrent create for the same server: surface the winner.
		var pqErr *pq.Error
		if errors.As(err, &pqErr) && pqErr.Code == "23505" {
			if existing, lookupErr := s.queries.GetFileServerLinkByServer(ctx, username, serverID); lookupErr == nil {
				return s.info(existing), false, nil
			}
			return nil, false, ErrLinkExists
		}
		return nil, false, err
	}
	return s.info(link), true, nil
}

// List returns all of the user's links with mount URLs, newest first.
func (s *FileServerLinkService) List(ctx context.Context, username string) ([]FileServerLinkInfo, error) {
	links, err := s.queries.ListFileServerLinks(ctx, username)
	if err != nil {
		return nil, err
	}
	out := make([]FileServerLinkInfo, 0, len(links))
	for i := range links {
		out = append(out, *s.info(&links[i]))
	}
	return out, nil
}

// Delete destroys a link (and, via cascade, its location ledger). The mount
// dies immediately: the next DAV request fails to resolve the token.
func (s *FileServerLinkService) Delete(ctx context.Context, username string, id uuid.UUID) error {
	n, err := s.queries.DeleteFileServerLink(ctx, username, id)
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrLinkNotFound
	}
	return nil
}

// SetEnhancedSecurity toggles enhanced-security mode on an existing link.
func (s *FileServerLinkService) SetEnhancedSecurity(ctx context.Context, username string, id uuid.UUID, enabled bool) error {
	n, err := s.queries.SetFileServerLinkEnhancedSecurity(ctx, username, id, enabled)
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrLinkNotFound
	}
	return nil
}

// ── DAV request-time checks ───────────────────────────────────────────────────

// ResolveToken loads the link for a DAV request. sql.ErrNoRows maps to
// ErrLinkNotFound so deleted links (premium cancellation, manual delete)
// return a clean 404.
func (s *FileServerLinkService) ResolveToken(ctx context.Context, token string) (*models.FileServerLink, error) {
	link, err := s.queries.GetFileServerLinkByToken(ctx, token)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrLinkNotFound
		}
		return nil, err
	}
	return link, nil
}

// Authenticate verifies HTTP Basic credentials against Keycloak (ROPC grant)
// for the link's owner and asserts the account still holds premium. Successful
// checks are cached for davCredentialTTL keyed by a credential hash, since DAV
// clients replay credentials on every request.
func (s *FileServerLinkService) Authenticate(ctx context.Context, link *models.FileServerLink, username, password string) (*models.User, error) {
	// The presented username must be the link owner's login name.
	if !strings.EqualFold(strings.TrimSpace(username), link.Username) {
		return nil, ErrLinkBadCredentials
	}

	user, err := s.queries.GetUserByUsername(ctx, link.Username)
	if err != nil {
		return nil, ErrLinkBadCredentials
	}
	if !(user.IsPremium || user.IsAdmin) {
		return nil, ErrLinkNotPremium
	}

	key := credKeyFor(link.ID, username, password)
	s.mu.Lock()
	exp, ok := s.creds[key]
	s.mu.Unlock()
	if ok && time.Now().Before(exp) {
		return user, nil
	}

	tokens, err := s.auth.Login(ctx, link.Username, password)
	if err != nil {
		return nil, ErrLinkBadCredentials
	}
	claims, err := decodeTokenClaims(tokens.AccessToken)
	if err != nil || claims.Sub != link.UserID.String() {
		return nil, ErrLinkBadCredentials
	}

	s.mu.Lock()
	// Opportunistic sweep so the map can't grow unbounded under churn.
	if len(s.creds) > 1024 {
		now := time.Now()
		for k, e := range s.creds {
			if now.After(e) {
				delete(s.creds, k)
			}
		}
	}
	s.creds[key] = time.Now().Add(davCredentialTTL)
	s.mu.Unlock()
	return user, nil
}

func credKeyFor(linkID uuid.UUID, username, password string) credKey {
	h := sha256.New()
	h.Write(linkID[:])
	h.Write([]byte{0})
	h.Write([]byte(username))
	h.Write([]byte{0})
	h.Write([]byte(password))
	var k credKey
	copy(k[:], h.Sum(nil))
	return k
}

// CheckLocation enforces enhanced-security mode for an upload/download from
// sourceIP. Returns nil when the transfer may proceed. When the location is
// new — or its verification is older than 30 days — a verification email is
// (re)sent, throttled by locationResendCooldown, and ErrLocationUnverified is
// returned.
func (s *FileServerLinkService) CheckLocation(ctx context.Context, link *models.FileServerLink, user *models.User, sourceIP string) error {
	if !link.EnhancedSecurity {
		return nil
	}
	loc, err := s.queries.GetLinkLocation(ctx, link.ID, sourceIP)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("check location: %w", err)
	}
	if loc != nil && loc.VerifiedAt != nil && time.Since(*loc.VerifiedAt) < locationVerificationWindow {
		return nil
	}

	// Unverified (or expired): issue a token and email the owner, unless one
	// was sent recently.
	if loc == nil || loc.VerificationSentAt == nil || time.Since(*loc.VerificationSentAt) > locationResendCooldown {
		token, err := generateURLToken()
		if err != nil {
			return fmt.Errorf("check location: token: %w", err)
		}
		if err := s.queries.UpsertPendingLinkLocation(ctx, link.ID, sourceIP, token); err != nil {
			return err
		}
		if s.email != nil {
			verifyURL := s.appURL + "/verify-location/" + token
			if err := s.email.SendFileServerLocationVerification(ctx, user.Email, link.ServerName, sourceIP, verifyURL); err != nil {
				log.Printf("file server link %s: send verification email: %v", link.ID, err)
			}
		}
	}
	return ErrLocationUnverified
}

// VerifyLocation consumes an emailed verification token on behalf of the
// signed-in owner. The token must be younger than locationTokenMaxAge.
func (s *FileServerLinkService) VerifyLocation(ctx context.Context, username, token string) error {
	if token == "" {
		return ErrLinkNotFound
	}
	n, err := s.queries.VerifyLinkLocation(ctx, username, token, locationTokenMaxAge)
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrLinkNotFound
	}
	return nil
}

// Touch stamps last_used_at, best-effort.
func (s *FileServerLinkService) Touch(ctx context.Context, id uuid.UUID) {
	if err := s.queries.TouchFileServerLink(ctx, id); err != nil {
		log.Printf("file server link %s: touch: %v", id, err)
	}
}

// generateURLToken returns a 256-bit URL-safe random token.
func generateURLToken() (string, error) {
	b := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
