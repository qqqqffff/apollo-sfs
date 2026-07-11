package routes

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
	"apollo-sfs.com/api/sanitize"
)

func parseUUID(c *gin.Context, param string) (uuid.UUID, error) {
	return uuid.Parse(c.Param(param))
}

// kcID resolves a username to its Keycloak UUID. In tests the resolveKcID
// override is used; in production h.auth.GetUserKcID is called.
func (h *Handler) kcID(c *gin.Context, username string) (uuid.UUID, error) {
	if h.resolveKcID != nil {
		return h.resolveKcID(c.Request.Context(), username)
	}
	return h.auth.GetUserKcID(c.Request.Context(), username)
}

// AdminListUserFolders handles GET /api/v1/admin/users/:user_id/folders.
// Returns the virtual root contents for the specified user (admin only, read-only).
func (h *Handler) AdminListUserFolders(c *gin.Context) {
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	if _, err := h.queries.GetUserByUsername(c.Request.Context(), username); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	userID, err := h.kcID(c, username)
	if err != nil {
		log.Printf("AdminListUserFolders: resolve KC ID for %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not resolve user identity"})
		return
	}

	contents, err := h.folders.ListRoot(
		c.Request.Context(),
		userID,
		parsePage(c, "folder"),
		parsePage(c, "file"),
	)
	if err != nil {
		log.Printf("AdminListUserFolders: username=%s err=%v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list folder contents"})
		return
	}

	c.JSON(http.StatusOK, contents)
}

// AdminGetUserFolder handles GET /api/v1/admin/users/:user_id/folders/:folder_id.
// Returns the folder contents for the specified user (admin only, read-only).
func (h *Handler) AdminGetUserFolder(c *gin.Context) {
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	folderID, err := parseUUID(c, "folder_id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid folder_id"})
		return
	}

	if _, err := h.queries.GetUserByUsername(c.Request.Context(), username); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	userID, err := h.kcID(c, username)
	if err != nil {
		log.Printf("AdminGetUserFolder: resolve KC ID for %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not resolve user identity"})
		return
	}

	contents, err := h.folders.GetContents(
		c.Request.Context(),
		folderID, userID,
		parsePage(c, "folder"),
		parsePage(c, "file"),
	)
	if err != nil {
		if errors.Is(err, services.ErrFolderNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "folder not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve folder"})
		return
	}

	c.JSON(http.StatusOK, contents)
}

// AdminGetUserFavorites handles GET /api/v1/admin/users/:user_id/favorites.
// Returns the favorites for the specified user (admin only, read-only).
func (h *Handler) AdminGetUserFavorites(c *gin.Context) {
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	if _, err := h.queries.GetUserByUsername(c.Request.Context(), username); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	userID, err := h.kcID(c, username)
	if err != nil {
		log.Printf("AdminGetUserFavorites: resolve KC ID for %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not resolve user identity"})
		return
	}

	list, err := h.favorites.List(c.Request.Context(), userID)
	if err != nil {
		log.Printf("AdminGetUserFavorites: username=%s err=%v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve favorites"})
		return
	}

	c.JSON(http.StatusOK, list)
}

// ── Admin per-user storage view ─────────────────────────────────────────────

type adminUserStorageAllocation struct {
	ServerID      string `json:"server_id"`
	ServerName    string `json:"server_name"`
	ServerState   string `json:"server_state"`
	NodeID        string `json:"node_id"`       // "" when unattached to a node
	NodeHostname  string `json:"node_hostname"` // "" when unattached to a node
	DriveID       string `json:"drive_id"`
	DriveLabel    string `json:"drive_label"`
	DriveType     string `json:"drive_type"` // "nvme" (fast) | "hdd" (standard)
	CapacityBytes int64  `json:"capacity_bytes"`
	QuotaBytes    int64  `json:"quota_bytes"` // this user's own slice of the drive, admin-editable
	UsedBytes     int64  `json:"used_bytes"`  // this user's bytes on the drive
	IsPrimary     bool   `json:"is_primary"`
}

type adminUserStorageResponse struct {
	QuotaBytes         int64                        `json:"quota_bytes"`
	UsedBytes          int64                        `json:"used_bytes"`
	NVMEBytes          int64                        `json:"nvme_bytes"` // fast-tier bytes owned
	HDDBytes           int64                        `json:"hdd_bytes"`  // standard-tier bytes owned
	Allocations        []adminUserStorageAllocation `json:"allocations"`
	ActiveRequestCount int                          `json:"active_request_count"`
}

