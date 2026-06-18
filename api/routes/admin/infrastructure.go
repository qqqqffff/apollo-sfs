package admin

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	psdisk "github.com/shirou/gopsutil/v4/disk"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/routes/services"
	"apollo-sfs.com/api/sanitize"
)

// GetInfrastructure handles GET /api/v1/admin/system/infrastructure.
// Returns all servers with their drives and per-drive usage summaries.
func (h *Handler) GetInfrastructure(c *gin.Context) {
	summaries, err := h.queries.GetDriveSummaries(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve infrastructure"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"drives": summaries})
}

// GetCapacity handles GET /api/v1/admin/system/capacity.
// Returns the maximum quota that could be allocated to a new user.
func (h *Handler) GetCapacity(c *gin.Context) {
	max, err := h.queries.GetMaxAvailableQuota(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve capacity"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"max_available_bytes": max})
}

type createServerRequest struct {
	State         string `json:"state" binding:"required,min=2,max=2"`
	MinioEndpoint string `json:"minio_endpoint" binding:"required"`
	MinioUseSSL   bool   `json:"minio_use_ssl"`
	AccessKey     string `json:"access_key" binding:"required"`
	SecretKey     string `json:"secret_key" binding:"required"`
}

// CreateServer handles POST /api/v1/admin/system/servers.
// Test-connects to MinIO before saving; auto-generates the server name.
func (h *Handler) CreateServer(c *gin.Context) {
	ctx := c.Request.Context()
	var req createServerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	state := strings.ToUpper(sanitize.String(req.State))

	// Test-connect to MinIO before persisting credentials.
	client, err := services.NewMinIOClient(req.MinioEndpoint, req.AccessKey, req.SecretKey, req.MinioUseSSL)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("cannot connect to MinIO: %v", err)})
		return
	}

	// Encrypt credentials with the KEK stored in the registry.
	kek := h.registry.KEK()
	accessEnc, accessNonce, err := services.EncryptMinIOSecret(kek, req.AccessKey)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not encrypt credentials"})
		return
	}
	secretEnc, secretNonce, err := services.EncryptMinIOSecret(kek, req.SecretKey)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not encrypt credentials"})
		return
	}

	// Auto-generate name: STATE-NNNN.
	count, err := h.queries.CountServersByState(ctx, state)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not generate server name"})
		return
	}
	name := fmt.Sprintf("%s-%04d", state, count+1)

	server, err := h.queries.CreateServer(ctx, db.CreateServerParams{
		Name:                name,
		State:               state,
		MinioEndpoint:       req.MinioEndpoint,
		MinioUseSSL:         req.MinioUseSSL,
		MinioAccessKeyEnc:   accessEnc,
		MinioAccessKeyNonce: accessNonce,
		MinioSecretKeyEnc:   secretEnc,
		MinioSecretKeyNonce: secretNonce,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create server"})
		return
	}

	// Register the new client immediately so uploads can use it without a restart.
	h.registry.Register(server.ID, client)

	c.JSON(http.StatusCreated, server)
}

type updateServerRequest struct {
	IsActive *bool  `json:"is_active"`
	Name     string `json:"name"`
}

// UpdateServer handles PATCH /api/v1/admin/system/servers/:server_id.
func (h *Handler) UpdateServer(c *gin.Context) {
	ctx := c.Request.Context()
	serverID, err := uuid.Parse(c.Param("server_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid server_id"})
		return
	}

	var req updateServerRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.IsActive != nil {
		if err := h.queries.SetServerActive(ctx, serverID, *req.IsActive); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update server"})
			return
		}
		if !*req.IsActive {
			h.registry.Remove(serverID)
		}
	}

	if name := sanitize.String(req.Name); name != "" {
		if err := h.queries.RenameServer(ctx, serverID, name); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not rename server"})
			return
		}
	}

	c.JSON(http.StatusOK, gin.H{"message": "server updated"})
}

type addDriveRequest struct {
	Label       string `json:"label" binding:"required"`
	MinioBucket string `json:"minio_bucket" binding:"required"`
}

