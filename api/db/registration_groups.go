package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/lib/pq"

	"apollo-sfs.com/api/models"
)

// ErrSlotNotFound is returned when a referenced registration slot does not exist.
var ErrSlotNotFound = errors.New("registration slot not found")

// ErrNoFreeSlot is returned by ReserveRegistrationSlot when every slot of the
// requested type is already consumed or held by a live reservation.
var ErrNoFreeSlot = errors.New("no slot of this type is currently available")

// reservedSlotBytesSubquery sums, per drive, the quota pre-reserved by
// unconsumed registration slots of active, unexpired registration groups.
// Shared by the capacity queries in drives.go so a group's slots keep their
// space claimed until they are consumed (at which point the registered user's
// own user_drive_allocations row takes over) or the group is deactivated,
// deleted, or expires.
const reservedSlotBytesSubquery = `
	SELECT rs.drive_id, SUM(rs.quota_bytes) AS reserved
	FROM registration_slots rs
	JOIN registration_groups rg ON rg.id = rs.group_id
	WHERE rs.consumed_at IS NULL
	  AND rg.is_active
	  AND (rg.expires_at IS NULL OR rg.expires_at > NOW())
	GROUP BY rs.drive_id`

// activeReservationExists is the predicate for "this slot is currently held by
// a live (unexpired, uncompleted, unreleased) reservation".
const activeReservationExists = `EXISTS (
	SELECT 1 FROM registration_slot_reservations r
	WHERE r.slot_id = s.id
	  AND r.completed_at IS NULL
	  AND r.released_at IS NULL
	  AND r.expires_at > NOW())`

// ── Group creation ────────────────────────────────────────────────────────────

// NewRegistrationSlotSpec describes one slot configuration to create, expanded
// into Count identical registration_slots rows. DriveType is "nvme" or "hdd";
// AccountStatus is "base" or "premium".
type NewRegistrationSlotSpec struct {
	ServerID         uuid.UUID
	DriveType        string
	QuotaBytes       int64
	AccountStatus    string
	PremiumExpiresAt *time.Time
	Count            int
}

// selectSlotDriveSQL picks the best-fit active drive of the requested tier on
// the requested server: smallest remaining space (after user allocations AND
// existing slot reservations) that still fits the slot quota. Runs inside the
// creation transaction, so slots inserted earlier in the same group already
// count against availability.
const selectSlotDriveSQL = `
	SELECT t.id FROM (
		SELECT d.id,
		       d.capacity_bytes - COALESCE(a.allocated, 0) - COALESCE(r.reserved, 0) AS avail
		FROM drives d
		JOIN servers s ON s.id = d.server_id
		LEFT JOIN (
			SELECT uda.drive_id, SUM(uda.quota_bytes) AS allocated
			FROM user_drive_allocations uda GROUP BY uda.drive_id
		) a ON a.drive_id = d.id
		LEFT JOIN (` + reservedSlotBytesSubquery + `
		) r ON r.drive_id = d.id
		WHERE d.server_id = $1 AND d.drive_type = $2 AND d.is_active AND s.is_active
	) t
	WHERE t.avail >= $3
	ORDER BY t.avail ASC
	LIMIT 1`