// buildAdminUserStorageResponse assembles the admin per-user storage view —
// shared by AdminGetUserStorage and AdminUpdateUserStorageAllocations so both
// return the exact same shape.
func (h *Handler) buildAdminUserStorageResponse(c *gin.Context, username string, userID uuid.UUID) (*adminUserStorageResponse, error) {
	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil {
		return nil, err
	}

	breakdown, err := h.queries.GetUserStorageBreakdown(c.Request.Context(), userID.String())
	if err != nil {
		return nil, err
	}

	allocs, err := h.queries.GetUserStorageAllocations(c.Request.Context(), username, userID.String())
	if err != nil {
		return nil, err
	}

	activeReqs, err := h.queries.CountActiveExpansionRequests(c.Request.Context(), username)
	if err != nil {
		return nil, err
	}

	resp := &adminUserStorageResponse{
		QuotaBytes:         user.StorageQuotaBytes,
		UsedBytes:          user.StorageUsedBytes,
		NVMEBytes:          breakdown.NVMEBytes,
		HDDBytes:           breakdown.HDDBytes,
		Allocations:        make([]adminUserStorageAllocation, len(allocs)),
		ActiveRequestCount: activeReqs,
	}
	for i, a := range allocs {
		nodeID := ""
		if a.NodeID != nil {
			nodeID = a.NodeID.String()
		}
		resp.Allocations[i] = adminUserStorageAllocation{
			ServerID:      a.ServerID.String(),
			ServerName:    a.ServerName,
			ServerState:   a.ServerState,
			NodeID:        nodeID,
			NodeHostname:  a.NodeHostname,
			DriveID:       a.DriveID.String(),
			DriveLabel:    a.DriveLabel,
			DriveType:     a.DriveType,
			CapacityBytes: a.CapacityBytes,
			QuotaBytes:    a.QuotaBytes,
			UsedBytes:     a.UserUsedBytes,
			IsPrimary:     a.IsPrimary,
		}
	}
	return resp, nil
}

// AdminGetUserStorage handles GET /api/v1/admin/users/:user_id/storage.
// Returns the user's tier usage (fast NVMe vs standard HDD), the servers and
// nodes their storage is allocated on, and the count of active expansion
// requests so the UI can surface a quick link to the requests page.
func (h *Handler) AdminGetUserStorage(c *gin.Context) {
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	if _, err := h.queries.GetUserByUsername(c.Request.Context(), username); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	userID, err := h.kcID(c, username)
	if err != nil {
		log.Printf("AdminGetUserStorage: resolve KC ID for %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not resolve user identity"})
		return
	}

	resp, err := h.buildAdminUserStorageResponse(c, username, userID)
	if err != nil {
		log.Printf("AdminGetUserStorage: %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load storage view"})
		return
	}
	c.JSON(http.StatusOK, resp)
}

// ── Admin storage allocation editor ─────────────────────────────────────────

type updateStorageAllocationsRequest struct {
	Allocations []struct {
		DriveID    string `json:"drive_id" binding:"required"`
		QuotaBytes int64  `json:"quota_bytes" binding:"min=0"`
	} `json:"allocations" binding:"required,min=1,dive"`
	Reason *string `json:"reason"`
}

