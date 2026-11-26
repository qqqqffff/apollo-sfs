package services

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	_ "github.com/lib/pq"
	"github.com/minio/minio-go/v7"

	"apollo-sfs.com/api/db"
)

// ── Real-Postgres harness (skipped unless configured; see db/user_merge_integration_test.go) ──

func identityTestDB(t *testing.T) (*db.Queries, *sql.DB) {
	t.Helper()
	server, template := os.Getenv("APOLLO_TEST_PG"), os.Getenv("APOLLO_TEST_TEMPLATE")
	if server == "" || template == "" {
		t.Skip("APOLLO_TEST_PG / APOLLO_TEST_TEMPLATE not set")
	}
	admin, err := sql.Open("postgres", server+" dbname=postgres")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close() })
	name := "it_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(fmt.Sprintf(`CREATE DATABASE %s TEMPLATE %s`, name, template)); err != nil {
		t.Fatalf("clone template: %v", err)
	}
	pool, err := sql.Open("postgres", server+" dbname="+name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(fmt.Sprintf(`DROP DATABASE IF EXISTS %s WITH (FORCE)`, name))
	})
	dbExec(t, pool, `DROP INDEX IF EXISTS users_username_lower_idx, users_email_lower_idx`)
	dbExec(t, pool, `INSERT INTO master_keys (id, encrypted_key_material, key_nonce, status) VALUES ('v1', '\x00', '\x00', 'active')`)
	return db.New(pool), pool
}

func dbExec(t *testing.T, pool *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(q, args...); err != nil {
		t.Fatalf("%v: %v", q, err)
	}
}

func usersIn(t *testing.T, pool *sql.DB) []string {
	t.Helper()
	rows, err := pool.Query(`SELECT username || '|' || email FROM users ORDER BY username`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		_ = rows.Scan(&s)
		out = append(out, s)
	}
	return out
}

// fakeKC is a Keycloak stand-in holding a set of users keyed by sub.
type fakeKC struct {
	mu    sync.Mutex
	users map[string]*kcUserResult // sub → user (username/email stored lower-cased, as Keycloak does)
	login string                   // sub the token endpoint issues tokens for
}

func (f *fakeKC) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/protocol/openid-connect/token"):
			u := f.users[f.login]
			claims, _ := json.Marshal(map[string]any{"sub": u.ID, "preferred_username": u.Username, "email": u.Email, "email_verified": true})
			fmt.Fprintf(w, `{"access_token":"h.%s.s"}`, base64.RawURLEncoding.EncodeToString(claims))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/users"):
			want := strings.ToLower(r.URL.Query().Get("username"))
			out := []kcUserResult{}
			for _, u := range f.users {
				if u.Username == want {
					out = append(out, *u)
				}
			}
			_ = json.NewEncoder(w).Encode(out)
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/users/"):
			u := f.users[r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]]
			_ = json.NewEncoder(w).Encode(map[string]string{"id": u.ID, "username": u.Username, "email": u.Email})
		case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/users/"):
			var rep map[string]any
			_ = json.NewDecoder(r.Body).Decode(&rep)
			f.users[r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]].Username = strings.ToLower(rep["username"].(string))
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected keycloak call %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newIdentityAuth(t *testing.T, q *db.Queries, kc *fakeKC) *AuthService {
	s := NewAuthService(q, AuthServiceConfig{KeycloakURL: kc.server(t).URL, KeycloakRealm: "r"})
	s.ProvisionUserKey = func(context.Context) ([]byte, []byte, string, error) {
		return []byte{9}, []byte{9}, "v1", nil
	}
	return s
}

func insertIdentityUser(t *testing.T, pool *sql.DB, username, email string) {
	dbExec(t, pool, `INSERT INTO users (username, email, encrypted_key, key_nonce, master_key_version, storage_quota_bytes)
		VALUES ($1, $2, '\x01', '\x01', 'v1', 5)`, username, email)
}

const zoeSub = "11111111-1111-1111-1111-111111111111"

// The account registered from a phone with autocapitalised fields: Keycloak
// holds "zoe", the app row "Zoe". Login used to add a second row.
func TestLoginHealsMixedCaseRowInsteadOfDuplicating(t *testing.T) {
	q, pool := identityTestDB(t)
	kc := &fakeKC{users: map[string]*kcUserResult{zoeSub: {ID: zoeSub, Username: "zoe", Email: "zoe@x.com"}}, login: zoeSub}
	s := newIdentityAuth(t, q, kc)
	insertIdentityUser(t, pool, "Zoe", "Zoe@x.com")

	if _, err := s.Login(t.Context(), "Zoe", "pw"); err != nil {
		t.Fatalf("Login: %v", err)
	}
	if got := usersIn(t, pool); len(got) != 1 || got[0] != "zoe|zoe@x.com" {
		t.Fatalf("users = %v, want the one row renamed to zoe|zoe@x.com", got)
	}
}

