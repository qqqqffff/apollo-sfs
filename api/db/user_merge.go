package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/lib/pq"

	"apollo-sfs.com/api/models"
)

// DefaultProvisionedQuotaBytes is the quota a users row gets when it is
// auto-provisioned at login rather than created from an invitation or slot.
// Such a row has no drive allocation behind it, which is how a merge tells the
// bogus half of a duplicate apart from the half that carries a real entitlement.
const DefaultProvisionedQuotaBytes = 10 * 1024 * 1024 * 1024 // 10 GB

// ErrMergeLiveSubscriptions means both halves of a duplicate hold a live premium
// subscription. Only one may survive (premium_subscriptions_one_live_idx), and
// picking which one to stop billing is a decision for a person.
var ErrMergeLiveSubscriptions = errors.New("more than one of these accounts has a live premium subscription — cancel one before reconciling")

// userRef is a column holding a username.
type userRef struct{ table, column string }

// plainUserRefs are username columns with no foreign key to users, so nothing
// follows a rename unless we update them here. TestUserRefsCoverSchema fails if
// a migration adds a username column that isn't listed in either slice.
var plainUserRefs = []userRef{
	{"audit_logs", "target_username"},
	{"audit_logs", "actor_username"},
	{"email_backup_runs", "username"},
	{"feedback", "username"},
	{"google_backup_runs", "username"},
	{"pricing_discounts", "created_by"},
	{"quota_change_notifications", "changed_by"},
	{"recognition_jobs", "username"},
	{"registration_slots", "consumed_by"},
	{"role_change_notifications", "changed_by"},
	{"user_bans", "banned_by"},
	{"user_bans", "pardoned_by"},
}

// keyedUserRefs are username columns that a merge can't blindly rewrite because
// the row's uniqueness depends on the username; mergeKeyedRows handles each.
// user_preferences has no FK, so a plain rename has to move it too.
var keyedUserRefs = []userRef{
	{"user_drive_allocations", "user_id"},
	{"user_preferences", "user_id"},
	{"dismissed_notifications", "username"},
	{"file_server_links", "username"},
}

// fkUserRefs are the remaining FK columns, safe to rewrite row by row.
var fkUserRefs = []userRef{
	{"api_keys", "username"},
	{"math_game_scores", "username"},
	{"password_change_codes", "username"},
	{"password_reset_tokens", "username"},
	{"payments", "username"},
	{"premium_subscriptions", "username"},
	{"quota_change_notifications", "username"},
	{"role_change_notifications", "username"},
	{"server_expansion_requests", "username"},
	{"shares", "owner_username"},
	{"storage_orders", "username"},
	{"user_bans", "username"},
}

// FindUsersByUsernameFold returns every row whose username matches
// case-insensitively, the exact match first and then the most recently seen.
func (q *Queries) FindUsersByUsernameFold(ctx context.Context, username string) ([]models.User, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT`+userColumns+`
		FROM users WHERE LOWER(username) = LOWER($1)
		ORDER BY (username = $1) DESC, last_seen_at DESC NULLS LAST, created_at ASC
	`, username)
	if err != nil {
		return nil, fmt.Errorf("FindUsersByUsernameFold %q: %w", username, err)
	}
	return collectUsers(rows, "FindUsersByUsernameFold")
}

// ListUserIdentityConflicts returns every users row that either collides with
// another row ignoring case (by username or email) or isn't stored in the
// lower-cased form Keycloak uses.
func (q *Queries) ListUserIdentityConflicts(ctx context.Context) ([]models.User, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT`+userColumns+`
		FROM users
		WHERE username <> LOWER(username)
		   OR email    <> LOWER(email)
		   OR LOWER(username) IN (SELECT LOWER(username) FROM users GROUP BY 1 HAVING COUNT(*) > 1)
		   OR LOWER(email)    IN (SELECT LOWER(email)    FROM users GROUP BY 1 HAVING COUNT(*) > 1)
		ORDER BY created_at ASC, username ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("ListUserIdentityConflicts: %w", err)
	}
	return collectUsers(rows, "ListUserIdentityConflicts")
}

func collectUsers(rows *sql.Rows, op string) ([]models.User, error) {
	defer rows.Close()
	var out []models.User
	for rows.Next() {
		u, err := scanUserRow(rows)
		if err != nil {
			return nil, fmt.Errorf("%s scan: %w", op, err)
		}
		out = append(out, *u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}
	return out, nil
}

// SetUserEmail replaces a user's stored email address.
func (q *Queries) SetUserEmail(ctx context.Context, username, email string) error {
	if _, err := q.db.ExecContext(ctx,
		`UPDATE users SET email = $2 WHERE username = $1`, username, email); err != nil {
		return fmt.Errorf("SetUserEmail %q: %w", username, err)
	}
	return nil
}

// CountUserAllocations returns how many drive allocations username holds.
func (q *Queries) CountUserAllocations(ctx context.Context, username string) (int, error) {
	var n int
	if err := q.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM user_drive_allocations WHERE user_id = $1`, username).Scan(&n); err != nil {
		return 0, fmt.Errorf("CountUserAllocations %q: %w", username, err)
	}
	return n, nil
}

