package db

// Integration tests against a real PostgreSQL. They need a server holding a
// database with the full schema (db/*.sql + db/migrations/*.sql applied) to
// clone per test, and are skipped otherwise:
//
//	APOLLO_TEST_PG="host=127.0.0.1 port=5432 user=postgres sslmode=disable" \
//	APOLLO_TEST_TEMPLATE=apollo_schema go test ./db -run Integration

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	_ "github.com/lib/pq"

	"apollo-sfs.com/api/models"
)

// integrationDB clones the template database for one test.
func integrationDB(t *testing.T) (*Queries, *sql.DB) {
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
	// Duplicates are what these tests are about, and 065's indexes forbid them.
	mustExec(t, pool, `DROP INDEX IF EXISTS users_username_lower_idx, users_email_lower_idx`)
	mustExec(t, pool, `INSERT INTO master_keys (id, encrypted_key_material, key_nonce, status) VALUES ('v1', '\x00', '\x00', 'active')`)
	return New(pool), pool
}

func mustExec(t *testing.T, pool *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(q, args...); err != nil {
		t.Fatalf("%s: %v", strings.Fields(q)[0:3], err)
	}
}

func insertUser(t *testing.T, pool *sql.DB, username, email string, quota int64, key byte) {
	t.Helper()
	mustExec(t, pool, `INSERT INTO users (username, email, encrypted_key, key_nonce, master_key_version, storage_quota_bytes)
		VALUES ($1, $2, $3, '\x01', 'v1', $4)`, username, email, []byte{key}, quota)
}

func insertDrive(t *testing.T, pool *sql.DB) uuid.UUID {
	t.Helper()
	var server, drive uuid.UUID
	if err := pool.QueryRow(`INSERT INTO servers (name, state, minio_endpoint, minio_access_key_enc, minio_access_key_nonce, minio_secret_key_enc, minio_secret_key_nonce)
		VALUES ('S-'||gen_random_uuid(), 'X', 'm:9000', '\x00', '\x00', '\x00', '\x00') RETURNING id`).Scan(&server); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(`INSERT INTO drives (server_id, label, capacity_bytes, minio_bucket) VALUES ($1, 'd', 1e12, 'b') RETURNING id`, server).Scan(&drive); err != nil {
		t.Fatal(err)
	}
	return drive
}

