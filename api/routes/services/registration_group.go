package services

import (
	"context"
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// slotReservationTTL is how long a user has to complete registration after
// selecting a slot on the group-invite page before the hold is released for
// someone else.
const slotReservationTTL = 10 * time.Minute

// expiryReminderCheckInterval is how often the background loop looks for
// groups whose last-chance reminder is due.
const expiryReminderCheckInterval = 15 * time.Minute

// ── Types ─────────────────────────────────────────────────────────────────────

// RegistrationSlotSpecInput is one slot configuration from the creation page,
// expanded into Count identical slots.
type RegistrationSlotSpecInput struct {
	ServerID         uuid.UUID
	DriveType        string // "nvme" | "hdd"
	QuotaBytes       int64
	AccountStatus    string // "base" | "premium"
	PremiumExpiresAt *time.Time
	Count            int
}

// CreateRegistrationGroupInput carries everything the creation page submits.
type CreateRegistrationGroupInput struct {
	Name               string
	ExpiresAt          *time.Time
	NotifyEmails       []string
	SendExpiryReminder bool
	Slots              []RegistrationSlotSpecInput
}

// PublicGroupInvite is the payload of the public group-invite page: the group
// plus its slot types with availability counts. The raw group ID and notify
// list are never exposed publicly.
type PublicGroupInvite struct {
	Name      string                        `json:"name"`
	LinkID    string                        `json:"link_id"`
	ExpiresAt *time.Time                    `json:"expires_at,omitempty"`
	SlotTypes []models.RegistrationSlotType `json:"slot_types"`
}

// SlotReservationValidation is what the register page needs to render the
// reservation-token registration flow, including the link back to the group
// page for the session-expired modal.
type SlotReservationValidation struct {
	// Status is "active", "expired" (incl. released), or "completed".
	Status           string     `json:"status"`
	ExpiresAt        time.Time  `json:"expires_at"`
	GroupName        string     `json:"group_name"`
	GroupLinkID      string     `json:"group_link_id"`
	ServerName       string     `json:"server_name"`
	DriveType        string     `json:"drive_type"`
	QuotaBytes       int64      `json:"quota_bytes"`
	AccountStatus    string     `json:"account_status"`
	PremiumExpiresAt *time.Time `json:"premium_expires_at,omitempty"`
}

// RegistrationGroupDetail is a group summary plus its grouped slot types, for
// the admin table's inline details view.
type RegistrationGroupDetail struct {
	models.RegistrationGroupSummary
	GroupInviteURL string                        `json:"group_invite_url"`
	SlotTypes      []models.RegistrationSlotType `json:"slot_types"`
}

// ── Service ───────────────────────────────────────────────────────────────────

// RegistrationGroupService owns the limited-user-group-registration feature:
// admin CRUD on groups/slots, public slot reservation, and the notification /
// last-chance emails.
type RegistrationGroupService struct {
	queries *db.Queries
	email   *EmailService // optional — nil skips email sending with a log warning
	appURL  string
}

// NewRegistrationGroupService constructs the service. emailSvc may be nil in
// development.
func NewRegistrationGroupService(q *db.Queries, emailSvc *EmailService, appURL string) *RegistrationGroupService {
	return &RegistrationGroupService{
		queries: q,
		email:   emailSvc,
		appURL:  strings.TrimRight(appURL, "/"),
	}
}

// GroupInviteURL builds the public registration URL for a link id, following
// the https://<app>/group-invite?id=<group-name>-<rand4> standard.
func (s *RegistrationGroupService) GroupInviteURL(linkID string) string {
	return s.appURL + "/group-invite?id=" + linkID
}

// ── Admin operations ──────────────────────────────────────────────────────────

// Create validates the input, generates the public link id, creates the group
// and its slots (pre-reserving their capacity), and enqueues the notification
// email to every address in NotifyEmails.
func (s *RegistrationGroupService) Create(ctx context.Context, createdBy uuid.UUID, in CreateRegistrationGroupInput) (*RegistrationGroupDetail, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, ErrGroupNameRequired
	}
	slug := slugifyGroupName(name)
	if slug == "" {
		return nil, ErrGroupNameRequired
	}
	if in.ExpiresAt != nil && !in.ExpiresAt.After(time.Now()) {
		return nil, ErrGroupExpiryInPast
	}
	if len(in.Slots) == 0 {
		return nil, ErrGroupNeedsSlots
	}
	totalSlots := 0
	for _, spec := range in.Slots {
		if err := validateSlotSpec(spec); err != nil {
			return nil, err
		}
		totalSlots += spec.Count
	}

	specs := make([]db.NewRegistrationSlotSpec, len(in.Slots))
	for i, spec := range in.Slots {
		specs[i] = toDBSlotSpec(spec)
	}

	// The 4-char suffix keeps the link unguessable-ish and unique per name;
	// retry a few times on the (unlikely) collision of an identical name+suffix.
	var group *models.RegistrationGroup
	for attempt := 0; attempt < 5; attempt++ {
		suffix, err := randomAlphanumeric(4)
		if err != nil {
			return nil, fmt.Errorf("create registration group: suffix: %w", err)
		}
		g := &models.RegistrationGroup{
			CreatedByUserID:    createdBy,
			Name:               name,
			LinkID:             slug + "-" + suffix,
			ExpiresAt:          in.ExpiresAt,
			NotifyEmails:       normalizeEmails(in.NotifyEmails),
			SendExpiryReminder: in.SendExpiryReminder,
		}
		err = s.queries.CreateRegistrationGroup(ctx, g, specs)
		if err == nil {
			group = g
			break
		}
		if errors.Is(err, db.ErrNoCapacity) {
			return nil, ErrSlotCapacityExceeded
		}
		if isDuplicateKeyError(err) {
			continue
		}
		return nil, fmt.Errorf("create registration group: %w", err)
	}
	if group == nil {
		return nil, fmt.Errorf("create registration group: could not generate a unique link id")
	}

	inviteURL := s.GroupInviteURL(group.LinkID)
	if len(group.NotifyEmails) > 0 {
		if s.email != nil {
			expiresAt := ""
			if group.ExpiresAt != nil {
				expiresAt = group.ExpiresAt.Format("January 2, 2006 3:04 PM MST")
			}
			if err := s.email.SendGroupInviteNotification(ctx, group.NotifyEmails, group.Name, totalSlots, inviteURL, expiresAt); err != nil {
				log.Printf("registration group: enqueue notification emails: %v", err)
			}
		} else {
			log.Printf("registration group: email service not configured — invite URL: %s", inviteURL)
		}
	}

	return s.Detail(ctx, group.ID)
}

