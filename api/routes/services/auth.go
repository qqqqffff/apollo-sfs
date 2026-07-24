package services

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// ErrNoCapacity is re-exported so handlers can check it without importing db.
var ErrNoCapacity = db.ErrNoCapacity

const defaultQuotaBytes = 10 * 1024 * 1024 * 1024 // 10 GB

// ── Types ─────────────────────────────────────────────────────────────────────

// AuthServiceConfig holds the parameters needed to construct an AuthService.
type AuthServiceConfig struct {
	KeycloakURL          string
	KeycloakRealm        string
	KeycloakClientID     string
	KeycloakClientSecret string
	AppBaseURL           string // public-facing base URL, e.g. "https://files.example.com"

	// GoogleWebClientID / GoogleWebClientSecret are used to exchange a mobile
	// server auth code for a Google id_token whose audience is the web client ID,
	// which Keycloak's Google IdP accepts during token exchange.
	GoogleWebClientID     string
	GoogleWebClientSecret string
}

// TokenPair is returned on successful login, registration, and token refresh.
type TokenPair struct {
	AccessToken      string
	RefreshToken     string
	ExpiresIn        int
	RefreshExpiresIn int
}

// kcTokenResponse maps the subset of fields returned by the Keycloak token endpoint.
type kcTokenResponse struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	ExpiresIn        int    `json:"expires_in"`
	RefreshExpiresIn int    `json:"refresh_expires_in"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

// kcUser is the body sent to POST /admin/realms/{realm}/users.
type kcUser struct {
	Username      string          `json:"username"`
	Email         string          `json:"email"`
	Enabled       bool            `json:"enabled"`
	EmailVerified bool            `json:"emailVerified"`
	Credentials   []kcCredential  `json:"credentials,omitempty"`
}

type kcCredential struct {
	Type      string `json:"type"`
	Value     string `json:"value"`
	Temporary bool   `json:"temporary"`
}

// kcUserResult is a single item from GET /admin/realms/{realm}/users.
type kcUserResult struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// ── Service ───────────────────────────────────────────────────────────────────

// AuthService handles all authentication operations: login, registration,
// logout, token refresh, and password-reset email triggering.
type AuthService struct {
	queries       *db.Queries
	kcURL         string
	kcRealm       string
	kcClientID    string
	kcSecret      string
	appBaseURL    string
	http          *http.Client
	googleClientID string
	googleSecret   string

	// ProvisionUserKey is called during registration to generate and wrap the
	// user's per-file AES key with the current master key. When nil (before the
	// encryption service is wired in), random placeholder bytes are stored and
	// must be replaced before the user can upload files.
	ProvisionUserKey func(ctx context.Context) (encryptedKey, nonce []byte, masterKeyVersion string, err error)
}

// NewAuthService constructs an AuthService with a 10-second HTTP timeout.
func NewAuthService(q *db.Queries, cfg AuthServiceConfig) *AuthService {
	return &AuthService{
		queries:        q,
		kcURL:          cfg.KeycloakURL,
		kcRealm:        cfg.KeycloakRealm,
		kcClientID:     cfg.KeycloakClientID,
		kcSecret:       cfg.KeycloakClientSecret,
		appBaseURL:     strings.TrimRight(cfg.AppBaseURL, "/"),
		http:           &http.Client{Timeout: 10 * time.Second},
		googleClientID: cfg.GoogleWebClientID,
		googleSecret:   cfg.GoogleWebClientSecret,
	}
}

// ── Public methods ────────────────────────────────────────────────────────────

// AppBaseURL returns the public-facing base URL of the application.
func (s *AuthService) AppBaseURL() string { return s.appBaseURL }

// AuthCodeExchange exchanges a Keycloak authorization code for a token pair
// using the authorization_code grant. redirectURI must match the value used
// when the authorization request was initiated.
//
// If the social identity's email already belongs to an existing app account
// under a different username, an *ErrEmailConflict is returned instead of
// provisioning a duplicate. The caller should surface the linking flow.
func (s *AuthService) AuthCodeExchange(ctx context.Context, code, redirectURI, provider string) (*TokenPair, error) {
	body := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {s.kcClientID},
		"client_secret": {s.kcSecret},
		"code":          {code},
		"redirect_uri":  {redirectURI},
	}
	tokens, err := s.tokenRequest(ctx, body)
	if err != nil {
		return nil, fmt.Errorf("auth code exchange: %w", err)
	}

	if err := s.checkEmailConflict(ctx, tokens.AccessToken, provider); err != nil {
		return nil, err
	}

	if s.ProvisionUserKey != nil {
		if err := s.ensureUserProvisioned(ctx, tokens.AccessToken); err != nil {
			return nil, fmt.Errorf("auth code exchange: provision user: %w", err)
		}
	}
	return tokens, nil
}

// checkEmailConflict decodes the KC access token, and if the token's email
// already belongs to an existing app account that would not be found by the
// KC preferred_username, returns an *ErrEmailConflict. Email is the sole
// deduplication key; usernames are not compared.
func (s *AuthService) checkEmailConflict(ctx context.Context, accessToken, provider string) error {
	claims, err := decodeTokenClaims(accessToken)
	if err != nil || claims.Email == "" {
		return nil
	}
	// If this KC user already has an app DB record, no conflict.
	_, err = s.queries.GetUserByUsername(ctx, claims.PreferredUsername)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil // unexpected DB error — let provisioning handle it
	}
	// KC user has no app record yet. Check if the email belongs to another account.
	existing, err := s.queries.GetUserByEmail(ctx, claims.Email)
	if err != nil {
		return nil // email not found — no conflict
	}
	return &ErrEmailConflict{
		Email:            claims.Email,
		ExistingUsername: existing.Username,
		PendingKcUserID:  claims.Sub,
		Provider:         provider,
	}
}

// LinkSocialAccount links a social identity (whose temp KC user is identified by
// pendingKcUserID) to the existing app account verified by username + password.
// On success it returns tokens for the existing account and cleans up the
// temporary Keycloak user that was created for the social identity.
func (s *AuthService) LinkSocialAccount(ctx context.Context, existingUsername, password, pendingKcUserID, provider string) (*TokenPair, error) {
	// Verify the existing credentials to ensure the user owns the account.
	tokens, err := s.Login(ctx, existingUsername, password)
	if err != nil {
		return nil, fmt.Errorf("link social: %w", err)
	}

	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return nil, fmt.Errorf("link social: admin token: %w", err)
	}

	// Find the existing user's Keycloak ID.
	existingKcID, err := s.kcFindUserByUsername(ctx, adminToken, existingUsername)
	if err != nil || existingKcID == "" {
		return nil, fmt.Errorf("link social: existing KC user not found")
	}

	// Fetch the federated identities from the temporary social KC user.
	fedIDs, err := s.kcGetFederatedIdentities(ctx, adminToken, pendingKcUserID)
	if err != nil {
		return nil, fmt.Errorf("link social: fetch federated identities: %w", err)
	}

	// Link each federated identity from the temp user to the existing user.
	for _, fid := range fedIDs {
		if fid.IdentityProvider != provider {
			continue
		}
		if err := s.kcAddFederatedIdentity(ctx, adminToken, existingKcID, fid); err != nil {
			return nil, fmt.Errorf("link social: add federated identity: %w", err)
		}
	}

	// Delete the temporary social Keycloak user now that its identity is linked.
	if err := s.kcDeleteUser(ctx, adminToken, pendingKcUserID); err != nil {
		// Non-fatal: log but continue — the link succeeded and the orphan
		// can be cleaned up manually if needed.
		fmt.Printf("link social: warning: could not delete temp KC user %s: %v\n", pendingKcUserID, err)
	}

	return tokens, nil
}

// GetLinkedProviders returns the list of Keycloak IdP aliases linked to the given user.
func (s *AuthService) GetLinkedProviders(ctx context.Context, kcUserID string) ([]string, error) {
	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return nil, fmt.Errorf("get linked providers: admin token: %w", err)
	}
	fids, err := s.kcGetFederatedIdentities(ctx, adminToken, kcUserID)
	if err != nil {
		return nil, err
	}
	providers := make([]string, 0, len(fids))
	for _, f := range fids {
		providers = append(providers, f.IdentityProvider)
	}
	return providers, nil
}

// kcFederatedIdentity is a single entry from Keycloak's federated-identity API.
type kcFederatedIdentity struct {
	IdentityProvider string `json:"identityProvider"`
	UserID           string `json:"userId"`
	UserName         string `json:"userName"`
}

// kcGetFederatedIdentities returns the list of federated identities for a KC user.
func (s *AuthService) kcGetFederatedIdentities(ctx context.Context, adminToken, kcUserID string) ([]kcFederatedIdentity, error) {
	endpoint := fmt.Sprintf("%s/admin/realms/%s/users/%s/federated-identity",
		s.kcURL, s.kcRealm, kcUserID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+adminToken)

	resp, err := s.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("keycloak request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("keycloak returned %s", resp.Status)
	}
	var ids []kcFederatedIdentity
	if err := json.NewDecoder(resp.Body).Decode(&ids); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return ids, nil
}

// kcAddFederatedIdentity links one federated identity to a KC user.
func (s *AuthService) kcAddFederatedIdentity(ctx context.Context, adminToken, kcUserID string, fid kcFederatedIdentity) error {
	body, _ := json.Marshal(fid)
	endpoint := fmt.Sprintf("%s/admin/realms/%s/users/%s/federated-identity/%s",
		s.kcURL, s.kcRealm, kcUserID, fid.IdentityProvider)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+adminToken)

	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("keycloak request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("keycloak returned %s", resp.Status)
	}
	return nil
}

// kcDeleteUser deletes a Keycloak user by their KC UUID.
func (s *AuthService) kcDeleteUser(ctx context.Context, adminToken, kcUserID string) error {
	endpoint := fmt.Sprintf("%s/admin/realms/%s/users/%s", s.kcURL, s.kcRealm, kcUserID)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+adminToken)

	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("keycloak request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("keycloak returned %s", resp.Status)
	}
	return nil
}

// Login performs a Keycloak ROPC grant and returns the token pair on success.
// Returns a non-nil error if credentials are invalid or Keycloak is unreachable.
// As a side-effect, it provisions an app DB record for users created directly in
// Keycloak (e.g. the bootstrap admin) who have never gone through Register.
func (s *AuthService) Login(ctx context.Context, username, password string) (*TokenPair, error) {
	body := url.Values{
		"grant_type":    {"password"},
		"client_id":     {s.kcClientID},
		"client_secret": {s.kcSecret},
		"username":      {username},
		"password":      {password},
		"scope":         {"openid"},
	}
	tokens, err := s.tokenRequest(ctx, body)
	if err != nil {
		return nil, fmt.Errorf("login: %w", err)
	}

	if s.ProvisionUserKey != nil {
		if err := s.ensureUserProvisioned(ctx, tokens.AccessToken); err != nil {
			return nil, fmt.Errorf("login: provision user: %w", err)
		}
	}

	return tokens, nil
}

// ensureUserProvisioned creates an app DB record for the user identified by the
// access token if one does not already exist. This handles users bootstrapped
// directly in Keycloak who bypassed the normal Register flow.
func (s *AuthService) ensureUserProvisioned(ctx context.Context, accessToken string) error {
	claims, err := decodeTokenClaims(accessToken)
	if err != nil {
		return fmt.Errorf("decode token claims: %w", err)
	}

	_, err = s.queries.GetUserByUsername(ctx, claims.PreferredUsername)
	if err == nil {
		return nil // record already exists
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("check user: %w", err)
	}

	encKey, nonce, masterKeyVer, err := s.ProvisionUserKey(ctx)
	if err != nil {
		return fmt.Errorf("provision key: %w", err)
	}

	return s.queries.CreateUser(ctx, &models.User{
		Username:          claims.PreferredUsername,
		Email:             claims.Email,
		EncryptedKey:      encKey,
		KeyNonce:          nonce,
		MasterKeyVersion:  masterKeyVer,
		StorageUsedBytes:  0,
		StorageQuotaBytes: defaultQuotaBytes,
	})
}

// ErrInvitationRequired is returned by ProvisionBrokeredUser when a new (social)
// user has no valid invitation. The handler maps it to 403 so the app can prompt
// for an invite, distinct from a 500 on an internal failure.
var ErrInvitationRequired = errors.New("a valid invitation is required")

// ErrRoleProvisioningFailed is returned by provisionInvitedAppUser when the
// invitation requested realm roles (admin/premium) that could not be resolved
// or granted in Keycloak. It is returned before any app DB state is written
// or the invitation is marked accepted, so the invitation stays valid and the
// recipient can retry. Handlers map it to a distinct response telling the
// user to try accepting the invitation again shortly, rather than a plain
// success that silently hands them a lesser account.
var ErrRoleProvisioningFailed = errors.New("invited role could not be provisioned")

// validateInvitation looks up a pending invitation by token and verifies it
// matches the email and has not expired. Shared by password registration and
// brokered (social) first-login.
func (s *AuthService) validateInvitation(ctx context.Context, token, email string) (*models.Invitation, error) {
	inv, err := s.queries.GetInvitationByToken(ctx, token)
	if err != nil {
		return nil, fmt.Errorf("invalid or expired invitation")
	}
	if inv.Email != email {
		return nil, fmt.Errorf("email does not match invitation")
	}
	if time.Now().After(inv.TokenExpiresAt) {
		return nil, fmt.Errorf("invitation has expired")
	}
	return inv, nil
}

// provisionInvitedAppUser performs the app-side provisioning shared by password
// registration and brokered first-login, for a user whose invitation has already
// been validated and whose Keycloak account (kcUserID) already exists. It grants
// the invitation's realm roles, provisions the encryption key, selects and
// allocates a drive, creates the app DB record, and marks the invitation accepted.
//
// Role granting runs first and is fatal on failure (see ErrRoleProvisioningFailed):
// nothing below it — the DB user, the drive allocation, or the invitation's
// accepted flag — is written, so a failed grant leaves the invitation valid for
// the caller to retry instead of silently completing with a downgraded account.
func (s *AuthService) provisionInvitedAppUser(
	ctx context.Context,
	adminToken, kcUserID, username, email, inviteToken string,
	inv *models.Invitation,
) error {
	// Grant realm roles requested by the invitation. Fatal: this runs before any
	// app DB state is written or the invitation is accepted (below), so on
	// failure we return here and leave the invitation unconsumed rather than
	// silently handing out an account with fewer privileges than promised.
	if inv.GrantAdmin || inv.GrantPremium {
		var names []string
		if inv.GrantAdmin {
			names = append(names, "admin")
		}
		if inv.GrantPremium || inv.GrantAdmin {
			// admins implicitly receive premium at the app layer, but we also
			// grant it explicitly so the Keycloak JWT carries the role.
			names = append(names, "premium")
		}
		rolesToGrant := make([]kcRoleRef, 0, len(names))
		for _, roleName := range names {
			role, roleErr := s.kcGetRealmRole(ctx, adminToken, roleName)
			if roleErr != nil {
				return fmt.Errorf("%w: look up role %q: %v", ErrRoleProvisioningFailed, roleName, roleErr)
			}
			rolesToGrant = append(rolesToGrant, *role)
		}
		if grantErr := s.kcGrantRealmRoles(ctx, adminToken, kcUserID, rolesToGrant); grantErr != nil {
			return fmt.Errorf("%w: grant roles %v: %v", ErrRoleProvisioningFailed, names, grantErr)
		}
	}

	// Provision encryption key.
	if s.ProvisionUserKey == nil {
		return fmt.Errorf("encryption service not wired")
	}
	encKey, nonce, masterKeyVer, err := s.ProvisionUserKey(ctx)
	if err != nil {
		return fmt.Errorf("provision key: %w", err)
	}

	// Quota + drive from the invitation; fall back to the server default quota
	// for invitations that pre-date the quota field.
	quotaBytes := inv.InitialQuotaBytes
	if quotaBytes <= 0 {
		quotaBytes = defaultQuotaBytes
	}
	var drive *models.Drive
	if inv.InitialDriveID != nil {
		drive, err = s.queries.GetDrive(ctx, *inv.InitialDriveID)
		if err != nil || drive == nil {
			return fmt.Errorf("pinned drive not found")
		}
	} else {
		drive, err = s.queries.SelectDriveForQuota(ctx, quotaBytes)
		if err != nil {
			if errors.Is(err, db.ErrNoCapacity) {
				return fmt.Errorf("no drive has sufficient capacity for the requested quota")
			}
			return fmt.Errorf("select drive: %w", err)
		}
	}

	if err := s.queries.CreateUser(ctx, &models.User{
		Username:          username,
		Email:             email,
		EncryptedKey:      encKey,
		KeyNonce:          nonce,
		MasterKeyVersion:  masterKeyVer,
		StorageUsedBytes:  0,
		StorageQuotaBytes: quotaBytes,
	}); err != nil {
		return fmt.Errorf("create db user: %w", err)
	}
	if err := s.queries.AllocateUserToDrive(ctx, username, drive.ID, quotaBytes); err != nil {
		return fmt.Errorf("allocate drive: %w", err)
	}

	// Accept invitation. Non-fatal: the account already exists.
	if err := s.queries.AcceptInvitation(ctx, inviteToken); err != nil {
		_ = err
	}
	return nil
}

// ProvisionBrokeredUser handles app-side provisioning after a brokered (Keycloak
// identity-provider) first login. Existing users — those that already have an app
// DB record — are ordinary logins and need no invitation. A new user must present
// a valid invitation; since Keycloak's first-broker-login flow already created the
// Keycloak account, that account is rolled back (deleted) when the invitation is
// missing or invalid, so social login cannot bypass the invite gate.
func (s *AuthService) ProvisionBrokeredUser(ctx context.Context, accessToken, inviteToken string) error {
	if s.ProvisionUserKey == nil {
		return nil
	}
	claims, err := decodeTokenClaims(accessToken)
	if err != nil {
		return fmt.Errorf("decode token claims: %w", err)
	}

	// Existing user → ordinary login, no invitation required.
	if _, err := s.queries.GetUserByUsername(ctx, claims.PreferredUsername); err == nil {
		return nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("check user: %w", err)
	}

	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return fmt.Errorf("get admin token: %w", err)
	}

	// New user → require a valid invitation. Validation happens before any app DB
	// writes, so on failure we delete the just-created Keycloak account cleanly.
	inv, err := s.validateInvitation(ctx, inviteToken, claims.Email)
	if err != nil {
		s.rollbackBrokeredUser(ctx, adminToken, claims.Sub)
		return fmt.Errorf("%w: %v", ErrInvitationRequired, err)
	}

	// Past this point the invitation is accepted and partial app state may be
	// created; on failure we leave the Keycloak account in place (matching
	// Register) rather than risk orphaning an app DB record.
	if err := s.provisionInvitedAppUser(ctx, adminToken, claims.Sub, claims.PreferredUsername, claims.Email, inviteToken, inv); err != nil {
		return err
	}
	return nil
}

// rollbackBrokeredUser deletes a Keycloak account that first-broker-login created
// for an un-invited social login. Best-effort.
func (s *AuthService) rollbackBrokeredUser(ctx context.Context, adminToken, kcUserID string) {
	if kcUserID == "" {
		return
	}
	_ = s.kcDeleteUser(ctx, adminToken, kcUserID)
}

// Register creates a user in Keycloak via the Admin API, provisions an app DB
// record, validates and marks the invitation token used, then logs the user in.
//
// The invitation token must correspond to a pending, non-expired invitation for
// the given email address.
func (s *AuthService) Register(ctx context.Context, username, email, password, inviteToken string) (*TokenPair, error) {
	// 1. Validate invitation.
	inv, err := s.validateInvitation(ctx, inviteToken, email)
	if err != nil {
		return nil, fmt.Errorf("register: %w", err)
	}

	// 2. Create user in Keycloak.
	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return nil, fmt.Errorf("register: get admin token: %w", err)
	}
	kcUserID, err := s.kcCreateUser(ctx, adminToken, username, email, password)
	if err != nil {
		return nil, fmt.Errorf("register: create keycloak user: %w", err)
	}

	// 3. Provision the app-side account: invitation roles, encryption key, drive
	// selection/allocation, DB record, and invitation accept.
	if err := s.provisionInvitedAppUser(ctx, adminToken, kcUserID, username, email, inviteToken, inv); err != nil {
		return nil, fmt.Errorf("register: %w", err)
	}

	// 4. Auto-login.
	tokens, err := s.Login(ctx, username, password)
	if err != nil {
		return nil, fmt.Errorf("register: auto-login: %w", err)
	}
	return tokens, nil
}

// Logout revokes the refresh token at Keycloak, invalidating the session.
// Session cookie clearing is handled by the caller (handler layer).
func (s *AuthService) Logout(ctx context.Context, refreshToken string) error {
	body := url.Values{
		"client_id":     {s.kcClientID},
		"client_secret": {s.kcSecret},
		"refresh_token": {refreshToken},
	}
	endpoint := fmt.Sprintf("%s/realms/%s/protocol/openid-connect/logout", s.kcURL, s.kcRealm)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(body.Encode()))
	if err != nil {
		return fmt.Errorf("logout: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("logout: keycloak request: %w", err)
	}
	defer resp.Body.Close()

	// Keycloak returns 204 No Content on success.
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("logout: keycloak returned %s", resp.Status)
	}
	return nil
}

// Refresh exchanges a refresh token for a new token pair.
func (s *AuthService) Refresh(ctx context.Context, refreshToken string) (*TokenPair, error) {
	body := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {s.kcClientID},
		"client_secret": {s.kcSecret},
		"refresh_token": {refreshToken},
	}
	tokens, err := s.tokenRequest(ctx, body)
	if err != nil {
		return nil, fmt.Errorf("refresh: %w", err)
	}
	return tokens, nil
}

// ForgotPassword looks up the Keycloak user by email and triggers Keycloak's
// built-in "send reset email" action. Always returns nil to prevent email
// enumeration — the caller should return 200 regardless of whether the address
// is registered.
func (s *AuthService) ForgotPassword(ctx context.Context, email string) error {
	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return fmt.Errorf("forgot password: get admin token: %w", err)
	}

	userID, err := s.kcFindUserByEmail(ctx, adminToken, email)
	if err != nil || userID == "" {
		// User not found — silently succeed to prevent email enumeration.
		return nil
	}

	// Pass the app's reset page as the post-completion redirect URI so Keycloak
	// sends the user back to the frontend after they complete the reset on Keycloak's
	// built-in page. When s.appBaseURL is empty the redirect defaults to Keycloak's
	// account console.
	redirectURI := ""
	if s.appBaseURL != "" {
		redirectURI = s.appBaseURL + "/reset-password"
	}
	if err := s.kcExecuteActionsEmail(ctx, adminToken, userID, redirectURI); err != nil {
		return fmt.Errorf("forgot password: send reset email: %w", err)
	}
	return nil
}

// ResetPassword validates a Keycloak action token and sets the user's password
// via the Keycloak Admin API.
//
// The token is the `key` query parameter from the Keycloak password-reset email
// link. Its JWT payload contains the Keycloak user UUID (sub) and an expiry (exp)
// that are checked before the Admin API call is made.
//
// Note: the token signature is not cryptographically verified here — security
// relies on the token being delivered exclusively via email. A future improvement
// is to verify the signature against Keycloak's JWKS endpoint
// ({keycloakURL}/realms/{realm}/protocol/openid-connect/certs).
func (s *AuthService) ResetPassword(ctx context.Context, token, newPassword string) error {
	userID, exp, err := parseActionToken(token)
	if err != nil {
		return fmt.Errorf("reset password: invalid token: %w", err)
	}
	if exp > 0 && time.Now().Unix() > exp {
		return fmt.Errorf("reset password: token has expired")
	}

	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return fmt.Errorf("reset password: get admin token: %w", err)
	}

	if err := s.kcResetPassword(ctx, adminToken, userID, newPassword); err != nil {
		return fmt.Errorf("reset password: %w", err)
	}
	return nil
}

// ── Private helpers ───────────────────────────────────────────────────────────

// tokenRequest posts form-encoded values to the Keycloak token endpoint.
func (s *AuthService) tokenRequest(ctx context.Context, body url.Values) (*TokenPair, error) {
	endpoint := fmt.Sprintf("%s/realms/%s/protocol/openid-connect/token", s.kcURL, s.kcRealm)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(body.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := s.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("keycloak request: %w", err)
	}
	defer resp.Body.Close()

	var tr kcTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		if tr.ErrorDescription != "" {
			return nil, fmt.Errorf("%s: %s", tr.Error, tr.ErrorDescription)
		}
		return nil, fmt.Errorf("keycloak returned %s", resp.Status)
	}
	return &TokenPair{
		AccessToken:      tr.AccessToken,
		RefreshToken:     tr.RefreshToken,
		ExpiresIn:        tr.ExpiresIn,
		RefreshExpiresIn: tr.RefreshExpiresIn,
	}, nil
}

// adminToken obtains a short-lived admin access token via the client credentials
// grant. The Keycloak client must have "Service Accounts Enabled" and the
// service account must be assigned the admin realm role.
func (s *AuthService) adminToken(ctx context.Context) (string, error) {
	body := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {s.kcClientID},
		"client_secret": {s.kcSecret},
	}
	tokens, err := s.tokenRequest(ctx, body)
	if err != nil {
		return "", fmt.Errorf("admin token: %w", err)
	}
	return tokens.AccessToken, nil
}

// kcRoleRef is the minimal representation Keycloak requires to assign a realm role.
type kcRoleRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// kcGetRealmRole fetches the role definition for roleName so we have its UUID.
func (s *AuthService) kcGetRealmRole(ctx context.Context, adminToken, roleName string) (*kcRoleRef, error) {
	endpoint := fmt.Sprintf("%s/admin/realms/%s/roles/%s", s.kcURL, s.kcRealm, url.PathEscape(roleName))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+adminToken)
	resp, err := s.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("keycloak request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("realm role %q not found", roleName)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("keycloak returned %s", resp.Status)
	}
	var role kcRoleRef
	if err := json.NewDecoder(resp.Body).Decode(&role); err != nil {
		return nil, err
	}
	return &role, nil
}

// kcGrantRealmRoles assigns the given realm roles to the Keycloak user.
func (s *AuthService) kcGrantRealmRoles(ctx context.Context, adminToken, userID string, roles []kcRoleRef) error {
	body, err := json.Marshal(roles)
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("%s/admin/realms/%s/users/%s/role-mappings/realm", s.kcURL, s.kcRealm, userID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+adminToken)
	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("keycloak request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("keycloak returned %s: %s", resp.Status, string(b))
	}
	return nil
}

// kcCreateUser calls POST /admin/realms/{realm}/users to create the account.
// Returns the new user's Keycloak UUID extracted from the Location response header.
func (s *AuthService) kcCreateUser(ctx context.Context, adminToken, username, email, password string) (string, error) {
	user := kcUser{
		Username:      username,
		Email:         email,
		Enabled:       true,
		EmailVerified: true,
		Credentials: []kcCredential{
			{Type: "password", Value: password, Temporary: false},
		},
	}
	body, err := json.Marshal(user)
	if err != nil {
		return "", err
	}

	endpoint := fmt.Sprintf("%s/admin/realms/%s/users", s.kcURL, s.kcRealm)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+adminToken)

	resp, err := s.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("keycloak request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusConflict {
		return "", fmt.Errorf("username or email already exists")
	}
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("keycloak returned %s: %s", resp.Status, string(b))
	}

	// Extract the new user UUID from the Location header
	// e.g. http://keycloak:8180/admin/realms/myrealm/users/<uuid>
	loc := resp.Header.Get("Location")
	if idx := strings.LastIndex(loc, "/"); idx >= 0 {
		return loc[idx+1:], nil
	}
	return "", fmt.Errorf("could not extract user ID from Location header: %q", loc)
}

// kcFindUserByEmail looks up a Keycloak user ID by exact email match.
// Returns an empty string (no error) when the email is not found.
func (s *AuthService) kcFindUserByEmail(ctx context.Context, adminToken, email string) (string, error) {
	endpoint := fmt.Sprintf("%s/admin/realms/%s/users?email=%s&exact=true",
		s.kcURL, s.kcRealm, url.QueryEscape(email))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+adminToken)

	resp, err := s.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("keycloak request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("keycloak returned %s", resp.Status)
	}

	var users []kcUserResult
	if err := json.NewDecoder(resp.Body).Decode(&users); err != nil {
		return "", err
	}
	if len(users) == 0 {
		return "", nil
	}
	return users[0].ID, nil
}

// kcExecuteActionsEmail triggers Keycloak's UPDATE_PASSWORD action email.
// When redirectURI is non-empty it is appended as a redirect_uri query param so
// Keycloak redirects the user there after the reset completes on Keycloak's UI.
func (s *AuthService) kcExecuteActionsEmail(ctx context.Context, adminToken, userID, redirectURI string) error {
	actions := []string{"UPDATE_PASSWORD"}
	body, _ := json.Marshal(actions)

	endpoint := fmt.Sprintf("%s/admin/realms/%s/users/%s/execute-actions-email",
		s.kcURL, s.kcRealm, userID)
	if redirectURI != "" {
		endpoint += "?redirect_uri=" + url.QueryEscape(redirectURI)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+adminToken)

	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("keycloak request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("keycloak returned %s", resp.Status)
	}
	return nil
}

// kcResetPassword calls PUT /admin/realms/{realm}/users/{id}/reset-password to
// directly set a new password for the given Keycloak user.
func (s *AuthService) kcResetPassword(ctx context.Context, adminToken, userID, newPassword string) error {
	cred := kcCredential{Type: "password", Value: newPassword, Temporary: false}
	body, err := json.Marshal(cred)
	if err != nil {
		return err
	}

	endpoint := fmt.Sprintf("%s/admin/realms/%s/users/%s/reset-password",
		s.kcURL, s.kcRealm, userID)

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+adminToken)

	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("keycloak request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("keycloak returned %s: %s", resp.Status, string(b))
	}
	return nil
}

// kcTokenClaims holds the subset of JWT claims needed for user provisioning.
type kcTokenClaims struct {
	Sub               string `json:"sub"` // Keycloak user UUID
	PreferredUsername string `json:"preferred_username"`
	Email             string `json:"email"`
}

// ErrEmailConflict is returned by AuthCodeExchange when the social login email
// matches an existing app account with a different username. The caller should
// store the PendingKcUserID and Provider in a short-lived session and redirect
// the user to the account-linking UI.
type ErrEmailConflict struct {
	Email            string // email shared by both accounts
	ExistingUsername string // existing app DB username
	PendingKcUserID  string // KC user UUID of the new social-identity user
	Provider         string // "google" or "apple"
}

func (e *ErrEmailConflict) Error() string {
	return fmt.Sprintf("email conflict: %s already belongs to %s", e.Email, e.ExistingUsername)
}

// decodeTokenClaims base64-decodes the JWT payload without verifying the
// signature. Safe here because the token was just issued by Keycloak directly
// over the internal Docker network via the ROPC grant.
func decodeTokenClaims(token string) (*kcTokenClaims, error) {
	parts := strings.SplitN(token, ".", 3)
	if len(parts) != 3 {
		return nil, fmt.Errorf("not a valid JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("decode payload: %w", err)
	}
	var claims kcTokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("parse claims: %w", err)
	}
	if claims.PreferredUsername == "" {
		return nil, fmt.Errorf("token missing preferred_username claim")
	}
	return &claims, nil
}

// parseActionToken decodes the payload of a Keycloak action token JWT (without
// verifying the signature) and returns the subject (Keycloak user UUID) and the
// expiry Unix timestamp. A zero exp means the token carries no expiry claim.
func parseActionToken(token string) (sub string, exp int64, err error) {
	parts := strings.SplitN(token, ".", 3)
	if len(parts) != 3 {
		return "", 0, fmt.Errorf("not a valid JWT")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", 0, fmt.Errorf("decode payload: %w", err)
	}
	var claims struct {
		Sub string `json:"sub"`
		Exp int64  `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return "", 0, fmt.Errorf("parse claims: %w", err)
	}
	if claims.Sub == "" {
		return "", 0, fmt.Errorf("token is missing subject claim")
	}
	return claims.Sub, claims.Exp, nil
}

