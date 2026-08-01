package admin

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// SetRegistrationGroupService installs the limited-user-group-registration
// service. Wired from main once constructed; nil is tolerated and causes the
// registration-group endpoints to return 503.
func (h *Handler) SetRegistrationGroupService(svc *services.RegistrationGroupService) {
	h.regGroups = svc
}

func (h *Handler) regGroupsConfigured(c *gin.Context) bool {
	if h.regGroups == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "group registration is not configured"})
		return false
	}
	return true
}

type createRegistrationSlotSpec struct {
	ServerID      uuid.UUID `json:"server_id" binding:"required"`
	DriveType     string    `json:"drive_type" binding:"required"` // "nvme" | "hdd"
	QuotaBytes    int64     `json:"quota_bytes" binding:"required"`
	AccountStatus string    `json:"account_status" binding:"required"` // "base" | "premium"
	// PremiumExpiresAt is an optional RFC3339 trial expiry, premium slots only.
	PremiumExpiresAt *string `json:"premium_expires_at"`
	Count            int     `json:"count" binding:"required,min=1,max=500"`
}

type createRegistrationGroupRequest struct {
	Name string `json:"name" binding:"required,max=120"`
	// ExpiresAt is an optional RFC3339 overall registration expiry.
	ExpiresAt          *string                      `json:"expires_at"`
	NotifyEmails       []string                     `json:"notify_emails" binding:"omitempty,max=50,dive,email,max=254"`
	SendExpiryReminder bool                         `json:"send_expiry_reminder"`
	Slots              []createRegistrationSlotSpec `json:"slots" binding:"required,min=1,max=100"`
}

func parseOptionalRFC3339(raw *string) (*time.Time, bool) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil, true
	}
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(*raw))
	if err != nil {
		return nil, false
	}
	return &t, true
}

// CreateRegistrationGroup handles POST /api/v1/admin/registration-groups.
// Creates the group and its slots (pre-reserving their capacity on the chosen
// server tiers), generates the public link id, and enqueues the notification
// email to the notify list.
func (h *Handler) CreateRegistrationGroup(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	var req createRegistrationGroupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a name and at least one valid slot are required"})
		return
	}

	createdByRaw, _ := c.Get("userID")
	createdBy, err := uuid.Parse(createdByRaw.(string))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "invalid user context"})
		return
	}

	expiresAt, ok := parseOptionalRFC3339(req.ExpiresAt)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "expires_at must be an RFC3339 timestamp"})
		return
	}

	in := services.CreateRegistrationGroupInput{
		Name:               req.Name,
		ExpiresAt:          expiresAt,
		NotifyEmails:       req.NotifyEmails,
		SendExpiryReminder: req.SendExpiryReminder,
	}
	for _, s := range req.Slots {
		premiumExpiresAt, ok := parseOptionalRFC3339(s.PremiumExpiresAt)
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "premium_expires_at must be an RFC3339 timestamp"})
			return
		}
		in.Slots = append(in.Slots, services.RegistrationSlotSpecInput{
			ServerID:         s.ServerID,
			DriveType:        s.DriveType,
			QuotaBytes:       s.QuotaBytes,
			AccountStatus:    s.AccountStatus,
			PremiumExpiresAt: premiumExpiresAt,
			Count:            s.Count,
		})
	}

	detail, err := h.regGroups.Create(c.Request.Context(), createdBy, in)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrGroupNameRequired),
			errors.Is(err, services.ErrGroupExpiryInPast),
			errors.Is(err, services.ErrGroupNeedsSlots),
			errors.Is(err, services.ErrInvalidSlotSpec):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrSlotCapacityExceeded):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create the registration group"})
		}
		return
	}
	c.JSON(http.StatusCreated, detail)
}

type updateRegistrationGroupRequest struct {
	Name string `json:"name" binding:"required,max=120"`
	// ExpiresAt is an optional RFC3339 overall registration expiry.
	ExpiresAt          *string  `json:"expires_at"`
	NotifyEmails       []string `json:"notify_emails" binding:"omitempty,max=50,dive,email,max=254"`
	SendExpiryReminder bool     `json:"send_expiry_reminder"`
}