// An ex-subscriber renames: premium_subscriptions used to block the DB half of
// the rename after Keycloak had already changed, and the next login duplicated
// the account. Now the rename lands everywhere.
func TestRenameOfFormerSubscriberDoesNotDuplicate(t *testing.T) {
	q, pool := identityTestDB(t)
	kc := &fakeKC{users: map[string]*kcUserResult{zoeSub: {ID: zoeSub, Username: "zoe", Email: "zoe@x.com"}}, login: zoeSub}
	s := newIdentityAuth(t, q, kc)
	insertIdentityUser(t, pool, "zoe", "Zoe@x.com")
	dbExec(t, pool, `INSERT INTO premium_subscriptions (username, paypal_subscription_id, plan, status) VALUES ('zoe', 'I-1', 'monthly', 'expired')`)

	if err := s.RenameUser(t.Context(), "zoe", "Zoe2"); err != nil {
		t.Fatalf("RenameUser: %v", err)
	}
	if _, err := s.Login(t.Context(), "zoe2", "pw"); err != nil {
		t.Fatalf("Login: %v", err)
	}
	if got := usersIn(t, pool); len(got) != 1 || got[0] != "zoe2|zoe@x.com" {
		t.Fatalf("users = %v, want one row zoe2|zoe@x.com", got)
	}
	var subOwner string
	_ = pool.QueryRow(`SELECT username FROM premium_subscriptions`).Scan(&subOwner)
	if subOwner != "zoe2" {
		t.Errorf("subscription owner = %q, want it to follow the rename", subOwner)
	}
}

// A failed DB rename must not leave Keycloak renamed on its own.
func TestRenameRollsBackKeycloakWhenDBFails(t *testing.T) {
	q, pool := identityTestDB(t)
	kc := &fakeKC{users: map[string]*kcUserResult{zoeSub: {ID: zoeSub, Username: "zoe", Email: "zoe@x.com"}}, login: zoeSub}
	s := newIdentityAuth(t, q, kc)
	insertIdentityUser(t, pool, "zoe", "zoe@x.com")
	insertIdentityUser(t, pool, "taken", "t@x.com") // DB rejects zoe → taken (PK)

	if err := s.RenameUser(t.Context(), "zoe", "taken"); err == nil {
		t.Fatal("expected the rename to fail")
	}
	if kc.users[zoeSub].Username != "zoe" {
		t.Fatalf("keycloak username = %q, want rolled back to zoe", kc.users[zoeSub].Username)
	}
}

// A row orphaned by an earlier half-finished rename (its username no longer
// exists in Keycloak) is adopted by the login that owns its email.
func TestLoginAdoptsRowOrphanedByRename(t *testing.T) {
	q, pool := identityTestDB(t)
	kc := &fakeKC{users: map[string]*kcUserResult{zoeSub: {ID: zoeSub, Username: "newname", Email: "zoe@x.com"}}, login: zoeSub}
	s := newIdentityAuth(t, q, kc)
	insertIdentityUser(t, pool, "oldname", "Zoe@x.com")

	if _, err := s.Login(t.Context(), "newname", "pw"); err != nil {
		t.Fatalf("Login: %v", err)
	}
	if got := usersIn(t, pool); len(got) != 1 || got[0] != "newname|zoe@x.com" {
		t.Fatalf("users = %v, want the orphan adopted as newname", got)
	}
}

// An email that belongs to a different, live Keycloak account is never taken
// over, and no second row is created for it either.
func TestLoginRefusesEmailOfAnotherLiveAccount(t *testing.T) {
	q, pool := identityTestDB(t)
	other := "22222222-2222-2222-2222-222222222222"
	kc := &fakeKC{users: map[string]*kcUserResult{
		zoeSub: {ID: zoeSub, Username: "zoe", Email: "zoe@x.com"},
		other:  {ID: other, Username: "someone", Email: "someone@x.com"},
	}, login: zoeSub}
	s := newIdentityAuth(t, q, kc)
	insertIdentityUser(t, pool, "someone", "ZOE@x.com")

	if _, err := s.Login(t.Context(), "zoe", "pw"); err == nil {
		t.Fatal("expected login to refuse")
	}
	if got := usersIn(t, pool); len(got) != 1 || got[0] != "someone|ZOE@x.com" {
		t.Fatalf("users = %v, want the other account untouched and nothing added", got)
	}
}

