package models

import (
	"time"

	"github.com/google/uuid"
)

// Node represents a single machine in a server's Docker Swarm cluster. A server
// owns one or more nodes; physical drives are mounted on a node. Roles:
//
//	"manager" — control plane + app stack host (usually the server host itself)
//	"worker"  — swarm worker that may carry storage
//	"storage" — worker dedicated to holding drives
type Node struct {
	ID       uuid.UUID `json:"id"`
	ServerID uuid.UUID `json:"server_id"`
	Hostname string    `json:"hostname"`
	Role     string    `json:"role"`
	Address  string    `json:"address"`
	// MinioEndpoint, when non-nil, overrides the parent server's MinIO endpoint
	// for drives mounted on this node ("host:port"). Nil means the drive inherits
	// the server's endpoint. Credentials are always inherited from the server.
	MinioEndpoint *string   `json:"minio_endpoint,omitempty"`
	MinioUseSSL   bool      `json:"minio_use_ssl"`
	IsActive      bool      `json:"is_active"`
	CreatedAt     time.Time `json:"created_at"`
}

// NodeSummary is returned by GetNodeSummaries for the infrastructure view. It
// carries the parent server's display fields so the frontend can render the full
// server → node → drive tree, including nodes that currently hold no drives.
type NodeSummary struct {
	NodeID         uuid.UUID `json:"node_id"`
	ServerID       uuid.UUID `json:"server_id"`
	ServerName     string    `json:"server_name"`
	ServerState    string    `json:"server_state"`
	ServerIsActive bool      `json:"server_is_active"`
	Hostname       string    `json:"hostname"`
	Role           string    `json:"role"`
	Address        string    `json:"address"`
	IsActive       bool      `json:"is_active"`
	CreatedAt      time.Time `json:"created_at"`
}