// CountLiveSubscriptions returns how many of usernames hold a live (active or
// suspended) premium subscription.
func (q *Queries) CountLiveSubscriptions(ctx context.Context, usernames []string) (int, error) {
	var n int
	if err := q.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM premium_subscriptions
		WHERE username = ANY($1) AND status IN ('active', 'suspended')
	`, pq.Array(usernames)).Scan(&n); err != nil {
		return 0, fmt.Errorf("CountLiveSubscriptions: %w", err)
	}
	return n, nil
}

// EnsureUserIdentityIndexes creates the case-insensitive unique indexes that
// make a duplicate account impossible. It fails while any duplicate remains, so
// callers run it once reconciliation has cleared them all.
func (q *Queries) EnsureUserIdentityIndexes(ctx context.Context) error {
	for _, stmt := range []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username))`,
		`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email))`,
	} {
		if _, err := q.db.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("EnsureUserIdentityIndexes: %w", err)
		}
	}
	return nil
}

// ── Merge ─────────────────────────────────────────────────────────────────────

// MergedQuota works out the quota the surviving account is entitled to.
//
// A row with drive allocations behind it is a real grant (invitation, slot,
// purchase, admin edit) and contributes its whole quota — both halves' quotas
// are already committed against drive capacity, so adding them never
// over-commits. A row without any is the auto-provisioned half and contributes
// only what was bought on top of the 10 GB placeholder. If no row has an
// allocation there is nothing to tell them apart by, and the largest wins.
func MergedQuota(users []models.User, allocations map[string]int) int64 {
	var sum, largest int64
	anyAllocated := false
	for _, u := range users {
		largest = max(largest, u.StorageQuotaBytes)
		if allocations[u.Username] > 0 {
			anyAllocated = true
			sum += u.StorageQuotaBytes
		} else {
			sum += max(0, u.StorageQuotaBytes-DefaultProvisionedQuotaBytes)
		}
	}
	if !anyAllocated {
		return largest
	}
	return sum
}

// MergeUsersParams describes one duplicate group to collapse.
type MergeUsersParams struct {
	Survivor  string   // username of the row to keep
	Merged    []string // usernames of the rows to fold into it and remove
	Canonical string   // username the survivor ends up with (Keycloak's spelling)
	Email     string   // email the survivor ends up with
	MergedBy  string   // admin performing the merge, for the ledger
}