// GetUserKcID returns the Keycloak subject UUID for the given username.
// Used by admin handlers to resolve a preferred_username to the UUID that
// folders and files are keyed on.
func (s *AuthService) GetUserKcID(ctx context.Context, username string) (uuid.UUID, error) {
	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return uuid.UUID{}, fmt.Errorf("get user kc id: admin token: %w", err)
	}
	kcID, err := s.kcFindUserByUsername(ctx, adminToken, username)
	if err != nil {
		return uuid.UUID{}, fmt.Errorf("get user kc id: lookup: %w", err)
	}
	if kcID == "" {
		return uuid.UUID{}, fmt.Errorf("user %q not found in keycloak", username)
	}
	id, err := uuid.Parse(kcID)
	if err != nil {
		return uuid.UUID{}, fmt.Errorf("get user kc id: parse UUID %q: %w", kcID, err)
	}
	return id, nil
}

// ChangePassword verifies the user's current password via an ROPC grant, then
// uses the Keycloak Admin API to set the new password. Returns a sentinel error
// if the current password is wrong so the handler can return 401.
func (s *AuthService) ChangePassword(ctx context.Context, username, currentPassword, newPassword string) error {
	// Verify current password by attempting a token grant.
	body := url.Values{
		"grant_type":    {"password"},
		"client_id":     {s.kcClientID},
		"client_secret": {s.kcSecret},
		"username":      {username},
		"password":      {currentPassword},
		"scope":         {"openid"},
	}
	if _, err := s.tokenRequest(ctx, body); err != nil {
		return ErrWrongPassword
	}

	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return fmt.Errorf("change password: get admin token: %w", err)
	}

	kcID, err := s.kcFindUserByUsername(ctx, adminToken, username)
	if err != nil {
		return fmt.Errorf("change password: look up user: %w", err)
	}
	if kcID == "" {
		return fmt.Errorf("change password: user %q not found in keycloak", username)
	}

	if err := s.kcResetPassword(ctx, adminToken, kcID, newPassword); err != nil {
		return fmt.Errorf("change password: %w", err)
	}
	return nil
}