// ── Reconcile, end to end against the real schema ────────────────────────────

type fakeIDP map[string]*KeycloakIdentity // lower username → identity

func (f fakeIDP) LookupIdentity(_ context.Context, u string) (*KeycloakIdentity, error) {
	return f[strings.ToLower(u)], nil
}

type fakeRekeyer struct {
	calls     int
	forgotten []string
}

func (f *fakeRekeyer) RekeyUserObjects(_ context.Context, _ uuid.UUID, _ []string, _ []byte, previous [][]byte) (*RekeyResult, error) {
	f.calls++
	return &RekeyResult{Checked: 3, Current: 2, Rekeyed: 1}, nil
}
func (f *fakeRekeyer) UnwrapUserKey(k, _ []byte, _ string) ([]byte, error) {
	return append([]byte(nil), k...), nil
}
func (f *fakeRekeyer) ForgetUsers(u ...string) { f.forgotten = append(f.forgotten, u...) }

func TestUserReconcileMergesAndAudits(t *testing.T) {
	q, pool := identityTestDB(t)
	insertIdentityUser(t, pool, "Zoe", "Zoe@x.com")
	insertIdentityUser(t, pool, "zoe", "zoe@x.com")
	dbExec(t, pool, `UPDATE users SET last_seen_at = NOW() WHERE username = 'zoe'`)
	insertIdentityUser(t, pool, "Bob", "bob@x.com") // normalize only
	insertIdentityUser(t, pool, "ghost", "Ghost@x.com")
	insertIdentityUser(t, pool, "Ghost", "ghost2@x.com") // no Keycloak login → blocked

	idp := fakeIDP{
		"zoe": {ID: zoeSub, Username: "zoe", Email: "zoe@x.com"},
		"bob": {ID: "33333333-3333-3333-3333-333333333333", Username: "bob", Email: "bob@x.com"},
	}
	rk := &fakeRekeyer{}
	svc := &UserReconcileService{queries: q, idp: idp, objects: rk}

	groups, err := svc.Preview(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 3 {
		t.Fatalf("groups = %d, want 3 (zoe merge, bob normalize, ghost blocked)", len(groups))
	}

	if err := svc.Start("admin"); err != nil {
		t.Fatal(err)
	}
	var rep *UserReconcileReport
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if rep = svc.Status(); !rep.Running {
			break
		}
	}
	if rep.Running || rep.Error != "" {
		t.Fatalf("run: running=%v err=%q", rep.Running, rep.Error)
	}
	status := map[string]string{}
	for _, o := range rep.Outcomes {
		status[o.Username] = o.Status
	}
	if status["zoe"] != "merged" || status["bob"] != "normalized" || status["ghost"] != "skipped" {
		t.Fatalf("outcomes = %v", status)
	}
	if rk.calls != 1 {
		t.Errorf("rekey calls = %d, want 1 (only the merge)", rk.calls)
	}
	got := strings.Join(usersIn(t, pool), " ")
	if got != "Ghost|ghost2@x.com bob|bob@x.com ghost|Ghost@x.com zoe|zoe@x.com" {
		t.Errorf("users after = %s", got)
	}
	var audits int
	_ = pool.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action IN ('account_merged','account_normalized') AND actor_username = 'admin'`).Scan(&audits)
	if audits != 2 {
		t.Errorf("audit entries = %d, want 2", audits)
	}
	if rep.IndexesCreated {
		t.Error("indexes must not be reported created while ghost/Ghost still collide")
	}
}

// ── Re-encryption (no database needed except ReplaceEncryptedObject) ─────────

type memStore struct{ objs map[string][]byte }

func (m *memStore) get(key string) ([]byte, error) {
	b, ok := m.objs[key]
	if !ok {
		return nil, minio.ErrorResponse{Code: "NoSuchKey"}
	}
	return b, nil
}
func (m *memStore) GetObject(_ context.Context, key string) (io.ReadCloser, error) {
	b, err := m.get(key)
	return io.NopCloser(bytes.NewReader(b)), err
}
func (m *memStore) GetObjectRange(_ context.Context, key string, start, end int64) (io.ReadCloser, error) {
	b, err := m.get(key)
	if err != nil {
		return nil, err
	}
	end = min(end+1, int64(len(b)))
	return io.NopCloser(bytes.NewReader(b[start:end])), nil
}
func (m *memStore) PutObject(_ context.Context, key string, r io.Reader, size int64, _ string) error {
	b, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	if size >= 0 && int64(len(b)) != size {
		return fmt.Errorf("size %d != declared %d", len(b), size)
	}
	m.objs[key] = b
	return nil
}
func (m *memStore) RemoveObject(_ context.Context, key string) error { delete(m.objs, key); return nil }
func (m *memStore) StatObject(_ context.Context, key string) (minio.ObjectInfo, error) {
	b, err := m.get(key)
	return minio.ObjectInfo{Size: int64(len(b))}, err
}

func randKey(t *testing.T) []byte {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		t.Fatal(err)
	}
	return k
}

func TestReencryptChunkedStreamPreservesLayout(t *testing.T) {
	enc := &EncryptionService{}
	from, to := randKey(t), randKey(t)
	for _, size := range []int{0, 1, ChunkSize - 1, ChunkSize, 2*ChunkSize + 17} {
		plain := make([]byte, size)
		_, _ = rand.Read(plain)
		blob, err := enc.EncryptChunked(from, plain)
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		if err := reencryptChunkedStream(&out, bytes.NewReader(blob), from, to); err != nil {
			t.Fatalf("size %d: %v", size, err)
		}
		if out.Len() != len(blob) {
			t.Fatalf("size %d: stored length changed %d → %d (range reads would misalign)", size, len(blob), out.Len())
		}
		got, err := enc.DecryptChunked(to, out.Bytes())
		if err != nil || !bytes.Equal(got, plain) {
			t.Fatalf("size %d: round trip failed: %v", size, err)
		}
		if _, err := enc.DecryptChunked(from, out.Bytes()); err == nil {
			t.Fatalf("size %d: old key still opens the re-encrypted copy", size)
		}
	}
}

func TestRekeyObjectsMovesOnlyOldKeyBlobs(t *testing.T) {
	q, pool := identityTestDB(t)
	enc := &EncryptionService{}
	fs := &FileService{queries: q, enc: enc}
	current, old, stranger := randKey(t), randKey(t), randKey(t)
	user := uuid.MustParse(zoeSub)
	store := &memStore{objs: map[string][]byte{}}

	put := func(name string, key []byte, chunked bool) (uuid.UUID, string, []byte) {
		id := uuid.New()
		objKey := user.String() + "/" + id.String()
		plain := []byte("contents of " + name)
		var blob, nonce []byte
		if chunked {
			blob, _ = enc.EncryptChunked(key, plain)
			nonce = []byte{}
		} else {
			blob, nonce, _ = aesGCMEncrypt(key, plain)
		}
		store.objs[objKey] = blob
		dbExec(t, pool, `INSERT INTO files (id, user_id, name, mime_type, size_bytes, minio_object_key, nonce) VALUES ($1, $2, $3, 'x', $4, $5, $6)`,
			id, user, name, len(plain), objKey, nonce)
		return id, objKey, plain
	}
	_, curKey, _ := put("a", current, false)
	oldID, oldKey, oldPlain := put("b", old, false)
	vidID, vidKey, vidPlain := put("c", old, true)
	_, strangeKey, _ := put("d", stranger, false)
	missingID, _, _ := put("e", current, false)
	dbExec(t, pool, `UPDATE files SET minio_object_key = 'gone' WHERE id = $1`, missingID)

	res := &RekeyResult{}
	objects, err := q.ListUserEncryptedObjects(t.Context(), user)
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range objects {
		if err := fs.rekeyObject(t.Context(), store, user, o, current, [][]byte{old}, res); err != nil {
			t.Fatalf("rekey %s: %v", o.ID, err)
		}
	}
	if res.Current != 1 || res.Rekeyed != 2 || res.Missing != 1 || len(res.Unreadable) != 1 {
		t.Fatalf("result = %+v", res)
	}
	if _, ok := store.objs[curKey]; !ok {
		t.Error("blob already under the current key must be left in place")
	}
	if _, ok := store.objs[strangeKey]; !ok {
		t.Error("blob no key opens must be left in place")
	}
	for _, gone := range []string{oldKey, vidKey} {
		if _, ok := store.objs[gone]; ok {
			t.Errorf("superseded object %s not removed", gone)
		}
	}
	check := func(id uuid.UUID, plain []byte) {
		var key string
		var nonce []byte
		if err := pool.QueryRow(`SELECT minio_object_key, nonce FROM files WHERE id = $1`, id).Scan(&key, &nonce); err != nil {
			t.Fatal(err)
		}
		blob := store.objs[key]
		var got []byte
		if len(nonce) == 0 {
			got, err = enc.DecryptChunked(current, blob)
		} else {
			got, err = aesGCMDecrypt(current, nonce, blob)
		}
		if err != nil || !bytes.Equal(got, plain) {
			t.Errorf("file %s does not open with the survivor's key: %v", id, err)
		}
	}
	check(oldID, oldPlain)
	check(vidID, vidPlain)
}