// MergeUsers folds every p.Merged row into p.Survivor in one transaction: all
// per-user rows are re-pointed, quota/usage/role fields are combined, the
// removed rows are snapshotted into user_account_merges, and the survivor is
// renamed to p.Canonical. With no p.Merged rows it only normalizes the survivor.
//
// It does not touch encrypted file content. The survivor keeps its own
// encryption key, so the caller must already have re-encrypted anything stored
// under a merged row's key (FileService.RekeyUserObjects).
func (q *Queries) MergeUsers(ctx context.Context, p MergeUsersParams) error {
	tx, err := q.pool.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("MergeUsers: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	tq := &Queries{db: tx, pool: q.pool}

	// Lock every row for the duration, so a concurrent upload's
	// storage_used_bytes update can't land on a row that's about to go.
	names := append([]string{p.Survivor}, p.Merged...)
	rows, err := tx.QueryContext(ctx, `
		SELECT`+userColumns+` FROM users WHERE username = ANY($1) ORDER BY username FOR UPDATE
	`, pq.Array(names))
	if err != nil {
		return fmt.Errorf("MergeUsers: lock: %w", err)
	}
	users, err := collectUsers(rows, "MergeUsers lock")
	if err != nil {
		return err
	}
	if len(users) != len(names) {
		return fmt.Errorf("MergeUsers: expected %d accounts, found %d", len(names), len(users))
	}
	live, err := tq.CountLiveSubscriptions(ctx, names)
	if err != nil {
		return err
	}
	if live > 1 {
		return ErrMergeLiveSubscriptions
	}

	if len(p.Merged) > 0 {
		// Must be read before any allocation moves.
		allocations := make(map[string]int, len(names))
		for _, n := range names {
			if allocations[n], err = tq.CountUserAllocations(ctx, n); err != nil {
				return err
			}
		}
		quota := MergedQuota(users, allocations)

		for _, loser := range p.Merged {
			if err := tq.foldUser(ctx, p.Survivor, loser, p.MergedBy); err != nil {
				return fmt.Errorf("MergeUsers %q into %q: %w", loser, p.Survivor, err)
			}
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE users SET storage_quota_bytes = $2 WHERE username = $1`, p.Survivor, quota); err != nil {
			return fmt.Errorf("MergeUsers: set quota: %w", err)
		}
	}

	if err := tq.SetUserEmail(ctx, p.Survivor, p.Email); err != nil {
		return err
	}
	if p.Canonical != p.Survivor {
		if err := tq.renameUser(ctx, p.Survivor, p.Canonical); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// foldUser moves everything loser owns onto survivor and deletes loser's row.
// Runs inside MergeUsers' transaction.
func (q *Queries) foldUser(ctx context.Context, survivor, loser, mergedBy string) error {
	exec := func(step, query string, args ...any) error {
		if _, err := q.db.ExecContext(ctx, query, args...); err != nil {
			return fmt.Errorf("%s: %w", step, err)
		}
		return nil
	}

	if err := exec("snapshot", `
		INSERT INTO user_account_merges (survivor_username, merged_username, merged_by, snapshot, allocations)
		SELECT $1, u.username, $3, to_jsonb(u),
		       COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM user_drive_allocations a WHERE a.user_id = u.username), '[]'::jsonb)
		FROM users u WHERE u.username = $2
	`, survivor, loser, mergedBy); err != nil {
		return err
	}

	// Role flags come from the survivor when it has ever been seen: RequireAuth
	// rewrites them from the JWT on every request, so they're current, whereas
	// the loser's are whatever they were when it stopped matching anyone's token.
	//
	// The trial expiry is the exception. It's only ever written at registration
	// or by an admin, so a trial on the loser is the real one — that stranded
	// expiry is precisely why such a trial never lapsed. An expiry already in
	// the past on an account that isn't premium any more has nothing left to do.
	if err := exec("combine fields", `
		UPDATE users s SET
			storage_used_bytes       = s.storage_used_bytes + l.storage_used_bytes,
			is_admin                 = CASE WHEN s.last_seen_at IS NULL THEN s.is_admin   OR l.is_admin   ELSE s.is_admin   END,
			is_premium               = CASE WHEN s.last_seen_at IS NULL THEN s.is_premium OR l.is_premium ELSE s.is_premium END,
			premium_granted_at       = LEAST(s.premium_granted_at, l.premium_granted_at),
			premium_expires_at       = CASE
				WHEN NOT s.is_premium AND NOT (s.last_seen_at IS NULL AND l.is_premium)
				     AND COALESCE(s.premium_expires_at, l.premium_expires_at) <= NOW() THEN NULL
				ELSE COALESCE(s.premium_expires_at, l.premium_expires_at) END,
			premium_purchase_blocked = s.premium_purchase_blocked OR l.premium_purchase_blocked,
			feedback_access_enabled  = s.feedback_access_enabled  OR l.feedback_access_enabled,
			last_seen_at             = GREATEST(s.last_seen_at, l.last_seen_at),
			created_at               = LEAST(s.created_at, l.created_at)
		FROM users l
		WHERE s.username = $1 AND l.username = $2
	`, survivor, loser); err != nil {
		return err
	}

	if err := q.mergeKeyedRows(ctx, survivor, loser); err != nil {
		return err
	}
	for _, refs := range [][]userRef{fkUserRefs, plainUserRefs} {
		for _, r := range refs {
			if err := exec("move "+r.table, fmt.Sprintf(
				`UPDATE %s SET %s = $1 WHERE %s = $2`, r.table, r.column, r.column), survivor, loser); err != nil {
				return err
			}
		}
	}

	// Deleting the row cascades. If a table was added since the lists above were
	// last updated, that would silently destroy the rows we forgot to move, so
	// refuse instead.
	if left, err := q.remainingUserReferences(ctx, loser); err != nil {
		return err
	} else if len(left) > 0 {
		return fmt.Errorf("rows still reference the account in: %s", strings.Join(left, ", "))
	}
	return exec("delete", `DELETE FROM users WHERE username = $1`, loser)
}

// mergeKeyedRows moves the rows whose uniqueness includes the username.
func (q *Queries) mergeKeyedRows(ctx context.Context, survivor, loser string) error {
	steps := []struct{ name, query string }{
		// Both halves on the same drive: one allocation with the combined quota.
		{"combine allocations", `
			UPDATE user_drive_allocations s
			SET quota_bytes = s.quota_bytes + l.quota_bytes, allocated_at = LEAST(s.allocated_at, l.allocated_at)
			FROM user_drive_allocations l
			WHERE s.user_id = $1 AND l.user_id = $2 AND l.drive_id = s.drive_id`},
		{"drop combined allocations", `
			DELETE FROM user_drive_allocations l USING user_drive_allocations s
			WHERE l.user_id = $2 AND s.user_id = $1 AND l.drive_id = s.drive_id`},
		{"demote primary", `
			UPDATE user_drive_allocations SET is_primary = false
			WHERE user_id = $2 AND is_primary
			  AND EXISTS (SELECT 1 FROM user_drive_allocations WHERE user_id = $1 AND is_primary)`},
		{"move allocations", `UPDATE user_drive_allocations SET user_id = $1 WHERE user_id = $2`},
		{"ensure primary", `
			UPDATE user_drive_allocations SET is_primary = true
			WHERE user_id = $1 AND $2::text IS NOT NULL -- ($2 unused; every step binds both)
			  AND NOT EXISTS (SELECT 1 FROM user_drive_allocations WHERE user_id = $1 AND is_primary)
			  AND drive_id = (SELECT drive_id FROM user_drive_allocations WHERE user_id = $1
			                  ORDER BY quota_bytes DESC, allocated_at ASC LIMIT 1)`},

		// Preferences: the survivor's choices win, the loser's fill the gaps.
		{"combine preferences", `
			UPDATE user_preferences s
			SET media_autoupload_folder_id = COALESCE(s.media_autoupload_folder_id, l.media_autoupload_folder_id),
			    default_drive_id           = COALESCE(s.default_drive_id, l.default_drive_id),
			    updated_at                 = NOW()
			FROM user_preferences l WHERE s.user_id = $1 AND l.user_id = $2`},
		{"drop combined preferences", `
			DELETE FROM user_preferences WHERE user_id = $2
			  AND EXISTS (SELECT 1 FROM user_preferences WHERE user_id = $1)`},
		{"move preferences", `UPDATE user_preferences SET user_id = $1 WHERE user_id = $2`},

		{"drop repeated dismissals", `
			DELETE FROM dismissed_notifications l USING dismissed_notifications s
			WHERE l.username = $2 AND s.username = $1 AND l.notification_id = s.notification_id`},
		{"move dismissals", `UPDATE dismissed_notifications SET username = $1 WHERE username = $2`},

		// One mount link per drive; the survivor's is the one in use.
		{"drop repeated mount links", `
			DELETE FROM file_server_links l USING file_server_links s
			WHERE l.username = $2 AND s.username = $1 AND l.drive_id = s.drive_id`},
		{"move mount links", `UPDATE file_server_links SET username = $1 WHERE username = $2`},
	}
	for _, s := range steps {
		if _, err := q.db.ExecContext(ctx, s.query, survivor, loser); err != nil {
			return fmt.Errorf("%s: %w", s.name, err)
		}
	}
	return nil
}

// remainingUserReferences returns the FK tables that still hold rows for
// username, discovered from the catalog rather than from the lists above.
func (q *Queries) remainingUserReferences(ctx context.Context, username string) ([]string, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT c.conrelid::regclass::text, quote_ident(a.attname)
		FROM pg_constraint c
		JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
		WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass
	`)
	if err != nil {
		return nil, fmt.Errorf("remainingUserReferences: %w", err)
	}
	var refs []userRef
	for rows.Next() {
		var r userRef
		if err := rows.Scan(&r.table, &r.column); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("remainingUserReferences scan: %w", err)
		}
		refs = append(refs, r)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("remainingUserReferences: %w", err)
	}
	var left []string
	for _, r := range refs {
		var found bool
		if err := q.db.QueryRowContext(ctx, fmt.Sprintf(
			`SELECT EXISTS (SELECT 1 FROM %s WHERE %s = $1)`, r.table, r.column), username).Scan(&found); err != nil {
			return nil, fmt.Errorf("remainingUserReferences %s: %w", r.table, err)
		}
		if found {
			left = append(left, r.table)
		}
	}
	return left, nil
}