// AdminUpdateUserStorageAllocations handles PUT
// /api/v1/admin/users/:user_id/storage/allocations. Accepts the full desired
// set of drive allocations for a user and applies it atomically: any
// allocation omitted is removed (only if its used bytes are 0), any present
// but changed is resized (only if it stays >= used bytes, and — when
// growing — fits the drive's remaining headroom), and any new drive_id is
// added as a fresh allocation (subject to the same headroom check). On
// success, updates users.storage_quota_bytes, writes an audit log entry with
// the structured before/after breakdown, inserts a quota_change_notifications
// row for the affected user's bell, and returns the refreshed storage view.
func (h *Handler) AdminUpdateUserStorageAllocations(c *gin.Context) {
	ctx := c.Request.Context()
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	var req updateStorageAllocationsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "at least one allocation is required"})
		return
	}

	if _, err := h.queries.GetUserByUsername(ctx, username); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}
	userID, err := h.kcID(c, username)
	if err != nil {
		log.Printf("AdminUpdateUserStorageAllocations: resolve KC ID for %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not resolve user identity"})
		return
	}

	existing, err := h.queries.GetUserStorageAllocations(ctx, username, userID.String())
	if err != nil {
		log.Printf("AdminUpdateUserStorageAllocations: load existing for %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load current allocations"})
		return
	}
	existingByID := make(map[uuid.UUID]db.UserStorageAllocation, len(existing))
	for _, e := range existing {
		existingByID[e.DriveID] = e
	}

	before := make([]models.QuotaAllocationSnapshot, 0, len(existing))
	for _, e := range existing {
		before = append(before, models.QuotaAllocationSnapshot{
			DriveID: e.DriveID, ServerName: e.ServerName, DriveType: e.DriveType, QuotaBytes: e.QuotaBytes,
		})
	}

	var violations []gin.H
	var want []db.SaveAllocationsParams
	after := make([]models.QuotaAllocationSnapshot, 0, len(req.Allocations))
	seen := map[uuid.UUID]bool{}

	for _, item := range req.Allocations {
		driveID, err := uuid.Parse(item.DriveID)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid drive_id", "drive_id": item.DriveID})
			return
		}
		if seen[driveID] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "duplicate drive_id", "drive_id": item.DriveID})
			return
		}
		seen[driveID] = true

		if ex, ok := existingByID[driveID]; ok {
			if item.QuotaBytes < ex.UserUsedBytes {
				violations = append(violations, gin.H{
					"drive_id": driveID, "code": "used_exceeds_quota",
					"used_bytes": ex.UserUsedBytes, "requested_quota_bytes": item.QuotaBytes,
				})
				continue
			}
			if item.QuotaBytes > ex.QuotaBytes {
				avail, err := h.queries.GetDriveAvailableBytes(ctx, driveID)
				if err != nil {
					log.Printf("AdminUpdateUserStorageAllocations: check capacity %s: %v", driveID, err)
					c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check drive capacity"})
					return
				}
				if item.QuotaBytes > avail+ex.QuotaBytes {
					violations = append(violations, gin.H{
						"drive_id": driveID, "code": "insufficient_capacity",
						"max_bytes": avail + ex.QuotaBytes, "drive_label": ex.DriveLabel,
					})
					continue
				}
			}
			want = append(want, db.SaveAllocationsParams{DriveID: driveID, QuotaBytes: item.QuotaBytes})
			after = append(after, models.QuotaAllocationSnapshot{
				DriveID: driveID, ServerName: ex.ServerName, DriveType: ex.DriveType, QuotaBytes: item.QuotaBytes,
			})
		} else {
			drive, err := h.queries.GetDrive(ctx, driveID)
			if err != nil || drive == nil || !drive.IsActive {
				c.JSON(http.StatusNotFound, gin.H{"error": "drive not found or inactive", "drive_id": driveID})
				return
			}
			server, err := h.queries.GetServer(ctx, drive.ServerID)
			if err != nil || server == nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load drive's server"})
				return
			}
			avail, err := h.queries.GetDriveAvailableBytes(ctx, driveID)
			if err != nil {
				log.Printf("AdminUpdateUserStorageAllocations: check capacity %s: %v", driveID, err)
				c.JSON(http.StatusInternalServerError, gin.H{"error": "could not check drive capacity"})
				return
			}
			if item.QuotaBytes > avail {
				violations = append(violations, gin.H{
					"drive_id": driveID, "code": "insufficient_capacity",
					"max_bytes": avail, "drive_label": drive.Label,
				})
				continue
			}
			want = append(want, db.SaveAllocationsParams{DriveID: driveID, QuotaBytes: item.QuotaBytes})
			after = append(after, models.QuotaAllocationSnapshot{
				DriveID: driveID, ServerName: server.Name, DriveType: drive.DriveType, QuotaBytes: item.QuotaBytes,
			})
		}
	}
	for _, e := range existing {
		if !seen[e.DriveID] && e.UserUsedBytes != 0 {
			violations = append(violations, gin.H{
				"drive_id": e.DriveID, "code": "removal_blocked", "used_bytes": e.UserUsedBytes,
			})
		}
	}
	if len(violations) > 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "one or more allocations are invalid", "violations": violations})
		return
	}
	// A save may never leave the user with zero allocations — they'd have
	// nowhere to upload (GetUserDrive/resolveUploadDrive assume at least one).
	if len(want) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "at least one allocation is required"})
		return
	}

	if _, err := h.queries.SaveUserDriveAllocations(ctx, username, want); err != nil {
		log.Printf("AdminUpdateUserStorageAllocations: save %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save allocations"})
		return
	}

	details := models.StorageAllocationChangeDetails{Reason: req.Reason, Before: before, After: after}
	detailsJSON, _ := json.Marshal(details)
	actor := c.GetString("username")
	h.logAudit(db.AuditInput{
		TargetUsername: username, ActorUsername: actor,
		Action: "storage_allocations_updated", ResourceType: strPtr("user"),
		Details: detailsJSON,
	})
	go func() {
		if err := h.queries.InsertQuotaChangeNotification(context.Background(), db.InsertQuotaChangeNotificationParams{
			Username: username, ChangedBy: actor, Reason: req.Reason, Details: detailsJSON,
		}); err != nil {
			log.Printf("AdminUpdateUserStorageAllocations: notification: %v", err)
		}
	}()

	resp, err := h.buildAdminUserStorageResponse(c, username, userID)
	if err != nil {
		log.Printf("AdminUpdateUserStorageAllocations: reload %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "saved, but could not reload storage view"})
		return
	}
	c.JSON(http.StatusOK, resp)
}
