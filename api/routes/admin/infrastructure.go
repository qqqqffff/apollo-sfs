package admin

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

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
	IsActive *bool `json:"is_active"`
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

	c.JSON(http.StatusOK, gin.H{"message": "server updated"})
}

type addDriveRequest struct {
	Label         string `json:"label" binding:"required"`
	MinioBucket   string `json:"minio_bucket" binding:"required"`
	CapacityBytes int64  `json:"capacity_bytes" binding:"required,min=1"`
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
		CapacityBytes: req.CapacityBytes,
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

	c.JSON(http.StatusCreated, drive)
}

type updateDriveRequest struct {
	Label         string `json:"label"`
	CapacityBytes int64  `json:"capacity_bytes"`
	IsActive      *bool  `json:"is_active"`
}

// UpdateDrive handles PATCH /api/v1/admin/system/servers/:server_id/drives/:drive_id.
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
	capacityBytes := existing.CapacityBytes
	if req.CapacityBytes > 0 {
		capacityBytes = req.CapacityBytes
	}
	isActive := existing.IsActive
	if req.IsActive != nil {
		isActive = *req.IsActive
	}

	drive, err := h.queries.UpdateDrive(ctx, driveID, db.UpdateDriveParams{
		Label:         label,
		CapacityBytes: capacityBytes,
		IsActive:      isActive,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update drive"})
		return
	}

	c.JSON(http.StatusOK, drive)
}

// parseLimit is used by server-statistics.go but defined in a shared spot.
// If it's already defined there, this file won't duplicate it.
var _ = errors.New // ensure errors is used
