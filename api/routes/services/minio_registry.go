package services

import (
	"context"
	"fmt"
	"sync"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// MinIORegistry maintains one *minio.Core client per MinIO instance in the
// cluster, loaded from the database at startup. Clients are keyed by the UUID of
// whatever owns the endpoint: a server (the default) or a node that overrides its
// server's endpoint. FileService uses ClientForDrive to route each operation to
// the instance that hosts the user's drive.
type MinIORegistry struct {
	mu      sync.RWMutex
	clients map[uuid.UUID]*minio.Core
	kek     []byte // key-encryption key; stored so new servers can encrypt credentials
}

// NewMinIORegistry loads all active servers from the DB, decrypts their
// credentials using kek, and opens a client for each. It then opens a client for
// every active node that overrides its server's endpoint, reusing the parent
// server's credentials.
func NewMinIORegistry(ctx context.Context, queries *db.Queries, kek []byte) (*MinIORegistry, error) {
	servers, err := queries.ListServers(ctx)
	if err != nil {
		return nil, fmt.Errorf("minio registry: list servers: %w", err)
	}

	r := &MinIORegistry{clients: make(map[uuid.UUID]*minio.Core), kek: kek}
	serverByID := make(map[uuid.UUID]*models.Server, len(servers))
	for i := range servers {
		s := &servers[i]
		serverByID[s.ID] = s
		if !s.IsActive {
			continue
		}
		client, err := r.serverClient(s)
		if err != nil {
			return nil, err
		}
		r.clients[s.ID] = client
	}

	// Node-level endpoint overrides: one MinIO instance per node that declares its
	// own endpoint, authenticated with the parent server's credentials.
	nodes, err := queries.ListActiveNodesWithMinIO(ctx)
	if err != nil {
		return nil, fmt.Errorf("minio registry: list nodes: %w", err)
	}
	for i := range nodes {
		n := &nodes[i]
		server, ok := serverByID[n.ServerID]
		if !ok {
			continue // orphaned node; nothing to inherit credentials from
		}
		if err := r.RegisterNode(n, server); err != nil {
			return nil, err
		}
	}
	return r, nil
}

// serverClient decrypts a server's credentials and opens a MinIO client for its
// endpoint.
func (r *MinIORegistry) serverClient(s *models.Server) (*minio.Core, error) {
	accessKey, err := DecryptMinIOSecret(r.kek, s.MinioAccessKeyEnc, s.MinioAccessKeyNonce)
	if err != nil {
		return nil, fmt.Errorf("minio registry: decrypt access key for server %s: %w", s.Name, err)
	}
	secretKey, err := DecryptMinIOSecret(r.kek, s.MinioSecretKeyEnc, s.MinioSecretKeyNonce)
	if err != nil {
		return nil, fmt.Errorf("minio registry: decrypt secret key for server %s: %w", s.Name, err)
	}
	client, err := NewMinIOClient(s.MinioEndpoint, accessKey, secretKey, s.MinioUseSSL)
	if err != nil {
		return nil, fmt.Errorf("minio registry: connect to server %s (%s): %w", s.Name, s.MinioEndpoint, err)
	}
	return client, nil
}

// RegisterNode builds and registers a MinIO client for a node that overrides its
// server's endpoint, reusing the parent server's (decrypted) credentials. The
// client is keyed by the node ID. A node without an endpoint is a no-op (the
// drive falls back to the server's client).
func (r *MinIORegistry) RegisterNode(node *models.Node, server *models.Server) error {
	if node.MinioEndpoint == nil || *node.MinioEndpoint == "" {
		return nil
	}
	accessKey, err := DecryptMinIOSecret(r.kek, server.MinioAccessKeyEnc, server.MinioAccessKeyNonce)
	if err != nil {
		return fmt.Errorf("minio registry: decrypt access key for node %s: %w", node.Hostname, err)
	}
	secretKey, err := DecryptMinIOSecret(r.kek, server.MinioSecretKeyEnc, server.MinioSecretKeyNonce)
	if err != nil {
		return fmt.Errorf("minio registry: decrypt secret key for node %s: %w", node.Hostname, err)
	}
	client, err := NewMinIOClient(*node.MinioEndpoint, accessKey, secretKey, node.MinioUseSSL)
	if err != nil {
		return fmt.Errorf("minio registry: connect to node %s (%s): %w", node.Hostname, *node.MinioEndpoint, err)
	}
	r.Register(node.ID, client)
	return nil
}

// Client returns the *minio.Core for the given owner ID (server or node), or
// false if unknown.
func (r *MinIORegistry) Client(id uuid.UUID) (*minio.Core, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	c, ok := r.clients[id]
	return c, ok
}

// ClientForDrive resolves the MinIO client for a drive: the node's client when
// the drive's node carries its own endpoint, otherwise the server's client.
func (r *MinIORegistry) ClientForDrive(serverID uuid.UUID, nodeID *uuid.UUID, nodeHasEndpoint bool) (*minio.Core, bool) {
	if nodeHasEndpoint && nodeID != nil {
		if c, ok := r.Client(*nodeID); ok {
			return c, true
		}
	}
	return r.Client(serverID)
}

// Register adds or replaces a client for an owner ID (e.g. after adding a new
// server or node at runtime via the admin UI).
func (r *MinIORegistry) Register(id uuid.UUID, client *minio.Core) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clients[id] = client
}

// Remove removes the client for an owner ID (e.g. after deactivating a server or
// clearing a node's endpoint override).
func (r *MinIORegistry) Remove(id uuid.UUID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.clients, id)
}

// KEK returns the key-encryption key so admin handlers can encrypt new server credentials.
func (r *MinIORegistry) KEK() []byte {
	return r.kek
}