// UpdateRegistrationGroupInput carries the editable fields from the group
// edit screen. Slots aren't part of this input — they're immutable once
// created (see Create's doc comment); create a new group for different slots.
type UpdateRegistrationGroupInput struct {
	Name               string
	ExpiresAt          *time.Time
	NotifyEmails       []string
	SendExpiryReminder bool
}

// Update edits a group's name, overall expiry, notify list, and reminder
// opt-in. Slots cannot be added, removed, or modified after creation — their
// capacity is already reserved and may be consumed or actively held by a
// visitor mid-registration.
func (s *RegistrationGroupService) Update(ctx context.Context, id uuid.UUID, in UpdateRegistrationGroupInput) (*RegistrationGroupDetail, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, ErrGroupNameRequired
	}
	if in.ExpiresAt != nil && !in.ExpiresAt.After(time.Now()) {
		return nil, ErrGroupExpiryInPast
	}
	if err := s.queries.UpdateRegistrationGroup(ctx, id, name, in.ExpiresAt, normalizeEmails(in.NotifyEmails), in.SendExpiryReminder); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrGroupNotFound
		}
		return nil, fmt.Errorf("update registration group: %w", err)
	}
	return s.Detail(ctx, id)
}

// List returns a page of group summaries for the admin table.
func (s *RegistrationGroupService) List(ctx context.Context, page db.PageInput) (*db.PageResult[models.RegistrationGroupSummary], error) {
	return s.queries.ListRegistrationGroups(ctx, page)
}