// ErrWrongPassword is returned by ChangePassword when the current password is incorrect.
var ErrWrongPassword = errors.New("current password is incorrect")

// RenameUser updates the username in both Keycloak and the app DB atomically
// from the caller's perspective — Keycloak is updated first, then the DB.
// If the DB update fails after a successful Keycloak update the error is returned
// so the caller can surface it; the Keycloak change will stand but admins can
// retry the DB rename.
func (s *AuthService) RenameUser(ctx context.Context, oldUsername, newUsername string) error {
	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return fmt.Errorf("rename user: get admin token: %w", err)
	}

	kcID, err := s.kcFindUserByUsername(ctx, adminToken, oldUsername)
	if err != nil {
		return fmt.Errorf("rename user: look up keycloak user: %w", err)
	}
	if kcID == "" {
		return fmt.Errorf("rename user: user %q not found in keycloak", oldUsername)
	}

	if err := s.kcUpdateUsername(ctx, adminToken, kcID, newUsername); err != nil {
		return fmt.Errorf("rename user: update keycloak: %w", err)
	}

	if err := s.queries.UpdateUsername(ctx, oldUsername, newUsername); err != nil {
		return fmt.Errorf("rename user: update db: %w", err)
	}
	return nil
}

// kcFindUserByUsername looks up a Keycloak user ID by exact username match.
// Returns an empty string (no error) when the username is not found.
func (s *AuthService) kcFindUserByUsername(ctx context.Context, adminToken, username string) (string, error) {
	endpoint := fmt.Sprintf("%s/admin/realms/%s/users?username=%s&exact=true",
		s.kcURL, s.kcRealm, url.QueryEscape(username))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+adminToken)

	resp, err := s.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("keycloak request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("keycloak returned %s", resp.Status)
	}

	var users []kcUserResult
	if err := json.NewDecoder(resp.Body).Decode(&users); err != nil {
		return "", err
	}
	if len(users) == 0 {
		return "", nil
	}
	return users[0].ID, nil
}