// UpdateRegistrationGroup handles PATCH /api/v1/admin/registration-groups/:id.
// Edits the group's name, overall expiry, notify list, and reminder opt-in —
// slots are immutable once created (see the edit screen's read-only slots
// list); deactivate or delete the group to change its capacity instead.
func (h *Handler) UpdateRegistrationGroup(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid registration group id"})
		return
	}
	var req updateRegistrationGroupRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a name is required"})
		return
	}
	expiresAt, ok := parseOptionalRFC3339(req.ExpiresAt)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "expires_at must be an RFC3339 timestamp"})
		return
	}
	detail, err := h.regGroups.Update(c.Request.Context(), id, services.UpdateRegistrationGroupInput{
		Name:               req.Name,
		ExpiresAt:          expiresAt,
		NotifyEmails:       req.NotifyEmails,
		SendExpiryReminder: req.SendExpiryReminder,
	})
	if err != nil {
		switch {
		case errors.Is(err, services.ErrGroupNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrGroupNameRequired), errors.Is(err, services.ErrGroupExpiryInPast):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update the registration group"})
		}
		return
	}
	c.JSON(http.StatusOK, detail)
}

type addRegistrationSlotsRequest struct {
	Slots []createRegistrationSlotSpec `json:"slots" binding:"required,min=1,max=100"`
}

// AddRegistrationSlots handles POST /api/v1/admin/registration-groups/:id/slots.
// Appends new slots to an already-existing group — existing slots (and their
// consumed/reserved status) are untouched.
func (h *Handler) AddRegistrationSlots(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid registration group id"})
		return
	}
	var req addRegistrationSlotsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "at least one valid slot is required"})
		return
	}
	specs := make([]services.RegistrationSlotSpecInput, len(req.Slots))
	for i, s := range req.Slots {
		premiumExpiresAt, ok := parseOptionalRFC3339(s.PremiumExpiresAt)
		if !ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": "premium_expires_at must be an RFC3339 timestamp"})
			return
		}
		specs[i] = services.RegistrationSlotSpecInput{
			ServerID:         s.ServerID,
			DriveType:        s.DriveType,
			QuotaBytes:       s.QuotaBytes,
			AccountStatus:    s.AccountStatus,
			PremiumExpiresAt: premiumExpiresAt,
			Count:            s.Count,
		}
	}
	detail, err := h.regGroups.AddSlots(c.Request.Context(), id, specs)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrGroupNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrGroupNeedsSlots), errors.Is(err, services.ErrInvalidSlotSpec):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrSlotCapacityExceeded):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not add slots to the registration group"})
		}
		return
	}
	c.JSON(http.StatusOK, detail)
}

// registrationSlotSignatureRequest identifies one slot type — the same
// grouping key ListRegistrationSlotTypes uses — for the delete/replace
// endpoints below.
type registrationSlotSignatureRequest struct {
	ServerID         uuid.UUID `json:"server_id" binding:"required"`
	DriveType        string    `json:"drive_type" binding:"required"`
	QuotaBytes       int64     `json:"quota_bytes" binding:"required"`
	AccountStatus    string    `json:"account_status" binding:"required"`
	PremiumExpiresAt *string   `json:"premium_expires_at"`
}

func (r registrationSlotSignatureRequest) toSignature() (db.RegistrationSlotSignature, bool) {
	premiumExpiresAt, ok := parseOptionalRFC3339(r.PremiumExpiresAt)
	if !ok {
		return db.RegistrationSlotSignature{}, false
	}
	return db.RegistrationSlotSignature{
		ServerID:         r.ServerID,
		DriveType:        r.DriveType,
		QuotaBytes:       r.QuotaBytes,
		AccountStatus:    r.AccountStatus,
		PremiumExpiresAt: premiumExpiresAt,
	}, true
}

// DeleteRegistrationSlotType handles DELETE /api/v1/admin/registration-groups/:id/slots.
// Removes every currently-free slot matching the signature in the body;
// consumed or actively-reserved slots of the same configuration are left
// untouched.
func (h *Handler) DeleteRegistrationSlotType(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid registration group id"})
		return
	}
	var req registrationSlotSignatureRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a valid slot signature is required"})
		return
	}
	sig, ok := req.toSignature()
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "premium_expires_at must be an RFC3339 timestamp"})
		return
	}
	detail, err := h.regGroups.DeleteSlotType(c.Request.Context(), id, sig)
	if err != nil {
		if errors.Is(err, services.ErrGroupNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete these slots"})
		return
	}
	c.JSON(http.StatusOK, detail)
}

type replaceRegistrationSlotTypeRequest struct {
	Old registrationSlotSignatureRequest `json:"old" binding:"required"`
	New createRegistrationSlotSpec       `json:"new" binding:"required"`
}