// validateSlotSpec applies the same per-slot rules Create uses to a spec
// destined for AddSlots or ReplaceSlotType.
func validateSlotSpec(spec RegistrationSlotSpecInput) error {
	if spec.Count < 1 {
		return fmt.Errorf("%w: slot count must be at least 1", ErrInvalidSlotSpec)
	}
	if spec.QuotaBytes <= 0 {
		return fmt.Errorf("%w: slot capacity must be positive", ErrInvalidSlotSpec)
	}
	if spec.DriveType != "nvme" && spec.DriveType != "hdd" {
		return fmt.Errorf("%w: tier must be fast (nvme) or standard (hdd)", ErrInvalidSlotSpec)
	}
	// Admin accounts cannot be provisioned through a registration group.
	if spec.AccountStatus != "base" && spec.AccountStatus != "premium" {
		return fmt.Errorf("%w: account status must be base or premium", ErrInvalidSlotSpec)
	}
	if spec.AccountStatus != "premium" && spec.PremiumExpiresAt != nil {
		return fmt.Errorf("%w: premium expiry is only valid on premium slots", ErrInvalidSlotSpec)
	}
	if spec.PremiumExpiresAt != nil && !spec.PremiumExpiresAt.After(time.Now()) {
		return fmt.Errorf("%w: premium expiry must be in the future", ErrInvalidSlotSpec)
	}
	return nil
}

func toDBSlotSpec(spec RegistrationSlotSpecInput) db.NewRegistrationSlotSpec {
	return db.NewRegistrationSlotSpec{
		ServerID:         spec.ServerID,
		DriveType:        spec.DriveType,
		QuotaBytes:       spec.QuotaBytes,
		AccountStatus:    spec.AccountStatus,
		PremiumExpiresAt: spec.PremiumExpiresAt,
		Count:            spec.Count,
	}
}

// requireGroupExists is a cheap existence check so Add/ReplaceSlotType fail
// with a clean ErrGroupNotFound up front, instead of a raw FK-violation error
// surfacing from the insert step once the group turns out to be gone.
func (s *RegistrationGroupService) requireGroupExists(ctx context.Context, id uuid.UUID) error {
	if _, err := s.queries.GetRegistrationGroupSummary(ctx, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrGroupNotFound
		}
		return fmt.Errorf("registration group lookup: %w", err)
	}
	return nil
}

// AddSlots appends new slots to an existing group, reserving their capacity
// the same way Create does. Existing slots are untouched.
func (s *RegistrationGroupService) AddSlots(ctx context.Context, groupID uuid.UUID, specs []RegistrationSlotSpecInput) (*RegistrationGroupDetail, error) {
	if len(specs) == 0 {
		return nil, ErrGroupNeedsSlots
	}
	if err := s.requireGroupExists(ctx, groupID); err != nil {
		return nil, err
	}
	dbSpecs := make([]db.NewRegistrationSlotSpec, len(specs))
	for i, spec := range specs {
		if err := validateSlotSpec(spec); err != nil {
			return nil, err
		}
		dbSpecs[i] = toDBSlotSpec(spec)
	}
	if err := s.queries.AddRegistrationSlots(ctx, groupID, dbSpecs); err != nil {
		if errors.Is(err, db.ErrNoCapacity) {
			return nil, ErrSlotCapacityExceeded
		}
		return nil, fmt.Errorf("add registration slots: %w", err)
	}
	return s.Detail(ctx, groupID)
}

// DeleteSlotType removes every currently-free (unconsumed, unreserved) slot
// matching sig within the group. Consumed or actively-held slots of the same
// configuration are left untouched — the edit screen never offers them for
// deletion in the first place.
func (s *RegistrationGroupService) DeleteSlotType(ctx context.Context, groupID uuid.UUID, sig db.RegistrationSlotSignature) (*RegistrationGroupDetail, error) {
	if _, err := s.queries.DeleteFreeRegistrationSlots(ctx, groupID, sig); err != nil {
		return nil, fmt.Errorf("delete slot type: %w", err)
	}
	return s.Detail(ctx, groupID)
}

