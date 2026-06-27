package admin

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
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
// reconciles the servers → nodes → drives topology in the database:
//   - one server per configured MinIO endpoint (upserted by endpoint),
//   - one node per swarm node (manager/worker + tier from its labels),
//   - one drive per MinIO bucket (capacity + fast/standard from the MinIO admin
//     API and the owning node's tier).
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

	// 1. Discover swarm nodes once, grouped by their tier label.
	swarmNodes, err := h.swarm.ListNodes(ctx)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("could not read swarm: %v", err)})
		return
	}

	// 2. The MinIO instances to reconcile come from configuration.
	instances := []minioInstance{{tier: "fast", endpoint: h.minioEndpoint}}
	if h.minioStandardEndpoint != "" && h.minioStandardEndpoint != h.minioEndpoint {
		instances = append(instances, minioInstance{tier: "standard", endpoint: h.minioStandardEndpoint})
	}
	singleInstance := len(instances) == 1

	var summary syncSummary
	for _, inst := range instances {
		server, err := h.ensureServer(ctx, inst)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		summary.Servers++

		// 3. Reconcile the nodes that belong to this server. A node belongs here
		// when its tier label matches the instance's tier; with a single instance
		// every swarm node attaches to it.
		keepNodes := make([]uuid.UUID, 0, len(swarmNodes))
		var primaryNode *uuid.UUID
		for _, sn := range swarmNodes {
			if !singleInstance && !strings.EqualFold(sn.Tier, inst.tier) {
				continue
			}
			role := "worker"
			if sn.IsManager {
				role = "manager"
			}
			node, err := h.queries.UpsertNode(ctx, db.CreateNodeParams{
				ServerID: server.ID,
				Hostname: sn.Hostname,
				Role:     role,
				Address:  sn.Addr,
			}, sn.Ready)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "could not sync node"})
				return
			}
			keepNodes = append(keepNodes, node.ID)
			summary.Nodes++
			// Attach drives to the node matching this instance's tier; fall back to
			// the first node when no tier matches (single-instance / unlabelled).
			if primaryNode == nil || strings.EqualFold(sn.Tier, inst.tier) {
				id := node.ID
				primaryNode = &id
			}
		}

		// 4. Reconcile drives from the MinIO instance's buckets + capacity.
		info, err := h.storage.Inspect(ctx, inst.endpoint, h.minioAccessKey, h.minioSecretKey, h.minioUseSSL)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("could not read MinIO %s: %v", inst.endpoint, err)})
			return
		}
		driveType := "hdd"
		if inst.tier == "fast" {
			driveType = "nvme"
		}
		keepDrives := make([]uuid.UUID, 0, len(info.Buckets))
		for _, bucket := range info.Buckets {
			drive, err := h.queries.UpsertDrive(ctx, db.UpsertDriveParams{
				ServerID:      server.ID,
				NodeID:        primaryNode,
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

		// 5. Retire nodes/drives that have disappeared from the swarm / MinIO.
		if err := h.queries.DeactivateMissingDrives(ctx, server.ID, keepDrives); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not prune drives"})
			return
		}
		if err := h.queries.DeactivateMissingNodes(ctx, server.ID, keepNodes); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "could not prune nodes"})
			return
		}
	}

	c.JSON(http.StatusOK, summary)
}

// ensureServer returns the server row for a MinIO instance, creating it (with the
// API's MinIO credentials, encrypted under the KEK) and registering its client
// when absent, or reactivating it when present.
func (h *Handler) ensureServer(ctx context.Context, inst minioInstance) (*serverRef, error) {
	existing, err := h.queries.GetServerByEndpoint(ctx, inst.endpoint)
	if err != nil {
		return nil, fmt.Errorf("could not look up server")
	}
	if existing != nil {
		if !existing.IsActive {
			if err := h.queries.SetServerActive(ctx, existing.ID, true); err != nil {
				return nil, fmt.Errorf("could not activate server")
			}
		}
		h.registerMinIO(existing.ID, inst.endpoint)
		return &serverRef{ID: existing.ID}, nil
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
	return &serverRef{ID: server.ID}, nil
}

// serverRef is the minimal server identity the reconcile needs.
type serverRef struct{ ID uuid.UUID }

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
