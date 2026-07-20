package models

import (
	"time"

	"github.com/google/uuid"
)

// FileServerLink is a premium WebDAV mount link scoped to one drive — a
// single server + storage tier (fast/NVMe or standard/HDD).
// The raw token is part of the mount URL (https://<app>/dav/<token>) and is
// stored in plain text: possession of the URL alone grants nothing — every
// DAV request must additionally present the owner's login credentials via
// HTTP Basic auth, which are verified against Keycloak. The token itself is
// human-readable (<server-slug>-<tier>-<8 random chars>, see
// generateMountToken in the service) since it's what shows up in Explorer/
// Finder's network location once mounted.
type FileServerLink struct {
	ID       uuid.UUID `json:"id"`
	Token    string    `json:"-"` // never returned directly; the service exposes the full mount URL
	Username string    `json:"-"`
	UserID   uuid.UUID `json:"-"`
	ServerID uuid.UUID `json:"server_id"`
	DriveID  uuid.UUID `json:"drive_id"`
	// ServerName and DriveType are joined from servers/drives for display;
	// not stored on the row.
	ServerName       string     `json:"server_name"`
	DriveType        string     `json:"drive_type"` // "nvme" | "hdd"
	EnhancedSecurity bool       `json:"enhanced_security"`
	CreatedAt        time.Time  `json:"created_at"`
	LastUsedAt       *time.Time `json:"last_used_at"`
}

// FileServerLinkLocation records one source IP seen by a link with enhanced
// security enabled. The location is trusted while verified_at is within the
// verification window (30 days); afterwards a new emailed verification is
// required before uploads/downloads resume from that IP.
type FileServerLinkLocation struct {
	ID                 uuid.UUID  `json:"id"`
	LinkID             uuid.UUID  `json:"link_id"`
	SourceIP           string     `json:"source_ip"`
	VerificationToken  *string    `json:"-"`
	VerificationSentAt *time.Time `json:"verification_sent_at"`
	VerifiedAt         *time.Time `json:"verified_at"`
	CreatedAt          time.Time  `json:"created_at"`
}