// ReplaceSlotType swaps every currently-free slot matching oldSig for
// newSpec.Count new slots of newSpec's configuration, in one transaction.
// Consumed or actively-held slots matching oldSig are left untouched — this
// is how the edit screen "edits" an unclaimed slot type in place.
func (s *RegistrationGroupService) ReplaceSlotType(ctx context.Context, groupID uuid.UUID, oldSig db.RegistrationSlotSignature, newSpec RegistrationSlotSpecInput) (*RegistrationGroupDetail, error) {
	if err := validateSlotSpec(newSpec); err != nil {
		return nil, err
	}
	if err := s.requireGroupExists(ctx, groupID); err != nil {
		return nil, err
	}
	if err := s.queries.ReplaceRegistrationSlotType(ctx, groupID, oldSig, toDBSlotSpec(newSpec)); err != nil {
		if errors.Is(err, db.ErrNoCapacity) {
			return nil, ErrSlotCapacityExceeded
		}
		return nil, fmt.Errorf("replace slot type: %w", err)
	}
	return s.Detail(ctx, groupID)
}

// Detail returns one group with its grouped slot types.
func (s *RegistrationGroupService) Detail(ctx context.Context, id uuid.UUID) (*RegistrationGroupDetail, error) {
	summary, err := s.queries.GetRegistrationGroupSummary(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrGroupNotFound
		}
		return nil, fmt.Errorf("registration group detail: %w", err)
	}
	types, err := s.queries.ListRegistrationSlotTypes(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("registration group detail: %w", err)
	}
	return &RegistrationGroupDetail{
		RegistrationGroupSummary: *summary,
		GroupInviteURL:           s.GroupInviteURL(summary.LinkID),
		SlotTypes:                types,
	}, nil
}

// Deactivate turns the group's link off and releases its unconsumed slots'
// capacity reservations.
func (s *RegistrationGroupService) Deactivate(ctx context.Context, id uuid.UUID) error {
	if err := s.queries.SetRegistrationGroupActive(ctx, id, false); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrGroupNotFound
		}
		return fmt.Errorf("deactivate registration group: %w", err)
	}
	return nil
}

// Delete removes the group and its slots. Accounts already registered through
// consumed slots are unaffected.
func (s *RegistrationGroupService) Delete(ctx context.Context, id uuid.UUID) error {
	if err := s.queries.DeleteRegistrationGroup(ctx, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrGroupNotFound
		}
		return fmt.Errorf("delete registration group: %w", err)
	}
	return nil
}

// ServerTierAvailability backs the creation page: per (server, tier) how much
// space is left for a new slot to reserve.
func (s *RegistrationGroupService) ServerTierAvailability(ctx context.Context) ([]db.ServerTierAvailability, error) {
	return s.queries.GetServerTierAvailability(ctx)
}

// ── Public operations ─────────────────────────────────────────────────────────

// PublicInvite resolves a link id for the public group-invite page. Returns
// ErrGroupNotFound for unknown links, ErrGroupInactive when deactivated, and
// ErrGroupExpired when past its expiry.
func (s *RegistrationGroupService) PublicInvite(ctx context.Context, linkID string) (*PublicGroupInvite, error) {
	group, err := s.queries.GetRegistrationGroupByLinkID(ctx, linkID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrGroupNotFound
		}
		return nil, fmt.Errorf("public group invite: %w", err)
	}
	if !group.IsActive {
		return nil, ErrGroupInactive
	}
	if group.ExpiresAt != nil && time.Now().After(*group.ExpiresAt) {
		return nil, ErrGroupExpired
	}
	// Sweep expired holds so availability counts are live.
	if _, err := s.queries.ReleaseExpiredSlotReservations(ctx); err != nil {
		log.Printf("public group invite: sweep expired reservations: %v", err)
	}
	types, err := s.queries.ListRegistrationSlotTypes(ctx, group.ID)
	if err != nil {
		return nil, fmt.Errorf("public group invite: %w", err)
	}
	return &PublicGroupInvite{
		Name:      group.Name,
		LinkID:    group.LinkID,
		ExpiresAt: group.ExpiresAt,
		SlotTypes: types,
	}, nil
}