// renameUser changes a username everywhere: the FK columns follow through ON
// UPDATE CASCADE, the rest are rewritten here. Must run in a transaction.
func (q *Queries) renameUser(ctx context.Context, oldUsername, newUsername string) error {
	res, err := q.db.ExecContext(ctx,
		`UPDATE users SET username = $2 WHERE username = $1`, oldUsername, newUsername)
	if err != nil {
		return fmt.Errorf("UpdateUsername %q→%q: %w", oldUsername, newUsername, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("UpdateUsername: user %q not found", oldUsername)
	}
	refs := append([]userRef{{"user_preferences", "user_id"}}, plainUserRefs...)
	for _, r := range refs {
		if _, err := q.db.ExecContext(ctx, fmt.Sprintf(
			`UPDATE %s SET %s = $2 WHERE %s = $1`, r.table, r.column, r.column), oldUsername, newUsername); err != nil {
			return fmt.Errorf("UpdateUsername %q→%q: %s: %w", oldUsername, newUsername, r.table, err)
		}
	}
	return nil
}

// ── Encrypted objects ─────────────────────────────────────────────────────────

// Kinds of encrypted object stored under a user's key.
const (
	EncryptedFile    = "file"
	EncryptedVariant = "variant"
	EncryptedCrop    = "crop"
)

// EncryptedObject is one MinIO blob sealed with a user's encryption key.
type EncryptedObject struct {
	Kind      string
	ID        uuid.UUID // files / video_variants / recognition_detections id
	FileID    uuid.UUID // the owning file
	DriveID   *uuid.UUID
	ObjectKey string
	Nonce     []byte // empty = chunked (per-chunk nonces inline)
}

// ListUserEncryptedObjects returns every blob encrypted under userID's key:
// files, ready video variants, and recognition crops.
func (q *Queries) ListUserEncryptedObjects(ctx context.Context, userID uuid.UUID) ([]EncryptedObject, error) {
	uq, tx, err := q.ForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := uq.db.QueryContext(ctx, `
		SELECT 'file', id, id, drive_id, minio_object_key, nonce FROM files WHERE user_id = $1
		UNION ALL
		SELECT 'variant', vv.id, f.id, f.drive_id, vv.minio_object_key, ''::bytea
		FROM video_variants vv JOIN files f ON f.id = vv.file_id
		WHERE f.user_id = $1 AND vv.status = 'ready'
		UNION ALL
		SELECT 'crop', rd.id, f.id, f.drive_id, rd.thumb_object_key, rd.thumb_nonce
		FROM recognition_detections rd JOIN files f ON f.id = rd.file_id
		WHERE rd.user_id = $1 AND rd.thumb_object_key IS NOT NULL
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("ListUserEncryptedObjects: %w", err)
	}
	defer rows.Close()
	var out []EncryptedObject
	for rows.Next() {
		var o EncryptedObject
		if err := rows.Scan(&o.Kind, &o.ID, &o.FileID, &o.DriveID, &o.ObjectKey, &o.Nonce); err != nil {
			return nil, fmt.Errorf("ListUserEncryptedObjects scan: %w", err)
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// ReplaceEncryptedObject points o's row at a re-encrypted copy. It matches on
// the old object key too, so a row that changed underneath the caller is left
// alone; replaced reports whether the row was updated.
func (q *Queries) ReplaceEncryptedObject(ctx context.Context, userID uuid.UUID, o EncryptedObject, newKey string, newNonce []byte) (replaced bool, err error) {
	uq, tx, err := q.ForUser(ctx, userID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	var res sql.Result
	switch o.Kind {
	case EncryptedFile:
		res, err = uq.db.ExecContext(ctx,
			`UPDATE files SET minio_object_key = $3, nonce = $4 WHERE id = $1 AND minio_object_key = $2`,
			o.ID, o.ObjectKey, newKey, newNonce)
	case EncryptedVariant:
		res, err = uq.db.ExecContext(ctx,
			`UPDATE video_variants SET minio_object_key = $3 WHERE id = $1 AND minio_object_key = $2`,
			o.ID, o.ObjectKey, newKey)
	case EncryptedCrop:
		res, err = uq.db.ExecContext(ctx,
			`UPDATE recognition_detections SET thumb_object_key = $3, thumb_nonce = $4 WHERE id = $1 AND thumb_object_key = $2`,
			o.ID, o.ObjectKey, newKey, newNonce)
	default:
		return false, fmt.Errorf("ReplaceEncryptedObject: unknown kind %q", o.Kind)
	}
	if err != nil {
		return false, fmt.Errorf("ReplaceEncryptedObject %s %s: %w", o.Kind, o.ID, err)
	}
	n, _ := res.RowsAffected()
	return n > 0, tx.Commit()
}
