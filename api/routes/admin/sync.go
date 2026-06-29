package admin

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// minioInstance is one MinIO endpoint the sync reconciles into a server row. The
// set is derived from configuration (not user input), so servers/nodes/drives are
// discovered automatically rather than entered by hand.
type minioInstance struct {
	tier     string // "fast" | "standard"
	endpoint string
}

// syncSummary is the JSON response of SyncInfrastructure.
type syncSummary struct {
	Servers int `json:"servers"`
	Nodes   int `json:"nodes"`
	Drives  int `json:"drives"`
	Pruned  int `json:"pruned"`
}

// SyncInfrastructure handles POST /api/v1/admin/system/sync.
// It indexes the live Docker Swarm and the configured MinIO instances and
// reconciles a single server → nodes → drives topology in the database:
//   - one server for the whole cluster (anchored by the primary MinIO endpoint),
//   - one node per swarm node (manager/worker); a node whose tier maps to a
//     non-primary endpoint carries that endpoint as an override,
//   - one drive per MinIO bucket, attached to the node fronting that tier, with
//     fast/standard inferred from the tier.
//
// Modelling the cluster as one server (rather than one-per-endpoint) keeps both
// tiers under the same server in the metrics view while still routing each drive
// to the correct MinIO instance via its node's endpoint.
//
// The operation is idempotent: re-running it updates existing rows and marks
// nodes/drives that have disappeared inactive (never deleting them, so user
// allocations are preserved).
func (h *Handler) SyncInfrastructure(c *gin.Context) {
	ctx := c.Request.Context()

	if h.swarm == nil || h.storage == nil || h.minioEndpoint == "" {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "infrastructure sync is not configured"})
		return
	}

	// 1. Discover swarm nodes once.
	swarmNodes, err := h.swarm.ListNodes(ctx)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("could not read swarm: %v", err)})
		return
	}

	// 2. The MinIO instances to reconcile come from configuration. The primary
	// (fast) endpoint anchors the single cluster server; any other endpoint
	// becomes a per-node override.
	instances := []minioInstance{{tier: "fast", endpoint: h.minioEndpoint}}
	if h.minioStandardEndpoint != "" && h.minioStandardEndpoint != h.minioEndpoint {
		instances = append(instances, minioInstance{tier: "standard", endpoint: h.minioStandardEndpoint})
	}
	tierEndpoint := make(map[string]string, len(instances))
	for _, inst := range instances {
		tierEndpoint[inst.tier] = inst.endpoint
	}

	// 3. One server represents the whole cluster.
	server, err := h.ensureServer(ctx, instances[0])
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var summary syncSummary
	summary.Servers = 1

	// 4. Reconcile every swarm node under the cluster server. A node whose tier
	// maps to a non-primary endpoint carries that endpoint as an override; the
	// rest inherit the server's endpoint.
	keepNodes := make([]uuid.UUID, 0, len(swarmNodes))
	nodeByTier := make(map[string]*models.Node)
	var firstNode *models.Node
	for _, sn := range swarmNodes {
		role := "worker"
		if sn.IsManager {
			role = "manager"
		}
		tier := strings.ToLower(sn.Tier)

		var endpoint *string
		useSSL := false
		if ep, ok := tierEndpoint[tier]; ok && ep != "" && ep != server.MinioEndpoint {
			endpoint = &ep
			useSSL = h.minioUseSSL
		}

		node, err := h.queries.UpsertNode(ctx, db.CreateNodeParams{
			ServerID:      server.ID,
			Hostname:      sn.Hostname,
			Role:          role,
			Address:       sn.Addr,
			MinioEndpoint: endpoint,
			MinioUseSSL:   useSSL,
		}, sn.Ready)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not sync node"})
			return
		}
		keepNodes = append(keepNodes, node.ID)
		summary.Nodes++

		// Keep the node's MinIO client in step with its (possibly new) endpoint.
		if h.registry != nil {
			if node.MinioEndpoint != nil {
				if err := h.registry.RegisterNode(node, server); err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "could not register node MinIO client"})
					return
				}
			} else {
				h.registry.Remove(node.ID)
			}
		}

		if firstNode == nil {
			firstNode = node
		}
		nodeByTier[tier] = node
	}

	// 5. Reconcile drives from each MinIO instance's buckets, attaching them to
	// the node that fronts that tier (falling back to the first node).
	keepDrives := make([]uuid.UUID, 0)
	for _, inst := range instances {
		info, err := h.storage.Inspect(ctx, inst.endpoint, h.minioAccessKey, h.minioSecretKey, h.minioUseSSL)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("could not read MinIO %s: %v", inst.endpoint, err)})
			return
		}
		driveType := "hdd"
		if inst.tier == "fast" {
			driveType = "nvme"
		}
		node := nodeByTier[inst.tier]
		if node == nil {
			node = firstNode
		}
		var nodeID *uuid.UUID
		if node != nil {
			id := node.ID
			nodeID = &id
		}
		for _, bucket := range info.Buckets {
			drive, err := h.queries.UpsertDrive(ctx, db.UpsertDriveParams{
				ServerID:      server.ID,
				NodeID:        nodeID,
				Label:         bucket,
				CapacityBytes: info.TotalBytes,
				MinioBucket:   bucket,
				DriveType:     driveType,
				IsActive:      true,
			})
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "could not sync drive"})
				return
			}
			keepDrives = append(keepDrives, drive.ID)
			summary.Drives++
		}
	}

	// 6. Retire nodes/drives that have disappeared from the swarm / MinIO.
	if err := h.queries.DeactivateMissingDrives(ctx, server.ID, keepDrives); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not prune drives"})
		return
	}
	if err := h.queries.DeactivateMissingNodes(ctx, server.ID, keepNodes); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not prune nodes"})
		return
	}

	c.JSON(http.StatusOK, summary)
}

