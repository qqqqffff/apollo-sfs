package services

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
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
	"golang.org/x/crypto/argon2"
	"golang.org/x/time/rate"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// keyPrefixBytes is the number of random bytes encoded into the public
// prefix half of an API key. 8 bytes → 11-char base64url (no padding).
// The prefix is what the lookup query uses, and what the user sees in the
// UI to identify their keys after issuance.
const keyPrefixBytes = 8

// keySecretBytes is the number of random bytes encoded into the secret half.
// 24 bytes → 32-char base64url (no padding) of entropy that the user must
// store; only its argon2id hash is persisted.
const keySecretBytes = 24

// Argon2id parameters. Chosen for fast verify against ~32-char input on
// commodity hardware: the SFS hot path runs Verify on every request.
const (
	argonTime    = 2
	argonMemory  = 32 * 1024 // 32 MiB
	argonThreads = 2
	argonKeyLen  = 32
)

// Per-key rate limit bounds (requests/minute against the SFS API).
// MaxRateLimitPerMin is the global ceiling no key may exceed, regardless of
// what the owner requests via the UI or API.
const (
	MinRateLimitPerMin     = 1
	MaxRateLimitPerMin     = 1000
	DefaultRateLimitPerMin = 300
)

// MaxAPIKeyTTL bounds how far out an explicit expiry may be set (10 years).
// A zero TTL / nil expiry ("no expiry") is unaffected — this only bounds a
// finite one. Mirrors the routes/api_keys.go request binding (max=3650) so
// the limit also holds for any caller that reaches Issue/Update directly.
const MaxAPIKeyTTL = 3650 * 24 * time.Hour

// Sentinel errors. Callers should treat them as 401s unless noted.
var (
	ErrAPIKeyMalformed     = errors.New("api key: malformed token")
	ErrAPIKeyNotFound      = errors.New("api key: not found")
	ErrAPIKeyRevoked       = errors.New("api key: revoked")
	ErrAPIKeyExpired       = errors.New("api key: expired")
	ErrAPIKeyOwnerNotFound = errors.New("api key: owner not found")
)

// APIKeyService issues, verifies, lists, and revokes SFS API keys.
// All persistence runs through db.Queries; argon2id parameters are package
// constants. The pepper is loaded once at construction and mixed into the
// hash so a stolen database cannot be brute-forced offline.
//
// It also owns the per-key rate limiters enforced by the SFS middleware
// (Allow). These are in-memory only — safe because every Swarm service in
// docker-stack.yml runs a single replica (see api/CLAUDE.md); a multi-replica
// deployment would need a shared store (e.g. Redis) instead.
type APIKeyService struct {
	queries *db.Queries
	pepper  []byte

	limiterMu sync.Mutex
	limiters  map[uuid.UUID]*keyLimiter
}

// keyLimiter pairs a token-bucket limiter with the rate it was built at (so
// Allow can detect an edit changed the limit) and the last time it was used
// (so the background sweep can evict idle entries).
type keyLimiter struct {
	limiter    *rate.Limiter
	perMin     int
	lastAccess time.Time
}

// keyLimiterTTL/keyLimiterSweepInterval mirror the eviction pattern in
// routes/middleware/rate_limit.go so idle keys' limiters don't accumulate
// forever in memory.
const (
	keyLimiterTTL           = 10 * time.Minute
	keyLimiterSweepInterval = 5 * time.Minute
)

// NewAPIKeyService constructs the service. pepper must be at least 32 bytes
// of random data sourced from SFS_API_KEY_PEPPER; the constructor panics on
// shorter input because that's a deployment misconfiguration, not a runtime
// error path the caller can recover from.
func NewAPIKeyService(q *db.Queries, pepper []byte) *APIKeyService {
	if len(pepper) < 32 {
		panic("api key service: SFS_API_KEY_PEPPER must be at least 32 bytes")
	}
	s := &APIKeyService{queries: q, pepper: pepper, limiters: make(map[uuid.UUID]*keyLimiter)}
	go s.sweepLimiters()
	return s
}

func (s *APIKeyService) sweepLimiters() {
	ticker := time.NewTicker(keyLimiterSweepInterval)
	defer ticker.Stop()
	for range ticker.C {
		cutoff := time.Now().Add(-keyLimiterTTL)
		s.limiterMu.Lock()
		for id, l := range s.limiters {
			if l.lastAccess.Before(cutoff) {
				delete(s.limiters, id)
			}
		}
		s.limiterMu.Unlock()
	}
}

