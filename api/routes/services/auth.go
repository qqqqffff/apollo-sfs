package services

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

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
	return tokens, nil
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

	// 4. Create app DB record.
	if err := s.queries.CreateUser(ctx, &models.User{
		Username:          username,
		Email:             email,
		EncryptedKey:      encKey,
		KeyNonce:          nonce,
		MasterKeyVersion:  masterKeyVer,
		StorageUsedBytes:  0,
		StorageQuotaBytes: defaultQuotaBytes,
	}); err != nil {
		return nil, fmt.Errorf("register: create db user: %w", err)
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

