package services

import (
	"context"
	"fmt"
	"sync"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	"apollo-sfs.com/api/db"
)

// MinIORegistry maintains one *minio.Core client per server, loaded from the
// database at startup. FileService uses it to route each operation to the
// MinIO instance that hosts the user's drive.
type MinIORegistry struct {
	mu      sync.RWMutex
	clients map[uuid.UUID]*minio.Core
	kek     []byte // key-encryption key; stored so new servers can encrypt credentials
}

// NewMinIORegistry loads all active servers from the DB, decrypts their
// credentials using kek, and opens a client for each.
func NewMinIORegistry(ctx context.Context, queries *db.Queries, kek []byte) (*MinIORegistry, error) {
	servers, err := queries.ListServers(ctx)
	if err != nil {
		return nil, fmt.Errorf("minio registry: list servers: %w", err)
	}

	r := &MinIORegistry{clients: make(map[uuid.UUID]*minio.Core), kek: kek}
	for _, s := range servers {
		if !s.IsActive {
			continue
		}
		accessKey, err := DecryptMinIOSecret(kek, s.MinioAccessKeyEnc, s.MinioAccessKeyNonce)
		if err != nil {
			return nil, fmt.Errorf("minio registry: decrypt access key for server %s: %w", s.Name, err)
		}
		secretKey, err := DecryptMinIOSecret(kek, s.MinioSecretKeyEnc, s.MinioSecretKeyNonce)
		if err != nil {
			return nil, fmt.Errorf("minio registry: decrypt secret key for server %s: %w", s.Name, err)
		}
		client, err := NewMinIOClient(s.MinioEndpoint, accessKey, secretKey, s.MinioUseSSL)
		if err != nil {
			return nil, fmt.Errorf("minio registry: connect to server %s (%s): %w", s.Name, s.MinioEndpoint, err)
		}
		r.clients[s.ID] = client
	}
	return r, nil
}

// Client returns the *minio.Core for the given server ID, or false if unknown.
func (r *MinIORegistry) Client(serverID uuid.UUID) (*minio.Core, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	c, ok := r.clients[serverID]
	return c, ok
}

// Register adds or replaces a client for a server (e.g. after adding a new
// server at runtime via the admin UI).
func (r *MinIORegistry) Register(serverID uuid.UUID, client *minio.Core) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clients[serverID] = client
}

// Remove removes the client for a server (e.g. after deactivating it).
func (r *MinIORegistry) Remove(serverID uuid.UUID) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.clients, serverID)
}

// KEK returns the key-encryption key so admin handlers can encrypt new server credentials.
func (r *MinIORegistry) KEK() []byte {
	return r.kek
}
