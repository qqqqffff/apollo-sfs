package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// SwarmNode is the distilled view of a Docker Swarm node used by the
// infrastructure sync. It carries only the fields the reconcile needs.
type SwarmNode struct {
	Hostname  string
	Addr      string
	Tier      string // value of the node's "tier" label ("fast" | "standard" | "")
	IsManager bool
	Ready     bool
}

// SwarmInspector lists the nodes of the Docker Swarm the API runs in. It is an
// interface so the sync handler can be tested with a fake.
type SwarmInspector interface {
	ListNodes(ctx context.Context) ([]SwarmNode, error)
}

// dockerSwarm talks to the Docker Engine API over the mounted unix socket. It
// uses a hand-rolled minimal client rather than the full Docker SDK to avoid
// pulling in that large dependency tree — the only call needed is GET /nodes.
type dockerSwarm struct {
	http   *http.Client
	socket string
}

// noopSwarm is returned when no Docker socket is present (e.g. local dev without
// a swarm). ListNodes yields no nodes so the sync simply finds nothing to add.
type noopSwarm struct{}

func (noopSwarm) ListNodes(context.Context) ([]SwarmNode, error) { return nil, nil }

// NewSwarmInspector returns a SwarmInspector backed by the Docker socket. The
// socket path is taken from DOCKER_HOST (unix:// form) or defaults to
// /var/run/docker.sock. When the socket does not exist a no-op inspector is
// returned so the API still starts outside a swarm.
func NewSwarmInspector() SwarmInspector {
	socket := "/var/run/docker.sock"
	if h := os.Getenv("DOCKER_HOST"); strings.HasPrefix(h, "unix://") {
		socket = strings.TrimPrefix(h, "unix://")
	}
	if _, err := os.Stat(socket); err != nil {
		return noopSwarm{}
	}
	return &dockerSwarm{
		socket: socket,
		http: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, "unix", socket)
				},
			},
		},
	}
}

// dockerNode mirrors the subset of the Docker Engine API node object we parse.
type dockerNode struct {
	Description struct {
		Hostname string `json:"Hostname"`
	} `json:"Description"`
	Spec struct {
		Role   string            `json:"Role"`
		Labels map[string]string `json:"Labels"`
	} `json:"Spec"`
	Status struct {
		State string `json:"State"`
		Addr  string `json:"Addr"`
	} `json:"Status"`
	ManagerStatus *struct {
		Leader bool `json:"Leader"`
	} `json:"ManagerStatus"`
}

func (d *dockerSwarm) ListNodes(ctx context.Context) ([]SwarmNode, error) {
	// The host is ignored (unix socket), but a valid URL is required. A version
	// prefix is omitted so the daemon serves its default API version.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/nodes", nil)
	if err != nil {
		return nil, fmt.Errorf("swarm: build request: %w", err)
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("swarm: list nodes: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("swarm: list nodes: docker returned %s", resp.Status)
	}

	var raw []dockerNode
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("swarm: decode nodes: %w", err)
	}

	out := make([]SwarmNode, 0, len(raw))
	for _, n := range raw {
		out = append(out, SwarmNode{
			Hostname:  n.Description.Hostname,
			Addr:      n.Status.Addr,
			Tier:      n.Spec.Labels["tier"],
			IsManager: n.ManagerStatus != nil || strings.EqualFold(n.Spec.Role, "manager"),
			Ready:     strings.EqualFold(n.Status.State, "ready"),
		})
	}
	return out, nil
}