// Reserve places a 10-minute hold on a free slot of the same type as slotID
// within the group behind linkID, and returns the reservation token the
// register page uses. The slot type's availability drops by one for everyone
// else until the hold completes, is released, or expires.
func (s *RegistrationGroupService) Reserve(ctx context.Context, linkID string, slotID uuid.UUID) (token string, expiresAt time.Time, err error) {
	group, err := s.queries.GetRegistrationGroupByLinkID(ctx, linkID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", time.Time{}, ErrGroupNotFound
		}
		return "", time.Time{}, fmt.Errorf("reserve slot: %w", err)
	}
	if !group.IsActive {
		return "", time.Time{}, ErrGroupInactive
	}
	if group.ExpiresAt != nil && time.Now().After(*group.ExpiresAt) {
		return "", time.Time{}, ErrGroupExpired
	}

	tok, err := generateInviteToken()
	if err != nil {
		return "", time.Time{}, fmt.Errorf("reserve slot: token: %w", err)
	}
	res, err := s.queries.ReserveRegistrationSlot(ctx, slotID, tok, time.Now().UTC().Add(slotReservationTTL))
	if err != nil {
		if errors.Is(err, db.ErrSlotNotFound) {
			return "", time.Time{}, ErrGroupNotFound
		}
		if errors.Is(err, db.ErrNoFreeSlot) {
			return "", time.Time{}, ErrNoSlotAvailable
		}
		return "", time.Time{}, fmt.Errorf("reserve slot: %w", err)
	}
	// The slot must belong to the group the link identifies — otherwise a
	// valid link could reserve slots out of a different group.
	info, err := s.queries.GetSlotReservationByToken(ctx, tok)
	if err != nil || info.GroupID != group.ID {
		_ = s.queries.ReleaseSlotReservation(ctx, tok)
		return "", time.Time{}, ErrGroupNotFound
	}
	return tok, res.ExpiresAt, nil
}

// ValidateReservation resolves a reservation token for the register page.
// Returns ErrReservationNotFound for unknown tokens; expired/released and
// completed holds resolve with their status so the page can show the
// session-expired modal (with the way back to the group page) or a friendly
// already-used message.
func (s *RegistrationGroupService) ValidateReservation(ctx context.Context, token string) (*SlotReservationValidation, error) {
	info, err := s.queries.GetSlotReservationByToken(ctx, token)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrReservationNotFound
		}
		return nil, fmt.Errorf("validate reservation: %w", err)
	}
	status := "active"
	switch {
	case info.Reservation.CompletedAt != nil:
		status = "completed"
	case info.Reservation.ReleasedAt != nil,
		time.Now().After(info.Reservation.ExpiresAt),
		info.Slot.ConsumedAt != nil,
		!info.GroupUsable:
		status = "expired"
	}
	return &SlotReservationValidation{
		Status:           status,
		ExpiresAt:        info.Reservation.ExpiresAt,
		GroupName:        info.GroupName,
		GroupLinkID:      info.GroupLinkID,
		ServerName:       info.ServerName,
		DriveType:        info.Slot.DriveType,
		QuotaBytes:       info.Slot.QuotaBytes,
		AccountStatus:    info.Slot.AccountStatus,
		PremiumExpiresAt: info.Slot.PremiumExpiresAt,
	}, nil
}

// Release frees a still-open reservation (user backed out before finishing).
func (s *RegistrationGroupService) Release(ctx context.Context, token string) error {
	return s.queries.ReleaseSlotReservation(ctx, token)
}

