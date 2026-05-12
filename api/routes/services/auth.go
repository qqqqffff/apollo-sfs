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
	queries    *db.Queries
	kcURL      string
	kcRealm    string
	kcClientID string
	kcSecret   string
	appBaseURL string
	http       *http.Client

	// ProvisionUserKey is called during registration to generate and wrap the
	// user's per-file AES key with the current master key. When nil (before the
	// encryption service is wired in), random placeholder bytes are stored and
	// must be replaced before the user can upload files.
	ProvisionUserKey func(ctx context.Context) (encryptedKey, nonce []byte, masterKeyVersion string, err error)
}

// NewAuthService constructs an AuthService with a 10-second HTTP timeout.
func NewAuthService(q *db.Queries, cfg AuthServiceConfig) *AuthService {
	return &AuthService{
		queries:    q,
		kcURL:      cfg.KeycloakURL,
		kcRealm:    cfg.KeycloakRealm,
		kcClientID: cfg.KeycloakClientID,
		kcSecret:   cfg.KeycloakClientSecret,
		appBaseURL: strings.TrimRight(cfg.AppBaseURL, "/"),
		http:       &http.Client{Timeout: 10 * time.Second},
	}
}

// ── Public methods ────────────────────────────────────────────────────────────

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

// Register creates a user in Keycloak via the Admin API, provisions an app DB
// record, validates and marks the invitation token used, then logs the user in.
//
// The invitation token must correspond to a pending, non-expired invitation for
// the given email address.
func (s *AuthService) Register(ctx context.Context, username, email, password, inviteToken string) (*TokenPair, error) {
	// 1. Validate invitation.
	inv, err := s.queries.GetInvitationByToken(ctx, inviteToken)
	if err != nil {
		return nil, fmt.Errorf("register: invalid or expired invitation")
	}
	if inv.Email != email {
		return nil, fmt.Errorf("register: email does not match invitation")
	}
	if time.Now().After(inv.TokenExpiresAt) {
		return nil, fmt.Errorf("register: invitation has expired")
	}

	// 2. Create user in Keycloak.
	adminToken, err := s.adminToken(ctx)
	if err != nil {
		return nil, fmt.Errorf("register: get admin token: %w", err)
	}
	if err := s.kcCreateUser(ctx, adminToken, username, email, password); err != nil {
		return nil, fmt.Errorf("register: create keycloak user: %w", err)
	}

	// 3. Provision encryption key.
	if s.ProvisionUserKey == nil {
		return nil, fmt.Errorf("register: encryption service not wired")
	}
	encKey, nonce, masterKeyVer, err := s.ProvisionUserKey(ctx)
	if err != nil {
		return nil, fmt.Errorf("register: provision key: %w", err)
	}

	// 4. Create app DB record. Use the quota set on the invitation, falling back
	// to the server default if the invitation pre-dates the quota field.
	quotaBytes := inv.InitialQuotaBytes
	if quotaBytes <= 0 {
		quotaBytes = defaultQuotaBytes
	}

	// Select the best-fit drive before creating the user so we can fail fast
	// if no drive has enough free capacity for the requested quota.
	drive, err := s.queries.SelectDriveForQuota(ctx, quotaBytes)
	if err != nil {
		if errors.Is(err, db.ErrNoCapacity) {
			return nil, fmt.Errorf("register: no drive has sufficient capacity for the requested quota")
		}
		return nil, fmt.Errorf("register: select drive: %w", err)
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
		return nil, fmt.Errorf("register: create db user: %w", err)
	}

	if err := s.queries.AllocateUserToDrive(ctx, username, drive.ID); err != nil {
		return nil, fmt.Errorf("register: allocate drive: %w", err)
	}

	// 5. Accept invitation.
	if err := s.queries.AcceptInvitation(ctx, inviteToken); err != nil {
		// Non-fatal: user and Keycloak account already created; log and continue.
		_ = err
	}

	// 6. Auto-login.
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

// kcCreateUser calls POST /admin/realms/{realm}/users to create the account.
func (s *AuthService) kcCreateUser(ctx context.Context, adminToken, username, email, password string) error {
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
		return err
	}

	endpoint := fmt.Sprintf("%s/admin/realms/%s/users", s.kcURL, s.kcRealm)
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

	if resp.StatusCode == http.StatusConflict {
		return fmt.Errorf("username or email already exists")
	}
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("keycloak returned %s: %s", resp.Status, string(b))
	}
	return nil
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
	PreferredUsername string `json:"preferred_username"`
	Email             string `json:"email"`
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

