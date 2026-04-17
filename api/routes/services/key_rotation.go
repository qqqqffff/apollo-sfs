package services

import (
	"context"
	"fmt"
	"log"
	"time"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

const (
	rotationCheckInterval = 24 * time.Hour
	defaultRotationAge    = 30 * 24 * time.Hour // 30 days
	defaultRewrapBatch    = 50
	defaultBatchSleep     = 100 * time.Millisecond
)

// ── Service ───────────────────────────────────────────────────────────────────

// KeyRotationService drives the 30-day master key rotation schedule.
//
// Rotation sequence (see plan §6):
//  1. Check if active master key is older than rotationAge.
//  2. Generate a new master key and store it as "active" in the DB.
//  3. Mark the old key as "retiring" in the DB.
//  4. Re-wrap all user keys in batches of batchSize.
//  5. Verify no users remain on the old key version.
//  6. Purge the old key material (zeroed in memory, NULL in DB, status=deleted).
//  7. Write a completed rotation log entry.
//
// Crash recovery: on startup, StartScheduler checks for any "retiring" key that
// has no newer "active" key — indicating a crash mid-rotation — and resumes
// re-wrapping from where it stopped (idempotent, based on master_key_version).
type KeyRotationService struct {
	queries     *db.Queries
	enc         *EncryptionService
	rotationAge time.Duration
	batchSize   int
	batchSleep  time.Duration
}

// NewKeyRotationService constructs a KeyRotationService.
// Pass rotationAge = 0 to use the default of 30 days.
func NewKeyRotationService(q *db.Queries, enc *EncryptionService, rotationAge time.Duration) *KeyRotationService {
	if rotationAge <= 0 {
		rotationAge = defaultRotationAge
	}
	return &KeyRotationService{
		queries:     q,
		enc:         enc,
		rotationAge: rotationAge,
		batchSize:   defaultRewrapBatch,
		batchSleep:  defaultBatchSleep,
	}
}

// ── Public methods ────────────────────────────────────────────────────────────

// StartScheduler launches the rotation background goroutine. It checks on
// startup whether any incomplete rotation needs to be resumed, then ticks every
// 24 hours to check whether a new rotation is due. Returns when ctx is cancelled.
func (s *KeyRotationService) StartScheduler(ctx context.Context) {
	log.Printf("key rotation: scheduler started (rotation age %s, check interval %s)",
		s.rotationAge, rotationCheckInterval)

	// Immediately check for incomplete rotation from a previous crash.
	s.resumeIncomplete(ctx)

	ticker := time.NewTicker(rotationCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("key rotation: scheduler stopped")
			return
		case <-ticker.C:
			s.checkAndRotate(ctx)
		}
	}
}