// ExchangeGoogleServerAuthCode exchanges a one-time server auth code (obtained by
// the iOS app via GoogleSignin.signIn()) for a Google id_token whose audience is
// the web client ID. This id_token can then be passed to SocialLogin, where Keycloak
// validates it against the web client ID configured in its Google IdP.
//
// The id_token returned by the mobile SDK directly has aud = iOS client ID, which
// Keycloak rejects. This two-step approach resolves the audience mismatch.
func (s *AuthService) ExchangeGoogleServerAuthCode(ctx context.Context, serverAuthCode string) (string, error) {
	if s.googleClientID == "" || s.googleSecret == "" {
		return "", fmt.Errorf("google web client credentials not configured")
	}
	body := url.Values{
		"code":          {serverAuthCode},
		"client_id":     {s.googleClientID},
		"client_secret": {s.googleSecret},
		"redirect_uri":  {""},
		"grant_type":    {"authorization_code"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://oauth2.googleapis.com/token", strings.NewReader(body.Encode()))
	if err != nil {
		return "", fmt.Errorf("google token exchange: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := s.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("google token exchange: request: %w", err)
	}
	defer resp.Body.Close()

	var gr struct {
		IDToken string `json:"id_token"`
		Error   string `json:"error"`
		ErrorDesc string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&gr); err != nil {
		return "", fmt.Errorf("google token exchange: decode: %w", err)
	}
	if resp.StatusCode != http.StatusOK || gr.IDToken == "" {
		if gr.ErrorDesc != "" {
			return "", fmt.Errorf("google token exchange: %s: %s", gr.Error, gr.ErrorDesc)
		}
		return "", fmt.Errorf("google token exchange: status %s, no id_token", resp.Status)
	}
	return gr.IDToken, nil
}

// LinkSocialIdentity links a provider identity to the Keycloak account identified
// by kcUserID. provider must be the Keycloak IdP alias ("apple", "google", or
// "microsoft").
// providerToken is the raw JWT from the provider.
func (s *AuthService) LinkSocialIdentity(ctx context.Context, kcUserID, provider, providerToken string) error {
	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return fmt.Errorf("link social: admin token: %w", err)
	}

	// Decode the provider token claims to get the subject (provider user ID).
	parts := strings.SplitN(providerToken, ".", 3)
	if len(parts) != 3 {
		return fmt.Errorf("link social: malformed provider token")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return fmt.Errorf("link social: decode payload: %w", err)
	}
	var claims struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return fmt.Errorf("link social: parse claims: %w", err)
	}

	type idpLink struct {
		IdentityProvider string `json:"identityProvider"`
		UserID           string `json:"userId"`
		UserName         string `json:"userName"`
	}
	link := idpLink{
		IdentityProvider: provider,
		UserID:           claims.Sub,
		UserName:         claims.Email,
	}
	body, err := json.Marshal(link)
	if err != nil {
		return err
	}

	endpoint := fmt.Sprintf("%s/admin/realms/%s/users/%s/federated-identity/%s",
		s.kcURL, s.kcRealm, kcUserID, provider)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+adminToken)

	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("keycloak link identity: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusConflict {
		return fmt.Errorf("provider identity already linked")
	}
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("keycloak link identity returned %s: %s", resp.Status, string(b))
	}
	return nil
}