// ensureServer returns the server row for a MinIO instance, creating it (with the
// API's MinIO credentials, encrypted under the KEK) and registering its client
// when absent, or reactivating it when present. The full row is returned so the
// caller can inherit its credentials when registering node-level endpoints.
func (h *Handler) ensureServer(ctx context.Context, inst minioInstance) (*models.Server, error) {
	existing, err := h.queries.GetServerByEndpoint(ctx, inst.endpoint)
	if err != nil {
		return nil, fmt.Errorf("could not look up server")
	}
	if existing != nil {
		if !existing.IsActive {
			if err := h.queries.SetServerActive(ctx, existing.ID, true); err != nil {
				return nil, fmt.Errorf("could not activate server")
			}
			existing.IsActive = true
		}
		h.registerMinIO(existing.ID, inst.endpoint)
		return existing, nil
	}

	kek := h.registry.KEK()
	accessEnc, accessNonce, err := services.EncryptMinIOSecret(kek, h.minioAccessKey)
	if err != nil {
		return nil, fmt.Errorf("could not encrypt credentials")
	}
	secretEnc, secretNonce, err := services.EncryptMinIOSecret(kek, h.minioSecretKey)
	if err != nil {
		return nil, fmt.Errorf("could not encrypt credentials")
	}
	server, err := h.queries.CreateServer(ctx, db.CreateServerParams{
		Name:                fmt.Sprintf("%s-tier", strings.Title(inst.tier)),
		State:               strings.ToUpper(inst.tier),
		MinioEndpoint:       inst.endpoint,
		MinioUseSSL:         h.minioUseSSL,
		MinioAccessKeyEnc:   accessEnc,
		MinioAccessKeyNonce: accessNonce,
		MinioSecretKeyEnc:   secretEnc,
		MinioSecretKeyNonce: secretNonce,
	})
	if err != nil {
		return nil, fmt.Errorf("could not create server")
	}
	h.registerMinIO(server.ID, inst.endpoint)
	return server, nil
}

// registerMinIO opens and registers a MinIO client for a server so uploads and
// the storage inspector can use it without a restart. Best-effort: a failure
// here is logged via the registry but does not abort the sync.
func (h *Handler) registerMinIO(serverID uuid.UUID, endpoint string) {
	if h.registry == nil {
		return
	}
	client, err := services.NewMinIOClient(endpoint, h.minioAccessKey, h.minioSecretKey, h.minioUseSSL)
	if err != nil {
		return
	}
	h.registry.Register(serverID, client)
}