func count(t *testing.T, pool *sql.DB, q string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(q, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return n
}

// TestIntegrationUserRefsCoverSchema fails when a migration adds a column that
// holds a username but isn't in the merge/rename lists — a merge would then
// either refuse (FK) or silently lose the rows' link to the user (no FK).
func TestIntegrationUserRefsCoverSchema(t *testing.T) {
	_, pool := integrationDB(t)
	rows, err := pool.Query(`
		SELECT c.conrelid::regclass::text, a.attname
		FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
		WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass
		UNION
		SELECT table_name, column_name FROM information_schema.columns
		WHERE table_schema = 'public' AND data_type = 'text' AND table_name <> 'users'
		  AND table_name <> 'user_account_merges'
		  AND (column_name LIKE '%username' OR column_name LIKE '%\_by' OR column_name = 'user_id')`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	known := map[string]bool{}
	for _, list := range [][]userRef{plainUserRefs, keyedUserRefs, fkUserRefs} {
		for _, r := range list {
			known[r.table+"."+r.column] = true
		}
	}
	var missing []string
	for rows.Next() {
		var table, col string
		if err := rows.Scan(&table, &col); err != nil {
			t.Fatal(err)
		}
		if !known[table+"."+col] {
			missing = append(missing, table+"."+col)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("username columns not handled by MergeUsers/UpdateUsername: %v — add them to db/user_merge.go", missing)
	}
}

// TestIntegrationMergeUsers covers the registration duplicate: "Zoe" holds the
// invitation's grant (drive allocation, trial expiry); "zoe" is the row login
// provisioned, holding everything done since.
func TestIntegrationMergeUsers(t *testing.T) {
	q, pool := integrationDB(t)
	ctx := context.Background()
	drive := insertDrive(t, pool)
	const gb = int64(1 << 30)

	insertUser(t, pool, "Zoe", "Zoe@x.com", 5*gb, 1)
	mustExec(t, pool, `INSERT INTO user_drive_allocations (user_id, drive_id, is_primary, quota_bytes) VALUES ('Zoe', $1, true, $2)`, drive, 5*gb)
	trialEnd := time.Now().Add(72 * time.Hour).UTC().Truncate(time.Second)
	mustExec(t, pool, `UPDATE users SET premium_expires_at = $1, storage_used_bytes = 100 WHERE username = 'Zoe'`, trialEnd)
	mustExec(t, pool, `INSERT INTO user_preferences (user_id, default_drive_id) VALUES ('Zoe', $1)`, drive)

	insertUser(t, pool, "zoe", "zoe@x.com", DefaultProvisionedQuotaBytes, 2)
	mustExec(t, pool, `UPDATE users SET is_premium = true, last_seen_at = NOW(), storage_used_bytes = 50 WHERE username = 'zoe'`)
	mustExec(t, pool, `INSERT INTO user_preferences (user_id, show_storage_buttons) VALUES ('zoe', false)`)
	mustExec(t, pool, `INSERT INTO audit_logs (target_username, actor_username, action) VALUES ('Zoe','Zoe','a'), ('zoe','zoe','b')`)
	mustExec(t, pool, `INSERT INTO premium_subscriptions (username, paypal_subscription_id, plan, status) VALUES ('zoe', 'I-1', 'monthly', 'expired')`)
	mustExec(t, pool, `INSERT INTO dismissed_notifications (username, notification_id) VALUES ('Zoe','n1'), ('zoe','n1'), ('Zoe','n2')`)
	mustExec(t, pool, `INSERT INTO user_bans (username, ban_type, violation_code, banned_by, pardoned_at) VALUES ('zoe', 'suspended', 'x', 'Zoe', NOW())`)

	conflicts, err := q.ListUserIdentityConflicts(ctx)
	if err != nil || len(conflicts) != 2 {
		t.Fatalf("ListUserIdentityConflicts = %d rows, %v; want 2", len(conflicts), err)
	}

	if err := q.MergeUsers(ctx, MergeUsersParams{
		Survivor: "zoe", Merged: []string{"Zoe"}, Canonical: "zoe", Email: "zoe@x.com", MergedBy: "admin",
	}); err != nil {
		t.Fatalf("MergeUsers: %v", err)
	}

	u, err := q.GetUserByUsername(ctx, "zoe")
	if err != nil {
		t.Fatal(err)
	}
	if count(t, pool, `SELECT COUNT(*) FROM users`) != 1 {
		t.Fatal("expected exactly one users row after merge")
	}
	if u.StorageQuotaBytes != 5*gb {
		t.Errorf("quota = %d, want the invited 5 GB (the auto-provisioned 10 GB is a placeholder)", u.StorageQuotaBytes)
	}
	if u.StorageUsedBytes != 150 {
		t.Errorf("used = %d, want 150", u.StorageUsedBytes)
	}
	if !u.IsPremium || u.PremiumExpiresAt == nil || !u.PremiumExpiresAt.Equal(trialEnd) {
		t.Errorf("premium=%v expires=%v, want the stranded trial expiry %v carried over", u.IsPremium, u.PremiumExpiresAt, trialEnd)
	}
	if u.Email != "zoe@x.com" {
		t.Errorf("email = %q", u.Email)
	}
	if n := count(t, pool, `SELECT COUNT(*) FROM user_drive_allocations WHERE user_id = 'zoe' AND is_primary AND quota_bytes = $1`, 5*gb); n != 1 {
		t.Errorf("want the allocation moved to zoe as primary, got %d", n)
	}
	if n := count(t, pool, `SELECT COUNT(*) FROM user_preferences WHERE user_id = 'zoe' AND default_drive_id = $1 AND NOT show_storage_buttons`, drive); n != 1 {
		t.Errorf("preferences not combined (survivor's choice kept, gaps filled from the merged row)")
	}
	if n := count(t, pool, `SELECT COUNT(*) FROM audit_logs WHERE target_username = 'zoe'`); n != 2 {
		t.Errorf("audit history: %d entries for zoe, want both", n)
	}
	if n := count(t, pool, `SELECT COUNT(*) FROM dismissed_notifications WHERE username = 'zoe'`); n != 2 {
		t.Errorf("dismissals: %d, want n1 + n2", n)
	}
	if n := count(t, pool, `SELECT COUNT(*) FROM user_bans WHERE username = 'zoe' AND banned_by = 'zoe'`); n != 1 {
		t.Errorf("plain username columns (banned_by) not rewritten")
	}
	if n := count(t, pool, `SELECT COUNT(*) FROM user_account_merges WHERE survivor_username = 'zoe' AND merged_username = 'Zoe'
		AND snapshot->>'email' = 'Zoe@x.com' AND jsonb_array_length(allocations) = 1`); n != 1 {
		t.Errorf("merge ledger snapshot missing")
	}
	if err := q.EnsureUserIdentityIndexes(ctx); err != nil {
		t.Errorf("indexes after merge: %v", err)
	}
}

// TestIntegrationMergeRenamesToCanonical: no row is spelled the way Keycloak
// spells it (a rename that reached only Keycloak), so the survivor is renamed —
// across FK columns including premium_subscriptions, which 065 makes cascade.
func TestIntegrationMergeRenamesToCanonical(t *testing.T) {
	q, pool := integrationDB(t)
	ctx := context.Background()
	insertUser(t, pool, "oldname", "Zoe@x.com", 20<<30, 1)
	mustExec(t, pool, `INSERT INTO premium_subscriptions (username, paypal_subscription_id, plan, status) VALUES ('oldname', 'I-1', 'monthly', 'active')`)
	mustExec(t, pool, `INSERT INTO audit_logs (target_username, actor_username, action) VALUES ('oldname','oldname','x')`)

	if err := q.MergeUsers(ctx, MergeUsersParams{Survivor: "oldname", Canonical: "newname", Email: "zoe@x.com", MergedBy: "admin"}); err != nil {
		t.Fatalf("MergeUsers: %v", err)
	}
	if n := count(t, pool, `SELECT COUNT(*) FROM premium_subscriptions WHERE username = 'newname'`); n != 1 {
		t.Error("subscription did not follow the rename")
	}
	if n := count(t, pool, `SELECT COUNT(*) FROM audit_logs WHERE target_username = 'newname' AND actor_username = 'newname'`); n != 1 {
		t.Error("audit history did not follow the rename")
	}
}

func TestIntegrationMergeRefusesTwoLiveSubscriptions(t *testing.T) {
	q, pool := integrationDB(t)
	insertUser(t, pool, "a", "a@x.com", 1, 1)
	insertUser(t, pool, "A", "A@x.com", 1, 2)
	mustExec(t, pool, `INSERT INTO premium_subscriptions (username, paypal_subscription_id, plan, status) VALUES ('a','I-1','monthly','active'), ('A','I-2','monthly','active')`)
	err := q.MergeUsers(context.Background(), MergeUsersParams{Survivor: "a", Merged: []string{"A"}, Canonical: "a", Email: "a@x.com", MergedBy: "x"})
	if err != ErrMergeLiveSubscriptions {
		t.Fatalf("err = %v, want ErrMergeLiveSubscriptions", err)
	}
	if count(t, pool, `SELECT COUNT(*) FROM users`) != 2 {
		t.Fatal("refused merge must change nothing")
	}
}

func TestIntegrationLookupsIgnoreCase(t *testing.T) {
	q, pool := integrationDB(t)
	ctx := context.Background()
	insertUser(t, pool, "Zoe", "Zoe@x.com", 1, 1)
	insertUser(t, pool, "zoe", "zoe@x.com", 1, 2)
	got, err := q.GetUserByEmail(ctx, "ZOE@X.COM")
	if err != nil || !strings.EqualFold(got.Email, "zoe@x.com") {
		t.Fatalf("GetUserByEmail ignoring case: %v %v", got, err)
	}
	if got, _ := q.GetUserByEmail(ctx, "Zoe@x.com"); got.Username != "Zoe" {
		t.Errorf("exact email match should win, got %q", got.Username)
	}
	m, err := q.FindUsersByUsernameFold(ctx, "zoe")
	if err != nil || len(m) != 2 || m[0].Username != "zoe" {
		t.Fatalf("FindUsersByUsernameFold = %v, %v (exact match first)", m, err)
	}
	if err := q.CreateUser(ctx, &models.User{Username: "Bob", Email: "Bob@x.com", EncryptedKey: []byte{1}, KeyNonce: []byte{1}, MasterKeyVersion: "v1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.GetUserByUsername(ctx, "bob"); err != nil {
		t.Errorf("CreateUser must store the canonical spelling: %v", err)
	}
}