// UnlinkSocialIdentity removes a provider link from the given Keycloak account.
func (s *AuthService) UnlinkSocialIdentity(ctx context.Context, kcUserID, provider string) error {
	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return fmt.Errorf("unlink social: admin token: %w", err)
	}

	endpoint := fmt.Sprintf("%s/admin/realms/%s/users/%s/federated-identity/%s",
		s.kcURL, s.kcRealm, kcUserID, provider)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+adminToken)

	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("keycloak unlink identity: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("keycloak unlink identity returned %s: %s", resp.Status, string(b))
	}
	return nil
}

// kcUpdateUsername fetches the current Keycloak UserRepresentation, sets the new
// username in-place, and PUTs the full object back. PUT /users/{id} is a full
// replacement — sending only {"username":"x"} would wipe other fields.
func (s *AuthService) kcUpdateUsername(ctx context.Context, adminToken, userID, newUsername string) error {
	endpoint := fmt.Sprintf("%s/admin/realms/%s/users/%s", s.kcURL, s.kcRealm, userID)

	// Fetch current representation.
	getReq, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	getReq.Header.Set("Authorization", "Bearer "+adminToken)

	getResp, err := s.http.Do(getReq)
	if err != nil {
		return fmt.Errorf("keycloak get user: %w", err)
	}
	defer getResp.Body.Close()
	if getResp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(getResp.Body)
		return fmt.Errorf("keycloak get user returned %s: %s", getResp.Status, string(b))
	}

	var rep map[string]json.RawMessage
	if err := json.NewDecoder(getResp.Body).Decode(&rep); err != nil {
		return fmt.Errorf("keycloak decode user: %w", err)
	}

	// Update only the username field.
	newUsernameJSON, _ := json.Marshal(newUsername)
	rep["username"] = newUsernameJSON

	body, err := json.Marshal(rep)
	if err != nil {
		return err
	}

	putReq, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	putReq.Header.Set("Content-Type", "application/json")
	putReq.Header.Set("Authorization", "Bearer "+adminToken)

	putResp, err := s.http.Do(putReq)
	if err != nil {
		return fmt.Errorf("keycloak put user: %w", err)
	}
	defer putResp.Body.Close()

	if putResp.StatusCode == http.StatusConflict {
		return fmt.Errorf("username %q is already taken", newUsername)
	}
	if putResp.StatusCode != http.StatusNoContent {
		b, _ := io.ReadAll(putResp.Body)
		return fmt.Errorf("keycloak put user returned %s: %s", putResp.Status, string(b))
	}
	return nil
}