// ReplaceRegistrationSlotType handles PUT /api/v1/admin/registration-groups/:id/slots.
// Atomically swaps every currently-free slot matching `old` for `new.count`
// new slots configured per `new` — backs the edit screen's per-row "Edit"
// action on an unclaimed slot type. Consumed or actively-reserved slots
// matching `old` are left untouched.
func (h *Handler) ReplaceRegistrationSlotType(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid registration group id"})
		return
	}
	var req replaceRegistrationSlotTypeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "old and new slot configurations are required"})
		return
	}
	oldSig, ok := req.Old.toSignature()
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "old.premium_expires_at must be an RFC3339 timestamp"})
		return
	}
	newPremiumExpiresAt, ok := parseOptionalRFC3339(req.New.PremiumExpiresAt)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "new.premium_expires_at must be an RFC3339 timestamp"})
		return
	}
	newSpec := services.RegistrationSlotSpecInput{
		ServerID:         req.New.ServerID,
		DriveType:        req.New.DriveType,
		QuotaBytes:       req.New.QuotaBytes,
		AccountStatus:    req.New.AccountStatus,
		PremiumExpiresAt: newPremiumExpiresAt,
		Count:            req.New.Count,
	}
	detail, err := h.regGroups.ReplaceSlotType(c.Request.Context(), id, oldSig, newSpec)
	if err != nil {
		switch {
		case errors.Is(err, services.ErrGroupNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrInvalidSlotSpec):
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		case errors.Is(err, services.ErrSlotCapacityExceeded):
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not replace these slots"})
		}
		return
	}
	c.JSON(http.StatusOK, detail)
}

// registrationGroupRow decorates a summary with the full public invite URL.
type registrationGroupRow struct {
	models.RegistrationGroupSummary
	GroupInviteURL string `json:"group_invite_url"`
}

// ListRegistrationGroups handles GET /api/v1/admin/registration-groups.
// Returns a page of groups (newest first) with slot counts and the copyable
// public invite link.
func (h *Handler) ListRegistrationGroups(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	page := db.PageInput{Cursor: strings.TrimSpace(c.Query("cursor"))}
	if err := parseLimit(c, &page.Limit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be a positive integer"})
		return
	}
	result, err := h.regGroups.List(c.Request.Context(), page)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list registration groups"})
		return
	}
	items := make([]registrationGroupRow, len(result.Items))
	for i, g := range result.Items {
		items[i] = registrationGroupRow{
			RegistrationGroupSummary: g,
			GroupInviteURL:           h.regGroups.GroupInviteURL(g.LinkID),
		}
	}
	c.JSON(http.StatusOK, db.PageResult[registrationGroupRow]{
		Items:     items,
		NextToken: result.NextToken,
	})
}

// GetRegistrationGroup handles GET /api/v1/admin/registration-groups/:id.
// Returns the group with its itemized slot types (identical slots grouped
// with per-status counts) for the table's inline details view.
func (h *Handler) GetRegistrationGroup(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid registration group id"})
		return
	}
	detail, err := h.regGroups.Detail(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, services.ErrGroupNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "registration group not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load the registration group"})
		return
	}
	c.JSON(http.StatusOK, detail)
}

// DeactivateRegistrationGroup handles POST /api/v1/admin/registration-groups/:id/deactivate.
// Turns the public link off and releases the unconsumed slots' capacity holds.
func (h *Handler) DeactivateRegistrationGroup(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid registration group id"})
		return
	}
	if err := h.regGroups.Deactivate(c.Request.Context(), id); err != nil {
		if errors.Is(err, services.ErrGroupNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "registration group not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not deactivate the registration group"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "registration group deactivated"})
}

// DeleteRegistrationGroup handles DELETE /api/v1/admin/registration-groups/:id.
// Removes the group and its slots; accounts already registered are unaffected.
func (h *Handler) DeleteRegistrationGroup(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid registration group id"})
		return
	}
	if err := h.regGroups.Delete(c.Request.Context(), id); err != nil {
		if errors.Is(err, services.ErrGroupNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "registration group not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete the registration group"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "registration group deleted"})
}

// GetRegistrationCapacity handles GET /api/v1/admin/registration-groups/capacity.
// Returns per (server, tier) how much space a new slot could still reserve —
// after user allocations AND existing slot reservations — so the creation page
// can hide unavailable tier buttons and clamp slot capacities.
func (h *Handler) GetRegistrationCapacity(c *gin.Context) {
	if !h.regGroupsConfigured(c) {
		return
	}
	rows, err := h.regGroups.ServerTierAvailability(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load capacity"})
		return
	}
	if rows == nil {
		rows = []db.ServerTierAvailability{}
	}
	c.JSON(http.StatusOK, gin.H{"tiers": rows})
}
