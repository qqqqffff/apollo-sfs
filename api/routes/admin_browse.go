package routes

import (
	"database/sql"
	"errors"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

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
	UsedBytes     int64  `json:"used_bytes"` // this user's bytes on the drive
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

	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil {
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

	breakdown, err := h.queries.GetUserStorageBreakdown(c.Request.Context(), userID.String())
	if err != nil {
		log.Printf("AdminGetUserStorage: breakdown for %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load storage breakdown"})
		return
	}

	allocs, err := h.queries.GetUserStorageAllocations(c.Request.Context(), username, userID.String())
	if err != nil {
		log.Printf("AdminGetUserStorage: allocations for %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load storage allocations"})
		return
	}

	activeReqs, err := h.queries.CountActiveExpansionRequests(c.Request.Context(), username)
	if err != nil {
		log.Printf("AdminGetUserStorage: active requests for %q: %v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load requests"})
		return
	}

	resp := adminUserStorageResponse{
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
			UsedBytes:     a.UserUsedBytes,
			IsPrimary:     a.IsPrimary,
		}
	}
	c.JSON(http.StatusOK, resp)
}