// Allow reports whether keyID may make another request right now, given its
// current rate_limit_per_min. Builds (or rebuilds, if the rate changed since
// last seen — e.g. via Update) a token-bucket limiter per key, burst equal to
// the per-minute rate so a key can spend its whole allowance immediately
// after being idle, then must trickle in at the sustained rate.
func (s *APIKeyService) Allow(keyID uuid.UUID, ratePerMin int) bool {
	if ratePerMin <= 0 {
		ratePerMin = DefaultRateLimitPerMin
	}
	s.limiterMu.Lock()
	l, ok := s.limiters[keyID]
	if !ok || l.perMin != ratePerMin {
		l = &keyLimiter{
			limiter: rate.NewLimiter(rate.Limit(float64(ratePerMin)/60.0), ratePerMin),
			perMin:  ratePerMin,
		}
		s.limiters[keyID] = l
	}
	l.lastAccess = time.Now()
	limiter := l.limiter
	s.limiterMu.Unlock()
	return limiter.Allow()
}

// resetLimiter drops keyID's cached limiter so the next Allow call rebuilds
// it — used after Update in case the rate limit changed but Allow hasn't
// happened to notice via the perMin check yet (e.g. immediately after a
// large decrease, we want the new, smaller burst to apply right away rather
// than after the old limiter drains).
func (s *APIKeyService) resetLimiter(keyID uuid.UUID) {
	s.limiterMu.Lock()
	delete(s.limiters, keyID)
	s.limiterMu.Unlock()
}

// normalizeRateLimit applies the "0 means default" convention and enforces
// [MinRateLimitPerMin, MaxRateLimitPerMin].
func normalizeRateLimit(perMin int) (int, error) {
	if perMin == 0 {
		return DefaultRateLimitPerMin, nil
	}
	if perMin < MinRateLimitPerMin || perMin > MaxRateLimitPerMin {
		return 0, fmt.Errorf("api key: rate_limit_per_min must be between %d and %d", MinRateLimitPerMin, MaxRateLimitPerMin)
	}
	return perMin, nil
}

// IssuedKey is the once-only issuance result. RawKey is the only place the
// secret half is materialised; the caller must show it to the user
// immediately and never persist it.
type IssuedKey struct {
	RawKey string
	Key    *models.APIKey
}

// IssueInput is the user-facing parameter set for Issue.
type IssueInput struct {
	Username        string
	Name            string
	Scopes          []models.APIKeyScope
	TTL             time.Duration // 0 → no expiry
	RateLimitPerMin int           // 0 → DefaultRateLimitPerMin
}

// Issue generates a new API key, persists it (plus its scopes) inside a
// ForUser transaction, and returns the raw token to the caller exactly once.
//
// Token shape: `sfs_<prefix>_<secret>` — both halves base64url-encoded.
// Prefix is stored verbatim for lookup; secret is hashed with argon2id over
// (secret || pepper). The split lets Verify hit a UNIQUE index instead of
// scanning every key.
func (s *APIKeyService) Issue(ctx context.Context, userID uuid.UUID, in IssueInput) (*IssuedKey, error) {
	if len(in.Scopes) == 0 {
		return nil, errors.New("api key: at least one scope is required")
	}
	for _, sc := range in.Scopes {
		if _, ok := validOperations[sc.Operation]; !ok {
			return nil, fmt.Errorf("api key: invalid operation %q", sc.Operation)
		}
	}
	rateLimit, err := normalizeRateLimit(in.RateLimitPerMin)
	if err != nil {
		return nil, err
	}
	if in.TTL > MaxAPIKeyTTL {
		return nil, fmt.Errorf("api key: ttl_days must be at most %d", int(MaxAPIKeyTTL/(24*time.Hour)))
	}
	prefix, secret, err := generateKeyHalves()
	if err != nil {
		return nil, fmt.Errorf("api key: generate: %w", err)
	}
	hash := s.hash(secret)

	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("api key: tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var expires *time.Time
	if in.TTL > 0 {
		t := time.Now().Add(in.TTL).UTC()
		expires = &t
	}
	stored, err := q.CreateAPIKey(ctx, db.CreateAPIKeyInput{
		Username:        in.Username,
		Name:            in.Name,
		KeyPrefix:       prefix,
		KeyHash:         hash,
		Scopes:          in.Scopes,
		ExpiresAt:       expires,
		RateLimitPerMin: rateLimit,
	})
	if err != nil {
		return nil, fmt.Errorf("api key: persist: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("api key: commit: %w", err)
	}
	return &IssuedKey{
		RawKey: "sfs_" + prefix + "_" + secret,
		Key:    stored,
	}, nil
}

// VerifyResult is the success payload of Verify.
type VerifyResult struct {
	Key    *models.APIKey
	Scopes []models.APIKeyScope
	User   *models.User
}

// Verify parses raw, locates the key by its prefix, performs a constant-time
// hash check on the secret half, and asserts the key is still active and
// owned by an existing premium-eligible user. Touches last_used_at
// fire-and-forget on success.
//
// Caller responsibility: enforcing the "user is premium or admin" check
// after Verify. The user record returned carries IsAdmin and IsPremium so
// the middleware can decide.
func (s *APIKeyService) Verify(ctx context.Context, raw string) (*VerifyResult, error) {
	prefix, secret, err := parseRawKey(raw)
	if err != nil {
		return nil, err
	}
	key, err := s.queries.GetAPIKeyByPrefix(ctx, prefix)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrAPIKeyNotFound
		}
		return nil, fmt.Errorf("api key: lookup: %w", err)
	}
	if key.RevokedAt != nil {
		return nil, ErrAPIKeyRevoked
	}
	if key.ExpiresAt != nil && key.ExpiresAt.Before(time.Now()) {
		return nil, ErrAPIKeyExpired
	}

	expected := s.hash(secret)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(key.KeyHash)) != 1 {
		return nil, ErrAPIKeyNotFound
	}

	user, err := s.queries.GetUserByUsername(ctx, key.Username)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrAPIKeyOwnerNotFound
		}
		return nil, fmt.Errorf("api key: load owner: %w", err)
	}

	scopes, err := s.queries.GetAPIKeyScopes(ctx, key.ID)
	if err != nil {
		return nil, fmt.Errorf("api key: load scopes: %w", err)
	}

	// Fire-and-forget touch. Failure is logged but does not block the request.
	go func(id uuid.UUID) {
		c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := s.queries.TouchAPIKeyLastUsed(c, id); err != nil {
			log.Printf("APIKeyService.Verify: touch last_used_at for %s: %v", id, err)
		}
	}(key.ID)

	return &VerifyResult{Key: key, Scopes: scopes, User: user}, nil
}

