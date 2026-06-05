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
	"strings"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

const defaultInviteTokenTTL = 7 * 24 * time.Hour

// ── Types ─────────────────────────────────────────────────────────────────────

// InviteValidation is returned by Validate and contains only the information
// the registration page needs. The raw token is never included.
type InviteValidation struct {
	Email           string    `json:"email"`
	InvitedByUserID uuid.UUID `json:"invited_by_user_id"`
	ExpiresAt       time.Time `json:"expires_at"`
	GrantAdmin      bool      `json:"grant_admin"`
	GrantPremium    bool      `json:"grant_premium"`
}

// ── Service ───────────────────────────────────────────────────────────────────

// InviteService creates, validates, lists, and revokes user invitations.
// On creation it enqueues an invitation email via EmailService if one is wired in.
type InviteService struct {
	queries  *db.Queries
	email    *EmailService // optional — if nil, email sending is skipped with a log warning
	appURL   string
	tokenTTL time.Duration
}

// NewInviteService constructs an InviteService.
// emailSvc may be nil during development; a warning is logged on each skipped send.
// tokenTTL controls how long an invitation link remains valid; pass 0 to use the
// default of 72 hours.
func NewInviteService(q *db.Queries, emailSvc *EmailService, appURL string, tokenTTL time.Duration) *InviteService {
	if tokenTTL <= 0 {
		tokenTTL = defaultInviteTokenTTL
	}
	return &InviteService{
		queries:  q,
		email:    emailSvc,
		appURL:   strings.TrimRight(appURL, "/"),
		tokenTTL: tokenTTL,
	}
}

// ── Public operations ─────────────────────────────────────────────────────────

// Create generates a secure invitation token, stores the invitation in the DB,
// and enqueues a welcome email to the invitee.
//
// invitedByUserID is the Keycloak sub UUID of the admin creating the invite.
// invitedByUsername is used in the email copy ("X invited you to apollo-sfs").
//
// Returns ErrInviteAlreadyPending if a pending invite for this email already exists.
func (s *InviteService) Create(
	ctx context.Context,
	invitedByUserID uuid.UUID,
	invitedByUsername string,
	email string,
	initialQuotaBytes int64,
	grantAdmin bool,
	grantPremium bool,
) (*models.Invitation, error) {
	token, err := generateInviteToken()
	if err != nil {
		return nil, fmt.Errorf("create invitation: generate token: %w", err)
	}

	if initialQuotaBytes <= 0 {
		initialQuotaBytes = defaultQuotaBytes
	}

	expiresAt := time.Now().UTC().Add(s.tokenTTL)

	inv := &models.Invitation{
		InvitedByUserID:   invitedByUserID,
		Email:             email,
		Token:             token,
		TokenExpiresAt:    expiresAt,
		InitialQuotaBytes: initialQuotaBytes,
		GrantAdmin:        grantAdmin,
		GrantPremium:      grantPremium,
	}

	if err := s.queries.CreateInvitation(ctx, inv); err != nil {
		if isDuplicateKeyError(err) {
			return nil, ErrInviteAlreadyPending
		}
		return nil, fmt.Errorf("create invitation: %w", err)
	}

	// Enqueue invitation email. Non-fatal — the admin can resend manually if needed.
	invitationURL := s.appURL + "/register?token=" + token
	if s.email != nil {
		if err := s.email.SendInvitation(
			ctx,
			email,
			invitedByUsername,
			invitationURL,
			humanizeDuration(s.tokenTTL),
		); err != nil {
			log.Printf("invite: enqueue email to %q: %v", email, err)
		}
	} else {
		log.Printf("invite: email service not configured — invitation URL: %s", invitationURL)
	}

	// Return the invitation without the token field populated in the JSON response
	// (the Token field is tagged json:"-" on the model).
	inv.TokenExpiresAt = expiresAt
	return inv, nil
}