// insertRegistrationSlotsTx inserts specs' slots into groupID within tx. Each
// slot resolves to the best-fit drive of its tier on its server; the whole
// call fails with ErrNoCapacity when any slot cannot be placed (no active
// drive of that tier has enough unreserved space left). Shared by group
// creation and by adding/replacing slots on an already-existing group.
func insertRegistrationSlotsTx(ctx context.Context, tx *sql.Tx, groupID uuid.UUID, specs []NewRegistrationSlotSpec) error {
	for _, spec := range specs {
		for i := 0; i < spec.Count; i++ {
			var driveID uuid.UUID
			err := tx.QueryRowContext(ctx, selectSlotDriveSQL,
				spec.ServerID, spec.DriveType, spec.QuotaBytes,
			).Scan(&driveID)
			if err == sql.ErrNoRows {
				return ErrNoCapacity
			}
			if err != nil {
				return fmt.Errorf("insertRegistrationSlotsTx: select drive: %w", err)
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO registration_slots
					(group_id, server_id, drive_id, drive_type, quota_bytes, account_status, premium_expires_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
			`, groupID, spec.ServerID, driveID, spec.DriveType, spec.QuotaBytes, spec.AccountStatus, spec.PremiumExpiresAt); err != nil {
				return fmt.Errorf("insertRegistrationSlotsTx: insert slot: %w", err)
			}
		}
	}
	return nil
}

// CreateRegistrationGroup inserts the group and all of its slots in one
// transaction. The group's ID and CreatedAt are populated on success.
func (q *Queries) CreateRegistrationGroup(ctx context.Context, g *models.RegistrationGroup, specs []NewRegistrationSlotSpec) error {
	tx, err := q.pool.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("CreateRegistrationGroup: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err := tx.QueryRowContext(ctx, `
		INSERT INTO registration_groups
			(created_by_user_id, name, link_id, expires_at, is_active, notify_emails, send_expiry_reminder)
		VALUES ($1, $2, $3, $4, TRUE, $5, $6)
		RETURNING id, created_at
	`, g.CreatedByUserID, g.Name, g.LinkID, g.ExpiresAt, pq.Array(g.NotifyEmails), g.SendExpiryReminder,
	).Scan(&g.ID, &g.CreatedAt); err != nil {
		return fmt.Errorf("CreateRegistrationGroup: insert group: %w", err)
	}
	g.IsActive = true

	if err := insertRegistrationSlotsTx(ctx, tx, g.ID, specs); err != nil {
		return err
	}

	return tx.Commit()
}

// AddRegistrationSlots appends new slots to an already-existing group, the
// same way CreateRegistrationGroup provisions a new group's slots. Existing
// slots are untouched.
func (q *Queries) AddRegistrationSlots(ctx context.Context, groupID uuid.UUID, specs []NewRegistrationSlotSpec) error {
	tx, err := q.pool.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("AddRegistrationSlots: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err := insertRegistrationSlotsTx(ctx, tx, groupID, specs); err != nil {
		return err
	}
	return tx.Commit()
}

// RegistrationSlotSignature identifies one "slot type" — the grouping key
// ListRegistrationSlotTypes collapses identical slots by.
type RegistrationSlotSignature struct {
	ServerID         uuid.UUID
	DriveType        string
	QuotaBytes       int64
	AccountStatus    string
	PremiumExpiresAt *time.Time
}

// deleteFreeRegistrationSlotsSQL removes every slot matching a signature
// within a group that is neither consumed nor held by a live reservation —
// i.e. every currently-free slot of that type. Consumed or actively-reserved
// slots of the same configuration never match, so they're always left in
// place; reservation rows (even stale released/expired ones) cascade-delete
// with their slot.
const deleteFreeRegistrationSlotsSQL = `
	DELETE FROM registration_slots AS s
	WHERE s.group_id = $1 AND s.server_id = $2 AND s.drive_type = $3
	  AND s.quota_bytes = $4 AND s.account_status = $5
	  AND s.premium_expires_at IS NOT DISTINCT FROM $6
	  AND s.consumed_at IS NULL
	  AND NOT ` + activeReservationExists

// DeleteFreeRegistrationSlots removes every currently-free slot of the given
// signature within the group and returns how many were deleted.
func (q *Queries) DeleteFreeRegistrationSlots(ctx context.Context, groupID uuid.UUID, sig RegistrationSlotSignature) (int64, error) {
	res, err := q.db.ExecContext(ctx, deleteFreeRegistrationSlotsSQL,
		groupID, sig.ServerID, sig.DriveType, sig.QuotaBytes, sig.AccountStatus, sig.PremiumExpiresAt)
	if err != nil {
		return 0, fmt.Errorf("DeleteFreeRegistrationSlots: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// ReplaceRegistrationSlotType atomically swaps every currently-free slot
// matching oldSig for newSpec.Count new slots configured per newSpec, so an
// admin can fix a mistake in an unclaimed slot type (or resize its count)
// without touching slots that are already consumed or mid-registration.
func (q *Queries) ReplaceRegistrationSlotType(ctx context.Context, groupID uuid.UUID, oldSig RegistrationSlotSignature, newSpec NewRegistrationSlotSpec) error {
	tx, err := q.pool.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("ReplaceRegistrationSlotType: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, deleteFreeRegistrationSlotsSQL,
		groupID, oldSig.ServerID, oldSig.DriveType, oldSig.QuotaBytes, oldSig.AccountStatus, oldSig.PremiumExpiresAt,
	); err != nil {
		return fmt.Errorf("ReplaceRegistrationSlotType: delete old: %w", err)
	}
	if err := insertRegistrationSlotsTx(ctx, tx, groupID, []NewRegistrationSlotSpec{newSpec}); err != nil {
		return err
	}
	return tx.Commit()
}

// ── Group listing / lookup ────────────────────────────────────────────────────

const groupSummarySQL = `
	SELECT g.id, g.created_by_user_id, g.name, g.link_id, g.expires_at, g.is_active,
	       g.notify_emails, g.send_expiry_reminder, g.reminder_sent_at, g.created_at,
	       COUNT(s.id) AS slots_total,
	       COUNT(s.id) FILTER (WHERE s.consumed_at IS NOT NULL) AS slots_consumed,
	       COUNT(s.id) FILTER (WHERE s.consumed_at IS NULL AND ` + activeReservationExists + `) AS slots_reserved
	FROM registration_groups g
	LEFT JOIN registration_slots s ON s.group_id = g.id`

func scanGroupSummary(rows interface {
	Scan(dest ...any) error
}) (*models.RegistrationGroupSummary, error) {
	var gs models.RegistrationGroupSummary
	if err := rows.Scan(
		&gs.ID, &gs.CreatedByUserID, &gs.Name, &gs.LinkID, &gs.ExpiresAt, &gs.IsActive,
		pq.Array(&gs.NotifyEmails), &gs.SendExpiryReminder, &gs.ReminderSentAt, &gs.CreatedAt,
		&gs.SlotsTotal, &gs.SlotsConsumed, &gs.SlotsReserved,
	); err != nil {
		return nil, err
	}
	return &gs, nil
}

// ListRegistrationGroups returns a page of groups (newest first) with their
// aggregate slot counts. Backs the admin registration-groups table.
func (q *Queries) ListRegistrationGroups(ctx context.Context, in PageInput) (*PageResult[models.RegistrationGroupSummary], error) {
	limit := clampLimit(in.Limit)
	offset, err := decodeOffsetCursor(in.Cursor)
	if err != nil {
		return nil, fmt.Errorf("ListRegistrationGroups: %w", err)
	}

	rows, err := q.db.QueryContext(ctx, groupSummarySQL+`
		GROUP BY g.id
		ORDER BY g.created_at DESC
		LIMIT $1 OFFSET $2
	`, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("ListRegistrationGroups: %w", err)
	}
	defer rows.Close()

	var out []models.RegistrationGroupSummary
	for rows.Next() {
		gs, err := scanGroupSummary(rows)
		if err != nil {
			return nil, fmt.Errorf("ListRegistrationGroups scan: %w", err)
		}
		out = append(out, *gs)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListRegistrationGroups: %w", err)
	}
	return &PageResult[models.RegistrationGroupSummary]{
		Items:     out,
		NextToken: offsetNextToken(len(out), limit, offset),
	}, nil
}

// GetRegistrationGroupSummary returns one group with its aggregate slot counts.
// Returns sql.ErrNoRows when the group does not exist.
func (q *Queries) GetRegistrationGroupSummary(ctx context.Context, id uuid.UUID) (*models.RegistrationGroupSummary, error) {
	row := q.db.QueryRowContext(ctx, groupSummarySQL+`
		WHERE g.id = $1
		GROUP BY g.id
	`, id)
	gs, err := scanGroupSummary(row)
	if err != nil {
		return nil, fmt.Errorf("GetRegistrationGroupSummary: %w", err)
	}
	return gs, nil
}

// GetRegistrationGroupByLinkID returns a group by its public link identifier.
// Returns sql.ErrNoRows when unknown.
func (q *Queries) GetRegistrationGroupByLinkID(ctx context.Context, linkID string) (*models.RegistrationGroup, error) {
	var g models.RegistrationGroup
	err := q.db.QueryRowContext(ctx, `
		SELECT id, created_by_user_id, name, link_id, expires_at, is_active,
		       notify_emails, send_expiry_reminder, reminder_sent_at, created_at
		FROM registration_groups
		WHERE link_id = $1
	`, linkID).Scan(
		&g.ID, &g.CreatedByUserID, &g.Name, &g.LinkID, &g.ExpiresAt, &g.IsActive,
		pq.Array(&g.NotifyEmails), &g.SendExpiryReminder, &g.ReminderSentAt, &g.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("GetRegistrationGroupByLinkID: %w", err)
	}
	return &g, nil
}

// ListRegistrationSlotTypes returns the group's slots collapsed into identical
// configurations (server, tier, capacity, account status, premium expiry) with
// per-status counts. The representative SlotID prefers a still-free slot so
// the public page can hand it straight to ReserveRegistrationSlot.
func (q *Queries) ListRegistrationSlotTypes(ctx context.Context, groupID uuid.UUID) ([]models.RegistrationSlotType, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT
			(ARRAY_AGG(s.id ORDER BY (s.consumed_at IS NOT NULL) ASC, `+activeReservationExists+` ASC, s.created_at ASC))[1],
			s.server_id, sv.name, s.drive_type, s.quota_bytes, s.account_status, s.premium_expires_at,
			COUNT(*) AS total,
			COUNT(*) FILTER (WHERE s.consumed_at IS NOT NULL) AS consumed,
			COUNT(*) FILTER (WHERE s.consumed_at IS NULL AND `+activeReservationExists+`) AS reserved
		FROM registration_slots s
		JOIN servers sv ON sv.id = s.server_id
		WHERE s.group_id = $1
		GROUP BY s.server_id, sv.name, s.drive_type, s.quota_bytes, s.account_status, s.premium_expires_at
		ORDER BY sv.name ASC, s.drive_type ASC, s.quota_bytes ASC, s.account_status ASC, s.premium_expires_at ASC NULLS FIRST
	`, groupID)
	if err != nil {
		return nil, fmt.Errorf("ListRegistrationSlotTypes: %w", err)
	}
	defer rows.Close()

	var out []models.RegistrationSlotType
	for rows.Next() {
		var t models.RegistrationSlotType
		if err := rows.Scan(
			&t.SlotID, &t.ServerID, &t.ServerName, &t.DriveType, &t.QuotaBytes,
			&t.AccountStatus, &t.PremiumExpiresAt, &t.Total, &t.Consumed, &t.Reserved,
		); err != nil {
			return nil, fmt.Errorf("ListRegistrationSlotTypes scan: %w", err)
		}
		t.Available = t.Total - t.Consumed - t.Reserved
		out = append(out, t)
	}
	return out, rows.Err()
}

// SetRegistrationGroupActive flips a group's is_active flag (deactivating a
// group frees its unconsumed slots' capacity reservations immediately).
func (q *Queries) SetRegistrationGroupActive(ctx context.Context, id uuid.UUID, active bool) error {
	res, err := q.db.ExecContext(ctx,
		`UPDATE registration_groups SET is_active = $2 WHERE id = $1`, id, active)
	if err != nil {
		return fmt.Errorf("SetRegistrationGroupActive: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// UpdateRegistrationGroup updates a group's editable metadata — name, overall
// expiry, notify list, and reminder opt-in. Slots are immutable once created
// (their capacity is already reserved and may be consumed or actively held),
// so they are untouched here. reminder_sent_at is cleared only when the
// expiry actually changes, so an unrelated edit doesn't re-arm (and
// duplicate) a reminder that already went out for the same expiry.
func (q *Queries) UpdateRegistrationGroup(ctx context.Context, id uuid.UUID, name string, expiresAt *time.Time, notifyEmails []string, sendReminder bool) error {
	res, err := q.db.ExecContext(ctx, `
		UPDATE registration_groups
		SET name = $2,
		    expires_at = $3,
		    notify_emails = $4,
		    send_expiry_reminder = $5,
		    reminder_sent_at = CASE WHEN expires_at IS DISTINCT FROM $3 THEN NULL ELSE reminder_sent_at END
		WHERE id = $1
	`, id, name, expiresAt, pq.Array(notifyEmails), sendReminder)
	if err != nil {
		return fmt.Errorf("UpdateRegistrationGroup: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// DeleteRegistrationGroup removes a group; its slots and their reservations
// cascade. Consumed slots' registered accounts are unaffected (their space is
// tracked by user_drive_allocations, not the slot row).
func (q *Queries) DeleteRegistrationGroup(ctx context.Context, id uuid.UUID) error {
	res, err := q.db.ExecContext(ctx, `DELETE FROM registration_groups WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("DeleteRegistrationGroup: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// ── Reservations ──────────────────────────────────────────────────────────────

// ReleaseExpiredSlotReservations marks every expired, still-open reservation
// released so its slot becomes claimable again. Called before each new
// reservation (and by the reminder sweep) so the partial unique index on live
// reservations stays accurate without a background reaper.
func (q *Queries) ReleaseExpiredSlotReservations(ctx context.Context) (int64, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE registration_slot_reservations
		SET released_at = NOW()
		WHERE expires_at <= NOW() AND completed_at IS NULL AND released_at IS NULL
	`)
	if err != nil {
		return 0, fmt.Errorf("ReleaseExpiredSlotReservations: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// ReserveRegistrationSlot places a hold on a free slot of the same type as the
// referenced slot (the referenced slot itself when free, else any identical
// sibling in the group), valid until expiresAt. Expired holds are swept first.
// Returns ErrSlotNotFound when slotID is unknown, ErrNoFreeSlot when every
// slot of the type is consumed or held.
func (q *Queries) ReserveRegistrationSlot(ctx context.Context, slotID uuid.UUID, token string, expiresAt time.Time) (*models.RegistrationSlotReservation, error) {
	tx, err := q.pool.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("ReserveRegistrationSlot: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		UPDATE registration_slot_reservations
		SET released_at = NOW()
		WHERE expires_at <= NOW() AND completed_at IS NULL AND released_at IS NULL
	`); err != nil {
		return nil, fmt.Errorf("ReserveRegistrationSlot: sweep: %w", err)
	}

	var (
		groupID          uuid.UUID
		serverID         uuid.UUID
		driveType        string
		quotaBytes       int64
		accountStatus    string
		premiumExpiresAt sql.NullTime
	)
	err = tx.QueryRowContext(ctx, `
		SELECT group_id, server_id, drive_type, quota_bytes, account_status, premium_expires_at
		FROM registration_slots WHERE id = $1
	`, slotID).Scan(&groupID, &serverID, &driveType, &quotaBytes, &accountStatus, &premiumExpiresAt)
	if err == sql.ErrNoRows {
		return nil, ErrSlotNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("ReserveRegistrationSlot: target: %w", err)
	}

	var freeSlotID uuid.UUID
	err = tx.QueryRowContext(ctx, `
		SELECT s.id FROM registration_slots s
		WHERE s.group_id = $1 AND s.server_id = $2 AND s.drive_type = $3
		  AND s.quota_bytes = $4 AND s.account_status = $5
		  AND s.premium_expires_at IS NOT DISTINCT FROM $6
		  AND s.consumed_at IS NULL
		  AND NOT EXISTS (
			SELECT 1 FROM registration_slot_reservations r
			WHERE r.slot_id = s.id AND r.completed_at IS NULL AND r.released_at IS NULL)
		ORDER BY s.created_at ASC
		FOR UPDATE OF s SKIP LOCKED
		LIMIT 1
	`, groupID, serverID, driveType, quotaBytes, accountStatus, premiumExpiresAt).Scan(&freeSlotID)
	if err == sql.ErrNoRows {
		return nil, ErrNoFreeSlot
	}
	if err != nil {
		return nil, fmt.Errorf("ReserveRegistrationSlot: find free slot: %w", err)
	}

	var res models.RegistrationSlotReservation
	res.Token = token
	if err := tx.QueryRowContext(ctx, `
		INSERT INTO registration_slot_reservations (slot_id, token, expires_at)
		VALUES ($1, $2, $3)
		RETURNING id, slot_id, expires_at, created_at
	`, freeSlotID, token, expiresAt).Scan(&res.ID, &res.SlotID, &res.ExpiresAt, &res.CreatedAt); err != nil {
		return nil, fmt.Errorf("ReserveRegistrationSlot: insert: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("ReserveRegistrationSlot: commit: %w", err)
	}
	return &res, nil
}

// SlotReservationInfo is a reservation joined to its slot, group, and server —
// everything the registration page and register endpoint need in one lookup.
type SlotReservationInfo struct {
	Reservation models.RegistrationSlotReservation
	Slot        models.RegistrationSlot
	ServerName  string
	GroupID     uuid.UUID
	GroupName   string
	GroupLinkID string
	// GroupUsable is false when the group has been deactivated (an expired
	// group stays usable for an already-held reservation).
	GroupUsable bool
}

// GetSlotReservationByToken looks up a reservation by token regardless of its
// state — the caller decides how to treat expired/completed/released holds
// (the register page needs expired ones to show the session-expired modal
// with a link back to the group page). Returns sql.ErrNoRows when unknown.
func (q *Queries) GetSlotReservationByToken(ctx context.Context, token string) (*SlotReservationInfo, error) {
	var info SlotReservationInfo
	err := q.db.QueryRowContext(ctx, `
		SELECT r.id, r.slot_id, r.token, r.expires_at, r.completed_at, r.released_at, r.created_at,
		       s.id, s.group_id, s.server_id, s.drive_id, s.drive_type, s.quota_bytes,
		       s.account_status, s.premium_expires_at, s.consumed_at, s.consumed_by, s.created_at,
		       sv.name, g.id, g.name, g.link_id, g.is_active
		FROM registration_slot_reservations r
		JOIN registration_slots s ON s.id = r.slot_id
		JOIN registration_groups g ON g.id = s.group_id
		JOIN servers sv ON sv.id = s.server_id
		WHERE r.token = $1
	`, token).Scan(
		&info.Reservation.ID, &info.Reservation.SlotID, &info.Reservation.Token,
		&info.Reservation.ExpiresAt, &info.Reservation.CompletedAt, &info.Reservation.ReleasedAt,
		&info.Reservation.CreatedAt,
		&info.Slot.ID, &info.Slot.GroupID, &info.Slot.ServerID, &info.Slot.DriveID,
		&info.Slot.DriveType, &info.Slot.QuotaBytes, &info.Slot.AccountStatus,
		&info.Slot.PremiumExpiresAt, &info.Slot.ConsumedAt, &info.Slot.ConsumedBy, &info.Slot.CreatedAt,
		&info.ServerName, &info.GroupID, &info.GroupName, &info.GroupLinkID, &info.GroupUsable,
	)
	if err != nil {
		return nil, fmt.Errorf("GetSlotReservationByToken: %w", err)
	}
	return &info, nil
}

// ReleaseSlotReservation releases a still-open reservation so its slot becomes
// claimable again. Idempotent — releasing a completed/released hold is a no-op.
func (q *Queries) ReleaseSlotReservation(ctx context.Context, token string) error {
	_, err := q.db.ExecContext(ctx, `
		UPDATE registration_slot_reservations
		SET released_at = NOW()
		WHERE token = $1 AND completed_at IS NULL AND released_at IS NULL
	`, token)
	if err != nil {
		return fmt.Errorf("ReleaseSlotReservation: %w", err)
	}
	return nil
}

// CompleteSlotReservation marks the reservation completed and its slot
// consumed by username, in one transaction. Requires the hold to still be the
// slot's live reservation (not swept or raced away); the slot must not have
// been consumed by someone else in the meantime.
func (q *Queries) CompleteSlotReservation(ctx context.Context, reservationID, slotID uuid.UUID, username string) error {
	tx, err := q.pool.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("CompleteSlotReservation: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx, `
		UPDATE registration_slot_reservations
		SET completed_at = NOW()
		WHERE id = $1 AND completed_at IS NULL AND released_at IS NULL
	`, reservationID)
	if err != nil {
		return fmt.Errorf("CompleteSlotReservation: reservation: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("CompleteSlotReservation: reservation no longer active")
	}

	res, err = tx.ExecContext(ctx, `
		UPDATE registration_slots
		SET consumed_at = NOW(), consumed_by = $2
		WHERE id = $1 AND consumed_at IS NULL
	`, slotID, username)
	if err != nil {
		return fmt.Errorf("CompleteSlotReservation: slot: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("CompleteSlotReservation: slot already consumed")
	}

	return tx.Commit()
}

// ── Expiry reminders ──────────────────────────────────────────────────────────

// ListDueExpiryReminderGroups returns active groups that opted into the
// last-chance reminder, expire within the next 24 hours, and have not had the
// reminder sent yet.
func (q *Queries) ListDueExpiryReminderGroups(ctx context.Context) ([]models.RegistrationGroup, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT id, created_by_user_id, name, link_id, expires_at, is_active,
		       notify_emails, send_expiry_reminder, reminder_sent_at, created_at
		FROM registration_groups
		WHERE send_expiry_reminder
		  AND is_active
		  AND reminder_sent_at IS NULL
		  AND expires_at IS NOT NULL
		  AND expires_at > NOW()
		  AND expires_at <= NOW() + INTERVAL '24 hours'
	`)
	if err != nil {
		return nil, fmt.Errorf("ListDueExpiryReminderGroups: %w", err)
	}
	defer rows.Close()

	var out []models.RegistrationGroup
	for rows.Next() {
		var g models.RegistrationGroup
		if err := rows.Scan(
			&g.ID, &g.CreatedByUserID, &g.Name, &g.LinkID, &g.ExpiresAt, &g.IsActive,
			pq.Array(&g.NotifyEmails), &g.SendExpiryReminder, &g.ReminderSentAt, &g.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("ListDueExpiryReminderGroups scan: %w", err)
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// ClaimExpiryReminder atomically stamps reminder_sent_at so exactly one worker
// sends a group's reminder. Returns false when it was already claimed.
func (q *Queries) ClaimExpiryReminder(ctx context.Context, id uuid.UUID) (bool, error) {
	res, err := q.db.ExecContext(ctx, `
		UPDATE registration_groups SET reminder_sent_at = NOW()
		WHERE id = $1 AND reminder_sent_at IS NULL
	`, id)
	if err != nil {
		return false, fmt.Errorf("ClaimExpiryReminder: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// CountAvailableRegistrationSlots returns the number of the group's slots not
// yet consumed (transient reservations still count as available — the email
// copy describes slots that can still end up registered).
func (q *Queries) CountAvailableRegistrationSlots(ctx context.Context, groupID uuid.UUID) (int, error) {
	var n int
	err := q.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM registration_slots
		WHERE group_id = $1 AND consumed_at IS NULL
	`, groupID).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("CountAvailableRegistrationSlots: %w", err)
	}
	return n, nil
}

// ── Creation-page capacity ────────────────────────────────────────────────────

// ServerTierAvailability is the most additional quota a single new slot of the
// given tier could reserve on the server right now (best drive's remaining
// space after user allocations and existing slot reservations).
type ServerTierAvailability struct {
	ServerID       uuid.UUID `json:"server_id"`
	ServerName     string    `json:"server_name"`
	DriveType      string    `json:"drive_type"`
	AvailableBytes int64     `json:"available_bytes"`
}

// GetServerTierAvailability returns one row per (active server, tier that has
// at least one active drive). Backs the group-creation page's server dropdown
// and fast/standard tier buttons.
func (q *Queries) GetServerTierAvailability(ctx context.Context) ([]ServerTierAvailability, error) {
	rows, err := q.db.QueryContext(ctx, `
		SELECT s.id, s.name, d.drive_type,
		       MAX(GREATEST(d.capacity_bytes - COALESCE(a.allocated, 0) - COALESCE(r.reserved, 0), 0))
		FROM drives d
		JOIN servers s ON s.id = d.server_id
		LEFT JOIN (
			SELECT uda.drive_id, SUM(uda.quota_bytes) AS allocated
			FROM user_drive_allocations uda GROUP BY uda.drive_id
		) a ON a.drive_id = d.id
		LEFT JOIN (`+reservedSlotBytesSubquery+`
		) r ON r.drive_id = d.id
		WHERE d.is_active AND s.is_active
		GROUP BY s.id, s.name, d.drive_type
		ORDER BY s.name ASC, d.drive_type ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("GetServerTierAvailability: %w", err)
	}
	defer rows.Close()

	var out []ServerTierAvailability
	for rows.Next() {
		var a ServerTierAvailability
		if err := rows.Scan(&a.ServerID, &a.ServerName, &a.DriveType, &a.AvailableBytes); err != nil {
			return nil, fmt.Errorf("GetServerTierAvailability scan: %w", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
