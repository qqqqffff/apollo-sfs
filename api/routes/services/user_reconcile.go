package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// ── Duplicate account reconciliation ─────────────────────────────────────────
//
// Before usernames/emails were canonicalized, an account stored with the case
// the user typed ("Zoe" / "Zoe@x.com") was never matched by Keycloak's
// lower-cased token, so its next login provisioned a second row; a rename that
// reached Keycloak but not the app DB did the same. UserReconcileService finds
// those groups and folds each into one account — see docs/duplicate_accounts.md.

// IdentityDirectory resolves usernames to Keycloak identities (*AuthService).
type IdentityDirectory interface {
	LookupIdentity(ctx context.Context, username string) (*KeycloakIdentity, error)
}

// ObjectRekeyer re-encrypts a merged account's blobs (*FileService).
type ObjectRekeyer interface {
	RekeyUserObjects(ctx context.Context, userID uuid.UUID, usernames []string, current []byte, previous [][]byte) (*RekeyResult, error)
	UnwrapUserKey(encryptedKey, nonce []byte, masterKeyVersion string) ([]byte, error)
	ForgetUsers(usernames ...string)
}

var (
	_ IdentityDirectory = (*AuthService)(nil)
	_ ObjectRekeyer     = (*FileService)(nil)
)

// ErrUserReconcileRunning is returned by Start while a run is in progress.
var ErrUserReconcileRunning = errors.New("duplicate account reconciliation is already running")

// DuplicateAccount is one users row in a DuplicateGroup.
type DuplicateAccount struct {
	Username          string     `json:"username"`
	Email             string     `json:"email"`
	IsAdmin           bool       `json:"is_admin"`
	IsPremium         bool       `json:"is_premium"`
	PremiumExpiresAt  *time.Time `json:"premium_expires_at,omitempty"`
	StorageQuotaBytes int64      `json:"storage_quota_bytes"`
	StorageUsedBytes  int64      `json:"storage_used_bytes"`
	Allocations       int        `json:"allocations"`
	CreatedAt         time.Time  `json:"created_at"`
	LastSeenAt        *time.Time `json:"last_seen_at,omitempty"`
	// Keep marks the row that survives; the others are folded into it.
	Keep bool `json:"keep"`
}

// DuplicateGroup is a set of rows that are one person, or a single row stored
// in a spelling Keycloak never issues.
type DuplicateGroup struct {
	// Action is "merge" (several rows → one) or "normalize" (one row whose
	// username/email just needs lower-casing).
	Action   string             `json:"action"`
	Accounts []DuplicateAccount `json:"accounts"`
	// The account as it will be after reconciliation.
	Username   string `json:"username"`
	Email      string `json:"email"`
	QuotaBytes int64  `json:"quota_bytes"`
	KeycloakID string `json:"keycloak_id,omitempty"`
	// Blocker, when set, says why this group can't be reconciled automatically.
	Blocker string `json:"blocker,omitempty"`
}

// survivor returns the row being kept and the rows being merged into it.
func (g *DuplicateGroup) survivor() (keep string, merged []string) {
	for _, a := range g.Accounts {
		if a.Keep {
			keep = a.Username
		} else {
			merged = append(merged, a.Username)
		}
	}
	return keep, merged
}

// DuplicateOutcome records what a run did with one group.
type DuplicateOutcome struct {
	DuplicateGroup
	// Status is "merged", "normalized", "skipped" (had a Blocker) or "failed".
	Status string       `json:"status"`
	Error  string       `json:"error,omitempty"`
	Rekey  *RekeyResult `json:"rekey,omitempty"`
}

// UserReconcileReport is the state of the latest (or current) run.
type UserReconcileReport struct {
	Running    bool               `json:"running"`
	StartedBy  string             `json:"started_by"`
	StartedAt  time.Time          `json:"started_at"`
	FinishedAt *time.Time         `json:"finished_at,omitempty"`
	Outcomes   []DuplicateOutcome `json:"outcomes"`
	// IndexesCreated is true once no duplicate remains and the
	// case-insensitive unique indexes are in place.
	IndexesCreated bool   `json:"indexes_created"`
	Error          string `json:"error,omitempty"`
}