// ── Group membership ──────────────────────────────────────────────────────────

// AddUserToGroupByName adds the user (looked up by preferred_username) to
// the named realm group. Used by the payments flow to flip a user to the
// "premium" group after a successful PayPal capture so subsequent JWTs
// carry the premium realm role.
func (s *AuthService) AddUserToGroupByName(ctx context.Context, username, groupName string) error {
	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return fmt.Errorf("group add: admin token: %w", err)
	}
	userID, err := s.kcFindUserByUsername(ctx, adminToken, username)
	if err != nil || userID == "" {
		return fmt.Errorf("group add: find user %q: %w", username, err)
	}
	groupID, err := s.kcFindGroupByName(ctx, adminToken, groupName)
	if err != nil || groupID == "" {
		return fmt.Errorf("group add: find group %q: %w", groupName, err)
	}
	endpoint := fmt.Sprintf("%s/admin/realms/%s/users/%s/groups/%s", s.kcURL, s.kcRealm, userID, groupID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+adminToken)
	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("keycloak group put: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("keycloak group put returned %s: %s", resp.Status, string(b))
	}
	return nil
}

// RemoveUserFromGroupByName removes the user from the named realm group.
// Counterpart to AddUserToGroupByName used by the payment refund / dispute
// handler. Idempotent: removing a user that isn't in the group is a no-op.
func (s *AuthService) RemoveUserFromGroupByName(ctx context.Context, username, groupName string) error {
	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return fmt.Errorf("group remove: admin token: %w", err)
	}
	userID, err := s.kcFindUserByUsername(ctx, adminToken, username)
	if err != nil || userID == "" {
		return fmt.Errorf("group remove: find user %q: %w", username, err)
	}
	groupID, err := s.kcFindGroupByName(ctx, adminToken, groupName)
	if err != nil || groupID == "" {
		return fmt.Errorf("group remove: find group %q: %w", groupName, err)
	}
	endpoint := fmt.Sprintf("%s/admin/realms/%s/users/%s/groups/%s", s.kcURL, s.kcRealm, userID, groupID)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+adminToken)
	resp, err := s.http.Do(req)
	if err != nil {
		return fmt.Errorf("keycloak group delete: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("keycloak group delete returned %s: %s", resp.Status, string(b))
	}
	return nil
}

// kcFindGroupByName resolves a realm group's ID by exact name. Returns an
// empty string (no error) when not found so the caller can distinguish
// missing-group from transport errors.
func (s *AuthService) kcFindGroupByName(ctx context.Context, adminToken, name string) (string, error) {
	endpoint := fmt.Sprintf("%s/admin/realms/%s/groups?search=%s&exact=true",
		s.kcURL, s.kcRealm, url.QueryEscape(name))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+adminToken)
	resp, err := s.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("keycloak group search: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("keycloak group search returned %s", resp.Status)
	}
	var groups []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&groups); err != nil {
		return "", err
	}
	for _, g := range groups {
		if g.Name == name {
			return g.ID, nil
		}
	}
	return "", nil
}