// RotateMasterKey executes a full key rotation synchronously. Can be called
// manually (e.g. for testing or emergency rotation). Returns an error only for
// fatal failures; partial progress is always logged.
func (s *KeyRotationService) RotateMasterKey(ctx context.Context) error {
	activeVer := s.enc.ActiveMasterKeyVersion()
	if activeVer == "" {
		return fmt.Errorf("rotate: no active master key in cache")
	}

	newVer, err := NextKeyVersion(activeVer)
	if err != nil {
		return fmt.Errorf("rotate: next version: %w", err)
	}

	log.Printf("key rotation: starting %s → %s", activeVer, newVer)
	start := time.Now()

	// ── Step 1: Create and activate new master key. ──────────────────────────
	if err := s.enc.CreateAndActivateMasterKey(ctx, newVer); err != nil {
		return fmt.Errorf("rotate: create new key: %w", err)
	}

	// ── Step 2: Mark old key as retiring. ───────────────────────────────────
	if err := s.queries.RetireMasterKey(ctx, activeVer, time.Now().UTC()); err != nil {
		return fmt.Errorf("rotate: retire old key: %w", err)
	}
	log.Printf("key rotation: old key %s → retiring; new key %s → active", activeVer, newVer)

	// ── Step 3: Open a rotation log entry (status=failed until complete). ───
	logID, err := s.queries.CreateKeyRotationLog(ctx, activeVer, newVer)
	if err != nil {
		return fmt.Errorf("rotate: create log: %w", err)
	}

	// ── Step 4: Re-wrap all user keys. ──────────────────────────────────────
	rewrapped, rewrapErr := s.rewrapUsers(ctx, activeVer)
	if rewrapErr != nil {
		log.Printf("key rotation: re-wrap failed after %d users: %v", rewrapped, rewrapErr)
		msg := rewrapErr.Error()
		_ = s.finaliseLog(ctx, logID, models.KeyRotationStatusFailed, rewrapped, &msg)
		return fmt.Errorf("rotate: re-wrap: %w", rewrapErr)
	}
	log.Printf("key rotation: re-wrapped %d users", rewrapped)

	// ── Step 5: Verify no users remain on the old version. ──────────────────
	if err := s.verifyComplete(ctx, activeVer); err != nil {
		msg := err.Error()
		_ = s.finaliseLog(ctx, logID, models.KeyRotationStatusFailed, rewrapped, &msg)
		return fmt.Errorf("rotate: verify: %w", err)
	}

	// ── Step 6: Purge old key material. ─────────────────────────────────────
	s.enc.RemoveMasterKey(activeVer) // zero in memory first
	if err := s.queries.PurgeMasterKey(ctx, activeVer, time.Now().UTC()); err != nil {
		log.Printf("key rotation: WARNING — failed to purge key material for %s from DB: %v", activeVer, err)
		// Non-fatal: the in-memory key is already zeroed. The DB row has
		// status=retiring still, which LoadMasterKeys will attempt on next restart.
	}

	// ── Step 7: Mark rotation complete. ─────────────────────────────────────
	if err := s.finaliseLog(ctx, logID, models.KeyRotationStatusCompleted, rewrapped, nil); err != nil {
		log.Printf("key rotation: WARNING — failed to finalise log %s: %v", logID, err)
	}

	log.Printf("key rotation: completed %s → %s (%d users rewrapped) in %s",
		activeVer, newVer, rewrapped, time.Since(start).Round(time.Millisecond))
	return nil
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// checkAndRotate runs a rotation if the active master key is older than rotationAge.
func (s *KeyRotationService) checkAndRotate(ctx context.Context) {
	active, err := s.queries.GetActiveMasterKey(ctx)
	if err != nil {
		log.Printf("key rotation: check — get active key: %v", err)
		return
	}
	age := time.Since(active.CreatedAt)
	if age < s.rotationAge {
		log.Printf("key rotation: no rotation needed (active key %s age %s < %s)",
			active.ID, age.Round(time.Hour), s.rotationAge)
		return
	}
	log.Printf("key rotation: active key %s is %s old — rotating", active.ID, age.Round(time.Hour))
	if err := s.RotateMasterKey(ctx); err != nil {
		log.Printf("key rotation: %v", err)
	}
}

// resumeIncomplete checks for any "retiring" master key and resumes re-wrapping
// if the rotation was interrupted (e.g. server restart mid-rotation).
func (s *KeyRotationService) resumeIncomplete(ctx context.Context) {
	retiring, err := s.queries.ListMasterKeysByStatus(ctx, models.MasterKeyStatusRetiring)
	if err != nil || len(retiring) == 0 {
		return
	}

	activeVer := s.enc.ActiveMasterKeyVersion()
	for _, old := range retiring {
		remaining, err := s.queries.CountUsersByKeyVersion(ctx, old.ID)
		if err != nil {
			log.Printf("key rotation: resume — count users on %s: %v", old.ID, err)
			continue
		}
		if remaining == 0 {
			// All users already re-wrapped; just purge the key material.
			s.enc.RemoveMasterKey(old.ID)
			if err := s.queries.PurgeMasterKey(ctx, old.ID, time.Now().UTC()); err != nil {
				log.Printf("key rotation: resume — purge %s: %v", old.ID, err)
			}
			log.Printf("key rotation: resume — purged already-complete retiring key %s", old.ID)
			continue
		}

		log.Printf("key rotation: resume — found incomplete rotation %s → %s (%d users remaining)",
			old.ID, activeVer, remaining)

		rewrapped, err := s.rewrapUsers(ctx, old.ID)
		if err != nil {
			log.Printf("key rotation: resume — re-wrap %s → %s: %v", old.ID, activeVer, err)
			continue
		}
		if err := s.verifyComplete(ctx, old.ID); err != nil {
			log.Printf("key rotation: resume — verify %s: %v", old.ID, err)
			continue
		}
		s.enc.RemoveMasterKey(old.ID)
		if err := s.queries.PurgeMasterKey(ctx, old.ID, time.Now().UTC()); err != nil {
			log.Printf("key rotation: resume — purge %s: %v", old.ID, err)
		}
		log.Printf("key rotation: resume — completed %s → %s (%d users rewrapped)",
			old.ID, activeVer, rewrapped)
	}
}

// rewrapUsers iterates all users on oldVer in batches, re-wrapping each key
// under the current active master key (newVer). Returns the total count rewrapped.
// rewrapUsers iterates all users on oldVer in batches, re-wrapping each key
// under whichever version is currently active in the EncryptionService cache.
func (s *KeyRotationService) rewrapUsers(ctx context.Context, oldVer string) (int, error) {
	total := 0
	cursor := ""

	for {
		page, err := s.queries.ListUsersOnKeyVersion(ctx, oldVer, db.PageInput{
			Limit:  s.batchSize,
			Cursor: cursor,
		})
		if err != nil {
			return total, fmt.Errorf("list users on %s: %w", oldVer, err)
		}
		if len(page.Items) == 0 {
			break
		}

		n, err := s.rewrapBatch(ctx, page.Items)
		total += n
		if err != nil {
			return total, err
		}

		if page.NextToken == "" {
			break
		}
		cursor = page.NextToken

		// Brief pause between batches to avoid saturating the DB on the Pi.
		select {
		case <-ctx.Done():
			return total, ctx.Err()
		case <-time.After(s.batchSleep):
		}
	}
	return total, nil
}

// rewrapBatch re-encrypts each user's key under the active master key.
func (s *KeyRotationService) rewrapBatch(ctx context.Context, users []models.User) (int, error) {
	rewrapped := 0
	for _, u := range users {
		// Decrypt with the retiring master key (still in cache).
		plaintext, err := s.enc.DecryptUserKey(u.EncryptedKey, u.KeyNonce, u.MasterKeyVersion)
		if err != nil {
			return rewrapped, fmt.Errorf("decrypt user key for %q: %w", u.Username, err)
		}

		// Re-encrypt with the new active master key.
		newEncKey, newNonce, newVer, err := s.enc.WrapUserKey(plaintext)
		zeroBytes(plaintext) // zero immediately after use
		if err != nil {
			return rewrapped, fmt.Errorf("wrap user key for %q: %w", u.Username, err)
		}

		if err := s.queries.UpdateUserEncryptionKey(ctx, u.Username, newEncKey, newNonce, newVer); err != nil {
			return rewrapped, fmt.Errorf("update user key for %q: %w", u.Username, err)
		}
		rewrapped++
	}
	return rewrapped, nil
}

// verifyComplete confirms that no users remain on the given key version.
func (s *KeyRotationService) verifyComplete(ctx context.Context, oldVer string) error {
	remaining, err := s.queries.CountUsersByKeyVersion(ctx, oldVer)
	if err != nil {
		return fmt.Errorf("count users on %s: %w", oldVer, err)
	}
	if remaining > 0 {
		return fmt.Errorf("%d users still reference key version %s after re-wrap", remaining, oldVer)
	}
	return nil
}

// finaliseLog writes the terminal status to the rotation log row.
func (s *KeyRotationService) finaliseLog(
	ctx context.Context,
	logID string,
	status models.KeyRotationStatus,
	rewrapped int,
	errMsg *string,
) error {
	return s.queries.CompleteKeyRotationLog(ctx, logID, status, rewrapped, time.Now().UTC(), errMsg)
}