// accountMergeDetails is the Details payload of an account_merged /
// account_normalized audit entry.
type accountMergeDetails struct {
	MergedAccounts   []DuplicateAccount `json:"merged_accounts"`
	PreviousUsername string             `json:"previous_username,omitempty"`
	Username         string             `json:"username"`
	Email            string             `json:"email"`
	QuotaBytes       int64              `json:"quota_bytes"`
	Rekey            *RekeyResult       `json:"rekey,omitempty"`
}

// userReconcileQuerier is the slice of *db.Queries the service needs.
type userReconcileQuerier interface {
	ListUserIdentityConflicts(ctx context.Context) ([]models.User, error)
	CountUserAllocations(ctx context.Context, username string) (int, error)
	CountLiveSubscriptions(ctx context.Context, usernames []string) (int, error)
	GetUserByUsername(ctx context.Context, username string) (*models.User, error)
	MergeUsers(ctx context.Context, p db.MergeUsersParams) error
	EnsureUserIdentityIndexes(ctx context.Context) error
	InsertAuditLog(ctx context.Context, in db.AuditInput) error
}

// UserReconcileService finds and folds duplicate accounts.
type UserReconcileService struct {
	queries userReconcileQuerier
	idp     IdentityDirectory
	objects ObjectRekeyer

	mu     sync.Mutex
	report *UserReconcileReport
}

// NewUserReconcileService wires the service.
func NewUserReconcileService(q *db.Queries, idp IdentityDirectory, objects ObjectRekeyer) *UserReconcileService {
	return &UserReconcileService{queries: q, idp: idp, objects: objects}
}

// Preview lists every group a run would act on and what it would do, without
// changing anything.
func (s *UserReconcileService) Preview(ctx context.Context) ([]DuplicateGroup, error) {
	users, err := s.queries.ListUserIdentityConflicts(ctx)
	if err != nil {
		return nil, err
	}
	groups := make([]DuplicateGroup, 0)
	for _, members := range groupIdentities(users) {
		g, err := s.plan(ctx, members)
		if err != nil {
			return nil, err
		}
		groups = append(groups, *g)
	}
	return groups, nil
}

// Status returns the latest run's report, or nil if none has run since start.
func (s *UserReconcileService) Status() *UserReconcileReport {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.report == nil {
		return nil
	}
	cp := *s.report
	cp.Outcomes = append([]DuplicateOutcome(nil), s.report.Outcomes...)
	return &cp
}

// Start launches a run in the background. Re-encrypting a merged account's
// files can take a while, far longer than an HTTP request should wait.
func (s *UserReconcileService) Start(actor string) error {
	s.mu.Lock()
	if s.report != nil && s.report.Running {
		s.mu.Unlock()
		return ErrUserReconcileRunning
	}
	s.report = &UserReconcileReport{Running: true, StartedBy: actor, StartedAt: time.Now()}
	s.mu.Unlock()

	go func() {
		err := s.run(context.Background(), actor)
		s.mu.Lock()
		defer s.mu.Unlock()
		now := time.Now()
		s.report.Running = false
		s.report.FinishedAt = &now
		if err != nil {
			s.report.Error = err.Error()
		}
	}()
	return nil
}

// run reconciles synchronously (Start's goroutine, and tests).
func (s *UserReconcileService) run(ctx context.Context, actor string) error {
	groups, err := s.Preview(ctx)
	if err != nil {
		return err
	}
	for i := range groups {
		out := s.reconcileGroup(ctx, &groups[i], actor)
		s.mu.Lock()
		s.report.Outcomes = append(s.report.Outcomes, out)
		s.mu.Unlock()
	}

	// Only duplicates stop the indexes; a lone row that still has a mixed-case
	// spelling (skipped for want of a Keycloak login) doesn't collide with
	// anything. Creating them fails harmlessly while a duplicate remains.
	if err := s.queries.EnsureUserIdentityIndexes(ctx); err != nil {
		log.Printf("reconcile duplicates: unique indexes not created yet: %v", err)
		return nil
	}
	s.mu.Lock()
	s.report.IndexesCreated = true
	s.mu.Unlock()
	return nil
}

