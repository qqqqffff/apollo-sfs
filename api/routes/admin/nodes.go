package admin

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/sanitize"
)

// validNodeRoles bounds the role field to the swarm roles the UI understands.
var validNodeRoles = map[string]bool{"manager": true, "worker": true, "storage": true}

type createNodeRequest struct {
	Hostname string `json:"hostname" binding:"required"`
	Role     string `json:"role"`
	Address  string `json:"address"`
	// MinioEndpoint optionally overrides the parent server's MinIO endpoint for
	// drives mounted on this node ("host:port"). Omit/empty to inherit the
	// server's endpoint. Credentials are always inherited from the server.
	MinioEndpoint string `json:"minio_endpoint"`
	MinioUseSSL   bool   `json:"minio_use_ssl"`
}

// CreateNode handles POST /api/v1/admin/system/servers/:server_id/nodes.
// Registers a swarm node under a server.
func (h *Handler) CreateNode(c *gin.Context) {
	ctx := c.Request.Context()
	serverID, err := uuid.Parse(c.Param("server_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid server_id"})
		return
	}

	var req createNodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	server, err := h.queries.GetServer(ctx, serverID)
	if err != nil || server == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "server not found"})
		return
	}

	role := strings.ToLower(sanitize.String(req.Role))
	if role == "" {
		role = "worker"
	}
	if !validNodeRoles[role] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "role must be one of: manager, worker, storage"})
		return
	}

	var endpoint *string
	if ep := sanitize.String(req.MinioEndpoint); ep != "" {
		endpoint = &ep
	}

	node, err := h.queries.CreateNode(ctx, db.CreateNodeParams{
		ServerID:      serverID,
		Hostname:      sanitize.String(req.Hostname),
		Role:          role,
		Address:       sanitize.String(req.Address),
		MinioEndpoint: endpoint,
		MinioUseSSL:   req.MinioUseSSL,
	})
	if err != nil {
		if strings.Contains(err.Error(), "unique") {
			c.JSON(http.StatusConflict, gin.H{"error": "a node with that hostname already exists on this server"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create node"})
		return
	}

	// Open a MinIO client for the node's endpoint override so uploads route to it
	// without a restart. Inherits the server's credentials.
	if h.registry != nil && endpoint != nil {
		if err := h.registry.RegisterNode(node, server); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not register node MinIO client"})
			return
		}
	}

	c.JSON(http.StatusCreated, node)
}

type updateNodeRequest struct {
	Hostname string  `json:"hostname"`
	Role     string  `json:"role"`
	Address  *string `json:"address"`
	// MinioEndpoint present (non-nil) applies a new endpoint override; an empty
	// string clears it (the node falls back to the server's endpoint). Absent
	// (nil) leaves it unchanged.
	MinioEndpoint *string `json:"minio_endpoint"`
	MinioUseSSL   *bool   `json:"minio_use_ssl"`
	IsActive      *bool   `json:"is_active"`
}

// UpdateNode handles PATCH /api/v1/admin/system/servers/:server_id/nodes/:node_id.
func (h *Handler) UpdateNode(c *gin.Context) {
	ctx := c.Request.Context()
	nodeID, err := uuid.Parse(c.Param("node_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid node_id"})
		return
	}

	var req updateNodeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	existing, err := h.queries.GetNode(ctx, nodeID)
	if err != nil || existing == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}

	hostname := existing.Hostname
	if req.Hostname != "" {
		hostname = sanitize.String(req.Hostname)
	}
	role := existing.Role
	if req.Role != "" {
		role = strings.ToLower(sanitize.String(req.Role))
		if !validNodeRoles[role] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "role must be one of: manager, worker, storage"})
			return
		}
	}
	address := existing.Address
	if req.Address != nil {
		address = sanitize.String(*req.Address)
	}
	isActive := existing.IsActive
	if req.IsActive != nil {
		isActive = *req.IsActive
	}
	// Endpoint override: absent leaves it unchanged; empty clears it.
	endpoint := existing.MinioEndpoint
	useSSL := existing.MinioUseSSL
	if req.MinioEndpoint != nil {
		if ep := sanitize.String(*req.MinioEndpoint); ep != "" {
			endpoint = &ep
		} else {
			endpoint = nil
		}
	}
	if req.MinioUseSSL != nil {
		useSSL = *req.MinioUseSSL
	}

	node, err := h.queries.UpdateNode(ctx, nodeID, db.UpdateNodeParams{
		Hostname:      hostname,
		Role:          role,
		Address:       address,
		MinioEndpoint: endpoint,
		MinioUseSSL:   useSSL,
		IsActive:      isActive,
	})
	if err != nil {
		if strings.Contains(err.Error(), "unique") {
			c.JSON(http.StatusConflict, gin.H{"error": "a node with that hostname already exists on this server"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update node"})
		return
	}

	// Reconcile the node's MinIO client: (re)register when it has an endpoint,
	// remove it when the override was cleared, so routing follows immediately.
	if h.registry != nil {
		if node.MinioEndpoint != nil {
			server, err := h.queries.GetServer(ctx, node.ServerID)
			if err == nil && server != nil {
				if err := h.registry.RegisterNode(node, server); err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "could not register node MinIO client"})
					return
				}
			}
		} else {
			h.registry.Remove(node.ID)
		}
	}

	c.JSON(http.StatusOK, node)
}

// DeleteNode handles DELETE /api/v1/admin/system/servers/:server_id/nodes/:node_id.
// Drives mounted on the node are detached (not deleted) via ON DELETE SET NULL.
func (h *Handler) DeleteNode(c *gin.Context) {
	ctx := c.Request.Context()
	nodeID, err := uuid.Parse(c.Param("node_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid node_id"})
		return
	}

	existing, err := h.queries.GetNode(ctx, nodeID)
	if err != nil || existing == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}

	if err := h.queries.DeleteNode(ctx, nodeID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete node"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "node deleted"})
}