// Validate looks up a token and confirms it is pending and unexpired.
// Returns ErrInviteNotFound for missing, already-used, or revoked tokens.
// Returns ErrInviteExpired when the token exists but its TTL has passed.
func (s *InviteService) Validate(ctx context.Context, token string) (*InviteValidation, error) {
	inv, err := s.queries.GetInvitationByToken(ctx, token)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrInviteNotFound
		}
		return nil, fmt.Errorf("validate invitation: %w", err)
	}

	if time.Now().After(inv.TokenExpiresAt) {
		return nil, ErrInviteExpired
	}

	return &InviteValidation{
		Email:           inv.Email,
		InvitedByUserID: inv.InvitedByUserID,
		ExpiresAt:       inv.TokenExpiresAt,
		GrantAdmin:      inv.GrantAdmin,
		GrantPremium:    inv.GrantPremium,
	}, nil
}

// List returns a paginated list of all invitations ordered by creation time
// descending. Intended for the admin dashboard.
func (s *InviteService) List(ctx context.Context, page db.PageInput) (*db.PageResult[models.Invitation], error) {
	result, err := s.queries.ListInvitations(ctx, page)
	if err != nil {
		return nil, fmt.Errorf("list invitations: %w", err)
	}
	return result, nil
}

// InvitationURL builds the full registration URL for the given token.
func (s *InviteService) InvitationURL(token string) string {
	return s.appURL + "/register?token=" + token
}

// Resend generates a fresh token and expiry for an existing pending invitation,
// then re-sends the invitation email with the new link.
// Returns ErrInviteNotFound if the invitation does not exist, is accepted, or revoked.
func (s *InviteService) Resend(ctx context.Context, id uuid.UUID, byUsername string) error {
	inv, err := s.queries.GetInvitationByID(ctx, id)
	if err != nil {
		return ErrInviteNotFound
	}
	if inv.AcceptedAt != nil || inv.RevokedAt != nil {
		return ErrInviteNotFound
	}

	newToken, err := generateInviteToken()
	if err != nil {
		return fmt.Errorf("resend invitation: generate token: %w", err)
	}
	newExpiry := time.Now().UTC().Add(s.tokenTTL)

	if err := s.queries.RefreshInvitationToken(ctx, id, newToken, newExpiry); err != nil {
		return fmt.Errorf("resend invitation: %w", err)
	}

	invitationURL := s.InvitationURL(newToken)
	if s.email != nil {
		if err := s.email.SendInvitation(
			ctx,
			inv.Email,
			byUsername,
			invitationURL,
			humanizeDuration(s.tokenTTL),
		); err != nil {
			log.Printf("invite: resend email to %q: %v", inv.Email, err)
		}
	} else {
		log.Printf("invite: email service not configured — invitation URL: %s", invitationURL)
	}
	return nil
}

// Revoke marks a pending invitation as revoked. Silently succeeds if the
// invitation was already revoked (idempotent). Returns ErrInviteNotFound if
// the ID does not exist.
func (s *InviteService) Revoke(ctx context.Context, id uuid.UUID) error {
	if err := s.queries.RevokeInvitation(ctx, id); err != nil {
		return fmt.Errorf("revoke invitation: %w", err)
	}
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// generateInviteToken produces a cryptographically random, URL-safe token.
// 32 random bytes → 43-character base64url string (no padding).
func generateInviteToken() (string, error) {
	b := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// humanizeDuration formats a duration as a human-readable string for email copy.
// e.g. 72h → "72 hours", 48h → "2 days", 168h → "7 days".
func humanizeDuration(d time.Duration) string {
	hours := int(d.Hours())
	if hours%24 == 0 {
		days := hours / 24
		if days == 1 {
			return "1 day"
		}
		return fmt.Sprintf("%d days", days)
	}
	if hours == 1 {
		return "1 hour"
	}
	return fmt.Sprintf("%d hours", hours)
}

// ── Sentinel errors ───────────────────────────────────────────────────────────

var ErrInviteNotFound = errors.New("invitation not found or already used")
var ErrInviteExpired = errors.New("invitation link has expired")
var ErrInviteAlreadyPending = errors.New("a pending invitation already exists for this email address")