// List returns the calling user's keys with scopes populated.
func (s *APIKeyService) List(ctx context.Context, userID uuid.UUID) ([]models.APIKey, error) {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	return q.ListAPIKeys(ctx)
}

// UpdateInput is the user-facing parameter set for Update. It mirrors
// IssueInput but targets an existing key — every field is replaced
// wholesale, matching the edit panel's "full form" UX (there is no partial
// PATCH semantics here).
type UpdateInput struct {
	Name            string
	Scopes          []models.APIKeyScope
	ExpiresAt       *time.Time // nil → no expiry
	RateLimitPerMin int        // 0 → DefaultRateLimitPerMin
}

// Update rewrites an existing key's name, scopes, expiry, and rate limit.
// RLS in ForUser ensures only the owner's key can be edited. Editing never
// touches key_prefix/key_hash — the raw secret shown at issuance keeps
// working against the new rules immediately.
func (s *APIKeyService) Update(ctx context.Context, userID, keyID uuid.UUID, in UpdateInput) (*models.APIKey, error) {
	if len(in.Scopes) == 0 {
		return nil, errors.New("api key: at least one scope is required")
	}
	for _, sc := range in.Scopes {
		if _, ok := validOperations[sc.Operation]; !ok {
			return nil, fmt.Errorf("api key: invalid operation %q", sc.Operation)
		}
	}
	rateLimit, err := normalizeRateLimit(in.RateLimitPerMin)
	if err != nil {
		return nil, err
	}
	if in.ExpiresAt != nil && in.ExpiresAt.After(time.Now().Add(MaxAPIKeyTTL)) {
		return nil, fmt.Errorf("api key: ttl_days must be at most %d", int(MaxAPIKeyTTL/(24*time.Hour)))
	}
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("api key: tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	updated, err := q.UpdateAPIKey(ctx, db.UpdateAPIKeyInput{
		ID:              keyID,
		Name:            in.Name,
		Scopes:          in.Scopes,
		ExpiresAt:       in.ExpiresAt,
		RateLimitPerMin: rateLimit,
	})
	if err != nil {
		return nil, fmt.Errorf("api key: update: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("api key: commit: %w", err)
	}
	// The rate limit may have changed; drop the cached limiter so the next
	// request rebuilds it at the new rate instead of finishing out the old
	// bucket's window.
	s.resetLimiter(keyID)
	return updated, nil
}