// ── Last-chance reminder loop ─────────────────────────────────────────────────

// ExpiryReminderLoop periodically sends the opted-in "last chance" email to a
// group's notify list one day before the group's registration link expires,
// with the up-to-date count of slots still available. Runs until ctx is done.
func (s *RegistrationGroupService) ExpiryReminderLoop(ctx context.Context) {
	ticker := time.NewTicker(expiryReminderCheckInterval)
	defer ticker.Stop()
	log.Printf("registration groups: expiry reminder loop started (interval %s)", expiryReminderCheckInterval)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sendDueExpiryReminders(ctx)
		}
	}
}

func (s *RegistrationGroupService) sendDueExpiryReminders(ctx context.Context) {
	if _, err := s.queries.ReleaseExpiredSlotReservations(ctx); err != nil {
		log.Printf("registration groups: reminder sweep: %v", err)
	}
	due, err := s.queries.ListDueExpiryReminderGroups(ctx)
	if err != nil {
		log.Printf("registration groups: list due reminders: %v", err)
		return
	}
	for _, g := range due {
		claimed, err := s.queries.ClaimExpiryReminder(ctx, g.ID)
		if err != nil {
			log.Printf("registration groups: claim reminder %s: %v", g.ID, err)
			continue
		}
		if !claimed {
			continue
		}
		available, err := s.queries.CountAvailableRegistrationSlots(ctx, g.ID)
		if err != nil {
			log.Printf("registration groups: count available %s: %v", g.ID, err)
			continue
		}
		if available == 0 || len(g.NotifyEmails) == 0 || s.email == nil {
			continue // nothing left to offer, nobody to tell, or no mailer
		}
		expiresAt := ""
		if g.ExpiresAt != nil {
			expiresAt = g.ExpiresAt.Format("January 2, 2006 3:04 PM MST")
		}
		if err := s.email.SendGroupInviteLastChance(ctx, g.NotifyEmails, g.Name, available, s.GroupInviteURL(g.LinkID), expiresAt); err != nil {
			log.Printf("registration groups: enqueue last-chance email for %s: %v", g.ID, err)
		}
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// slugifyGroupName lowercases the name and collapses everything that is not
// a letter or digit into single dashes, producing the URL-safe link-id stem.
func slugifyGroupName(name string) string {
	var b strings.Builder
	lastDash := true // suppress a leading dash
	for _, r := range strings.ToLower(name) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			lastDash = false
		default:
			if !lastDash {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

const alphanumerics = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

// randomAlphanumeric returns n cryptographically random alphanumeric characters.
func randomAlphanumeric(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, n)
	for i, b := range buf {
		out[i] = alphanumerics[int(b)%len(alphanumerics)]
	}
	return string(out), nil
}

// normalizeEmails trims and deduplicates the notify list, dropping empties.
func normalizeEmails(emails []string) []string {
	seen := make(map[string]bool, len(emails))
	out := make([]string, 0, len(emails))
	for _, e := range emails {
		e = strings.TrimSpace(e)
		if e == "" || seen[strings.ToLower(e)] {
			continue
		}
		seen[strings.ToLower(e)] = true
		out = append(out, e)
	}
	return out
}

// ── Sentinel errors ───────────────────────────────────────────────────────────

var (
	ErrGroupNameRequired    = errors.New("a group name is required")
	ErrGroupExpiryInPast    = errors.New("the registration expiry must be in the future")
	ErrGroupNeedsSlots      = errors.New("at least one registration slot is required")
	ErrInvalidSlotSpec      = errors.New("invalid slot configuration")
	ErrSlotCapacityExceeded = errors.New("a slot exceeds the remaining capacity of the selected server tier")
	ErrGroupNotFound        = errors.New("registration group not found")
	ErrGroupInactive        = errors.New("this registration link has been deactivated")
	ErrGroupExpired         = errors.New("this registration link has expired")
	ErrNoSlotAvailable      = errors.New("no slot of this type is currently available")
	ErrReservationNotFound  = errors.New("registration session not found")
)