func (s *UserReconcileService) reconcileGroup(ctx context.Context, g *DuplicateGroup, actor string) DuplicateOutcome {
	out := DuplicateOutcome{DuplicateGroup: *g}
	if g.Blocker != "" {
		out.Status = "skipped"
		return out
	}
	keep, merged := g.survivor()
	all := append([]string{keep}, merged...)

	if len(merged) > 0 {
		rekey, err := s.rekey(ctx, g, keep, merged)
		out.Rekey = rekey
		if err != nil {
			out.Status, out.Error = "failed", "re-encrypting files: "+err.Error()
			log.Printf("reconcile duplicates %v: %s", all, out.Error)
			return out
		}
	}

	if err := s.queries.MergeUsers(ctx, db.MergeUsersParams{
		Survivor: keep, Merged: merged, Canonical: g.Username, Email: g.Email, MergedBy: actor,
	}); err != nil {
		out.Status, out.Error = "failed", err.Error()
		log.Printf("reconcile duplicates %v: %v", all, err)
		return out
	}
	s.objects.ForgetUsers(append(all, g.Username)...)

	action := "account_merged"
	out.Status = "merged"
	if len(merged) == 0 {
		action, out.Status = "account_normalized", "normalized"
	}
	d := accountMergeDetails{MergedAccounts: g.Accounts, Username: g.Username, Email: g.Email, QuotaBytes: g.QuotaBytes, Rekey: out.Rekey}
	if keep != g.Username {
		d.PreviousUsername = keep
	}
	raw, _ := json.Marshal(d)
	name := strings.Join(all, ", ") + " → " + g.Username
	if err := s.queries.InsertAuditLog(ctx, db.AuditInput{
		TargetUsername: g.Username, ActorUsername: actor, Action: action,
		ResourceType: strPtrSvc("user"), ResourceName: &name, Details: raw,
	}); err != nil {
		log.Printf("reconcile duplicates: audit log: %v", err)
	}
	return out
}

// rekey moves every blob sealed with a merged row's key onto the survivor's.
func (s *UserReconcileService) rekey(ctx context.Context, g *DuplicateGroup, keep string, merged []string) (*RekeyResult, error) {
	sub, err := uuid.Parse(g.KeycloakID)
	if err != nil {
		return nil, fmt.Errorf("keycloak id %q: %w", g.KeycloakID, err)
	}
	unwrap := func(username string) ([]byte, error) {
		u, err := s.queries.GetUserByUsername(ctx, username)
		if err != nil {
			return nil, err
		}
		return s.objects.UnwrapUserKey(u.EncryptedKey, u.KeyNonce, u.MasterKeyVersion)
	}
	current, err := unwrap(keep)
	if err != nil {
		return nil, fmt.Errorf("unwrap %q key: %w", keep, err)
	}
	defer zeroBytes(current)
	var previous [][]byte
	for _, m := range merged {
		k, err := unwrap(m)
		if err != nil {
			return nil, fmt.Errorf("unwrap %q key: %w", m, err)
		}
		defer zeroBytes(k)
		previous = append(previous, k)
	}
	return s.objects.RekeyUserObjects(ctx, sub, append([]string{keep}, merged...), current, previous)
}