// Revoke marks the given key revoked. RLS in ForUser ensures only the
// owner's keys can be revoked; foreign IDs return ErrAPIKeyNotFound-shaped
// silence (no rows updated).
func (s *APIKeyService) Revoke(ctx context.Context, userID, keyID uuid.UUID) error {
	q, tx, err := s.queries.ForUser(ctx, userID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := q.RevokeAPIKey(ctx, keyID); err != nil {
		return err
	}
	return tx.Commit()
}

// Authorize returns true iff the supplied scopes grant `op` on `objectKey`.
// The object key is normalised (leading slashes stripped, lower-cased) before
// the prefix compare so user-input keys with `/foo` or `foo` both match a
// scope with prefix `foo`. An empty path_prefix grants the operation across
// the entire user namespace.
//
// "list" against a prefix is satisfied by either a "list" or a "read" scope
// that covers the same prefix — listing without reading is rarely useful
// and surfacing the distinction in the UI would add noise.
func (s *APIKeyService) Authorize(scopes []models.APIKeyScope, op, objectKey string) bool {
	normKey := normalizeKey(objectKey)
	for _, sc := range scopes {
		if !operationMatches(sc.Operation, op) {
			continue
		}
		if pathCovers(sc.PathPrefix, normKey) {
			return true
		}
	}
	return false
}

// MatchingOperations returns the set of operations the supplied scopes grant
// over `objectKey`. Used by the share-directory modal to show which keys
// already cover a folder so the user can decide whether to create one.
func (s *APIKeyService) MatchingOperations(scopes []models.APIKeyScope, objectKey string) []string {
	normKey := normalizeKey(objectKey)
	seen := map[string]bool{}
	out := []string{}
	for _, sc := range scopes {
		if seen[sc.Operation] {
			continue
		}
		if pathCovers(sc.PathPrefix, normKey) {
			seen[sc.Operation] = true
			out = append(out, sc.Operation)
		}
	}
	return out
}

// hash digests secret || pepper with argon2id and returns a base64-encoded
// fixed-width string. The salt is empty because the pepper provides the
// secret-side entropy and the secret itself is uniformly random — argon2id
// remains preimage-resistant in this regime, and a fixed empty salt lets the
// equality check be a simple constant-time byte compare.
func (s *APIKeyService) hash(secret string) string {
	in := append([]byte(secret), s.pepper...)
	sum := argon2.IDKey(in, nil, argonTime, argonMemory, argonThreads, argonKeyLen)
	return base64.RawStdEncoding.EncodeToString(sum)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

var validOperations = map[string]struct{}{
	"read":   {},
	"write":  {},
	"delete": {},
	"list":   {},
}

func generateKeyHalves() (prefix, secret string, err error) {
	pb := make([]byte, keyPrefixBytes)
	if _, err := io.ReadFull(rand.Reader, pb); err != nil {
		return "", "", err
	}
	sb := make([]byte, keySecretBytes)
	if _, err := io.ReadFull(rand.Reader, sb); err != nil {
		return "", "", err
	}
	return base64.RawURLEncoding.EncodeToString(pb),
		base64.RawURLEncoding.EncodeToString(sb), nil
}

func parseRawKey(raw string) (prefix, secret string, err error) {
	parts := strings.Split(raw, "_")
	if len(parts) != 3 || parts[0] != "sfs" || parts[1] == "" || parts[2] == "" {
		return "", "", ErrAPIKeyMalformed
	}
	return parts[1], parts[2], nil
}

// normalizeKey strips a single leading slash and lower-cases. Trailing
// slashes are preserved so a scope on "photos/" only covers "photos/..." and
// not "photographer".
func normalizeKey(s string) string {
	s = strings.ToLower(s)
	if strings.HasPrefix(s, "/") {
		s = s[1:]
	}
	return s
}

// pathCovers reports whether the (normalised) prefix dominates the
// (normalised) object key. Empty prefix covers everything. To prevent the
// "photos" prefix from leaking into "photographer", a non-trailing-slash
// prefix is treated as either an exact match or a directory boundary.
func pathCovers(prefix, key string) bool {
	prefix = normalizeKey(prefix)
	if prefix == "" {
		return true
	}
	if !strings.HasPrefix(key, prefix) {
		return false
	}
	if len(key) == len(prefix) {
		return true
	}
	// Boundary check: char after the prefix must be `/` so "photo" doesn't
	// match "photos/cat.jpg", but "photo/" does cover "photo/cat.jpg".
	if strings.HasSuffix(prefix, "/") {
		return true
	}
	return key[len(prefix)] == '/'
}

// operationMatches handles the "list ⊆ read" relationship described on
// Authorize.
func operationMatches(scope, requested string) bool {
	if scope == requested {
		return true
	}
	if requested == "list" && scope == "read" {
		return true
	}
	return false
}
