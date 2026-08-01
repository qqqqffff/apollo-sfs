package models

import (
	"time"

	"github.com/google/uuid"
)

// UserPreferences mirrors the `user_preferences` table — one row per user,
// created lazily on first write. UserID is the Keycloak subject (stored as TEXT).
type UserPreferences struct {
	UserID string `json:"user_id" db:"user_id"`
	// MediaAutouploadFolderID, when set, routes every image/video upload into
	// that media folder automatically regardless of the requested target folder.
	MediaAutouploadFolderID *uuid.UUID `json:"media_autoupload_folder_id" db:"media_autoupload_folder_id"`
	// ShowStorageButtons controls the "+" add-storage buttons on the client
	// home page and upload modal. Default true.
	ShowStorageButtons bool `json:"show_storage_buttons" db:"show_storage_buttons"`
	// StoragePromptEnabled auto-opens the storage upgrade modal when an upload
	// would push usage past 75% of quota or exceed it. Default true.
	StoragePromptEnabled bool `json:"storage_prompt_enabled" db:"storage_prompt_enabled"`
	// BackupStaleNotify surfaces a notification-bell warning when the user's
	// most recent Google or email backup is more than 30 days old. Premium/
	// admin only (the update route is premium-gated). Default false.
	BackupStaleNotify bool `json:"backup_stale_notify" db:"backup_stale_notify"`
	// DefaultDriveID, when set, is the drive (server & tier) whose view the file
	// browser lands on for a user with more than one drive allocation. It is a
	// display preference only — distinct from the upload-routing PRIMARY drive
	// (user_drive_allocations.is_primary). NULL means "no explicit default" (the
	// browser falls back to the primary drive, or the drive picker). Set NULL
	// automatically if the referenced drive is removed.
	DefaultDriveID *uuid.UUID `json:"default_drive_id" db:"default_drive_id"`
	// HideBenchmarkPromo hides the drive-speed-benchmark promo card in the Add
	// Storage modal. Default false. Purely cosmetic — never affects the
	// benchmark itself or the admin metrics page.
	HideBenchmarkPromo bool `json:"hide_benchmark_promo" db:"hide_benchmark_promo"`
	// OnboardingBaseSeen / OnboardingPremiumSeen record that the account has
	// been shown the base and premium spotlight tours, so each auto-plays
	// exactly once — on first login, and on the first login where premium is
	// active. Account state rather than browser state on purpose: these used
	// to be localStorage keys, which replayed the tour on every new browser,
	// new device, or cleared-site-data login. Both default false; the
	// "Replay guide" links on the Profile page bypass them entirely.
	OnboardingBaseSeen    bool      `json:"onboarding_base_seen" db:"onboarding_base_seen"`
	OnboardingPremiumSeen bool      `json:"onboarding_premium_seen" db:"onboarding_premium_seen"`
	CreatedAt             time.Time `json:"created_at" db:"created_at"`
	UpdatedAt             time.Time `json:"updated_at" db:"updated_at"`
}