// plan decides what to do with one group of rows.
func (s *UserReconcileService) plan(ctx context.Context, members []models.User) (*DuplicateGroup, error) {
	g := &DuplicateGroup{Action: "normalize"}
	if len(members) > 1 {
		g.Action = "merge"
	}
	names := make([]string, 0, len(members))
	for _, u := range members {
		n, err := s.queries.CountUserAllocations(ctx, u.Username)
		if err != nil {
			return nil, err
		}
		g.Accounts = append(g.Accounts, DuplicateAccount{
			Username: u.Username, Email: u.Email, IsAdmin: u.IsAdmin, IsPremium: u.IsPremium,
			PremiumExpiresAt: u.PremiumExpiresAt, StorageQuotaBytes: u.StorageQuotaBytes,
			StorageUsedBytes: u.StorageUsedBytes, Allocations: n,
			CreatedAt: u.CreatedAt, LastSeenAt: u.LastSeenAt,
		})
		names = append(names, u.Username)
	}

	// Which Keycloak login do these rows belong to? Keycloak compares
	// usernames ignoring case, so look each distinct spelling up once.
	idents := map[string]*KeycloakIdentity{}
	seen := map[string]bool{}
	for _, u := range members {
		key := strings.ToLower(u.Username)
		if seen[key] {
			continue
		}
		seen[key] = true
		ident, err := s.idp.LookupIdentity(ctx, u.Username)
		if err != nil {
			return nil, fmt.Errorf("look up %q in keycloak: %w", u.Username, err)
		}
		if ident != nil {
			idents[ident.ID] = ident
		}
	}
	var ident *KeycloakIdentity
	switch len(idents) {
	case 0:
		g.Blocker = "no Keycloak login matches any of these usernames, so there is no way to tell which spelling is current"
	case 1:
		for _, v := range idents {
			ident = v
		}
	default:
		g.Blocker = "these rows belong to different Keycloak logins — they are separate people sharing an email address, not a duplicate"
	}

	keep := pickSurvivor(g.Accounts, ident)
	g.Accounts[keep].Keep = true
	if ident != nil {
		g.KeycloakID = ident.ID
		g.Username = ident.Username
		g.Email = ident.Email
	} else {
		g.Username = strings.ToLower(g.Accounts[keep].Username)
	}
	if g.Email == "" {
		g.Email = strings.ToLower(g.Accounts[keep].Email)
	}

	allocs := map[string]int{}
	for _, a := range g.Accounts {
		allocs[a.Username] = a.Allocations
	}
	g.QuotaBytes = db.MergedQuota(members, allocs)
	if len(members) == 1 {
		g.QuotaBytes = members[0].StorageQuotaBytes
	}

	if g.Blocker == "" && len(members) > 1 {
		live, err := s.queries.CountLiveSubscriptions(ctx, names)
		if err != nil {
			return nil, err
		}
		if live > 1 {
			g.Blocker = db.ErrMergeLiveSubscriptions.Error()
		}
	}
	return g, nil
}

// pickSurvivor chooses the row to keep: the one already spelled the way
// Keycloak spells it (it's the row every current token resolves to, so its key
// is the one live uploads are using), else the most recently active one.
func pickSurvivor(accounts []DuplicateAccount, ident *KeycloakIdentity) int {
	best := 0
	for i := range accounts {
		if ident != nil && accounts[i].Username == ident.Username {
			return i
		}
		if laterSeen(accounts[i].LastSeenAt, accounts[best].LastSeenAt) {
			best = i
		}
	}
	return best
}

func laterSeen(a, b *time.Time) bool {
	switch {
	case a == nil:
		return false
	case b == nil:
		return true
	default:
		return a.After(*b)
	}
}

// groupIdentities partitions rows into groups that share a username or an email
// ignoring case (transitively: a~b by username and b~c by email is one group).
func groupIdentities(users []models.User) [][]models.User {
	parent := make([]int, len(users))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		if parent[i] != i {
			parent[i] = find(parent[i])
		}
		return parent[i]
	}
	byKey := map[string]int{}
	for i, u := range users {
		for _, k := range []string{"u:" + strings.ToLower(u.Username), "e:" + strings.ToLower(u.Email)} {
			if j, ok := byKey[k]; ok {
				parent[find(i)] = find(j)
			} else {
				byKey[k] = i
			}
		}
	}
	buckets := map[int][]models.User{}
	var order []int
	for i := range users {
		r := find(i)
		if _, ok := buckets[r]; !ok {
			order = append(order, r)
		}
		buckets[r] = append(buckets[r], users[i])
	}
	sort.Ints(order)
	out := make([][]models.User, 0, len(order))
	for _, r := range order {
		out = append(out, buckets[r])
	}
	return out
}

func strPtrSvc(s string) *string { return &s }
