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

	node, err := h.queries.CreateNode(ctx, db.CreateNodeParams{
		ServerID: serverID,
		Hostname: sanitize.String(req.Hostname),
		Role:     role,
		Address:  sanitize.String(req.Address),
	})
	if err != nil {
		if strings.Contains(err.Error(), "unique") {
			c.JSON(http.StatusConflict, gin.H{"error": "a node with that hostname already exists on this server"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not create node"})
		return
	}

	c.JSON(http.StatusCreated, node)
}

type updateNodeRequest struct {
	Hostname string `json:"hostname"`
	Role     string `json:"role"`
	Address  *string `json:"address"`
	IsActive *bool   `json:"is_active"`
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

	node, err := h.queries.UpdateNode(ctx, nodeID, db.UpdateNodeParams{
		Hostname: hostname,
		Role:     role,
		Address:  address,
		IsActive: isActive,
	})
	if err != nil {
		if strings.Contains(err.Error(), "unique") {
			c.JSON(http.StatusConflict, gin.H{"error": "a node with that hostname already exists on this server"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not update node"})
		return
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