// AddDrive handles POST /api/v1/admin/system/servers/:server_id/drives.
func (h *Handler) AddDrive(c *gin.Context) {
	ctx := c.Request.Context()
	serverID, err := uuid.Parse(c.Param("server_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid server_id"})
		return
	}

	var req addDriveRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Verify the server exists and is active, and get its client so we can
	// ensure the bucket exists.
	server, err := h.queries.GetServer(ctx, serverID)
	if err != nil || server == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "server not found"})
		return
	}
	client, ok := h.registry.Client(serverID)
	if !ok {
		c.JSON(http.StatusConflict, gin.H{"error": "server has no active MinIO client; re-activate it first"})
		return
	}
	if err := services.EnsureBucket(ctx, client, req.MinioBucket); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("cannot ensure bucket: %v", err)})
		return
	}

	drive, err := h.queries.CreateDrive(ctx, db.CreateDriveParams{
		ServerID:      serverID,
		Label:         sanitize.String(req.Label),
		CapacityBytes: 0, // set by Sync once the drive is online
		MinioBucket:   req.MinioBucket,
	})
	if err != nil {
		if strings.Contains(err.Error(), "unique") {
			c.JSON(http.StatusConflict, gin.H{"error": "a drive with that label or bucket already exists on this server"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create drive"})
		return
	}

	// Auto-detect capacity from disk if the stats path is configured.
	if h.diskStatsPath != "" {
		if usage, err := psdisk.Usage(h.diskStatsPath); err == nil {
			if updated, err := h.queries.UpdateDriveCapacity(ctx, drive.ID, int64(usage.Used+usage.Free)); err == nil {
				drive = updated
			}
		}
	}

	c.JSON(http.StatusCreated, drive)
}

type updateDriveRequest struct {
	Label    string `json:"label"`
	IsActive *bool  `json:"is_active"`
}

// UpdateDrive handles PATCH /api/v1/admin/system/servers/:server_id/drives/:drive_id.
// Capacity is read-only via this endpoint; use the sync-capacity endpoint instead.
func (h *Handler) UpdateDrive(c *gin.Context) {
	ctx := c.Request.Context()
	driveID, err := uuid.Parse(c.Param("drive_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid drive_id"})
		return
	}

	var req updateDriveRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	existing, err := h.queries.GetDrive(ctx, driveID)
	if err != nil || existing == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "drive not found"})
		return
	}

	label := existing.Label
	if req.Label != "" {
		label = sanitize.String(req.Label)
	}
	isActive := existing.IsActive
	if req.IsActive != nil {
		isActive = *req.IsActive
	}

	drive, err := h.queries.UpdateDrive(ctx, driveID, db.UpdateDriveParams{
		Label:         label,
		CapacityBytes: existing.CapacityBytes, // never changed here; only via SyncDriveCapacity
		IsActive:      isActive,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update drive"})
		return
	}

	c.JSON(http.StatusOK, drive)
}

// DeleteDrive handles DELETE /api/v1/admin/system/servers/:server_id/drives/:drive_id.
// Refuses if any users are still allocated to the drive.
func (h *Handler) DeleteDrive(c *gin.Context) {
	ctx := c.Request.Context()
	driveID, err := uuid.Parse(c.Param("drive_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid drive_id"})
		return
	}

	existing, err := h.queries.GetDrive(ctx, driveID)
	if err != nil || existing == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "drive not found"})
		return
	}

	if err := h.queries.DeleteDrive(ctx, driveID); err != nil {
		if strings.Contains(err.Error(), "user allocations") {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete drive"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "drive deleted"})
}

// SyncDriveCapacity handles POST /api/v1/admin/system/drives/:drive_id/sync-capacity.
// Re-detects disk capacity from the configured stats path and updates the drive record.
func (h *Handler) SyncDriveCapacity(c *gin.Context) {
	ctx := c.Request.Context()
	driveID, err := uuid.Parse(c.Param("drive_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid drive_id"})
		return
	}

	existing, err := h.queries.GetDrive(ctx, driveID)
	if err != nil || existing == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "drive not found"})
		return
	}

	if h.diskStatsPath == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "disk stats path not configured"})
		return
	}

	usage, err := psdisk.Usage(h.diskStatsPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("could not read disk stats: %v", err)})
		return
	}

	newCapacity := int64(usage.Used) + int64(usage.Free)
	drive, err := h.queries.UpdateDriveCapacity(ctx, driveID, newCapacity)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update drive capacity"})
		return
	}

	c.JSON(http.StatusOK, drive)
}

// parseLimit is used by server-statistics.go but defined in a shared spot.
// If it's already defined there, this file won't duplicate it.
var _ = errors.New // ensure errors is used
