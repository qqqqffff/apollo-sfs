package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/admin"
	"apollo-sfs.com/api/routes/services"
)

// adminInfraConfig wires a single fast-tier MinIO instance with a one-node swarm
// (the manager) holding one bucket, for the sync handler under test.
func adminInfraConfig() admin.InfraSyncConfig {
	return admin.InfraSyncConfig{
		Swarm: fakeSwarm{nodes: []services.SwarmNode{
			{Hostname: "apollo-mgr", Addr: "10.0.0.1", Tier: "fast", IsManager: true, Ready: true},
		}},
		Storage:         fakeStorage{info: services.StorageInfo{Buckets: []string{"sfs-data"}, TotalBytes: 8 << 40}},
		MinIOEndpoint:   "minio:9000",
		MinIOAccessKey:  "key",
		MinIOSecretKey:  "secret",
		MinIOBucketName: "sfs-data",
	}
}

// fakeSwarm is a SwarmInspector returning a fixed node list.
type fakeSwarm struct{ nodes []services.SwarmNode }

func (f fakeSwarm) ListNodes(context.Context) ([]services.SwarmNode, error) { return f.nodes, nil }

// fakeStorage is a StorageInspector returning fixed buckets + capacity.
type fakeStorage struct{ info services.StorageInfo }

func (f fakeStorage) Inspect(context.Context, string, string, string, bool) (services.StorageInfo, error) {
	return f.info, nil
}

// endpointStorage is a StorageInspector returning a different bucket set per
// endpoint, so a multi-tier sync can be asserted to attach the right bucket to
// the right node.
type endpointStorage struct {
	byEndpoint map[string]services.StorageInfo
}

func (f endpointStorage) Inspect(_ context.Context, endpoint, _, _ string, _ bool) (services.StorageInfo, error) {
	return f.byEndpoint[endpoint], nil
}

// syncStub records the upserts the sync performs so the test can assert on them.
type syncStub struct {
	stubAdminQuerier
	serverID         uuid.UUID
	nodes            []db.CreateNodeParams
	drives           []db.UpsertDriveParams
	nodeIDByHostname map[string]uuid.UUID
	prunedNodes      int
	prunedDrvs       int
}

func (s *syncStub) GetServerByEndpoint(_ context.Context, endpoint string) (*models.Server, error) {
	// Pretend the server already exists and is active so the sync skips
	// credential encryption / registry registration (no registry in the test).
	// The sync anchors the cluster on the primary endpoint, so report that one.
	return &models.Server{ID: s.serverID, Name: "NH-0001", MinioEndpoint: endpoint, IsActive: true}, nil
}

func (s *syncStub) UpsertNode(_ context.Context, p db.CreateNodeParams, isActive bool) (*models.Node, error) {
	s.nodes = append(s.nodes, p)
	id := uuid.New()
	if s.nodeIDByHostname == nil {
		s.nodeIDByHostname = make(map[string]uuid.UUID)
	}
	s.nodeIDByHostname[p.Hostname] = id
	return &models.Node{
		ID: id, ServerID: p.ServerID, Hostname: p.Hostname, Role: p.Role, Address: p.Address,
		MinioEndpoint: p.MinioEndpoint, MinioUseSSL: p.MinioUseSSL, IsActive: isActive,
	}, nil
}

func (s *syncStub) UpsertDrive(_ context.Context, p db.UpsertDriveParams) (*models.Drive, error) {
	s.drives = append(s.drives, p)
	return &models.Drive{ID: uuid.New(), ServerID: p.ServerID, Label: p.Label, MinioBucket: p.MinioBucket, DriveType: p.DriveType, CapacityBytes: p.CapacityBytes}, nil
}

func (s *syncStub) DeactivateMissingNodes(_ context.Context, _ uuid.UUID, _ []uuid.UUID) error {
	s.prunedNodes++
	return nil
}

func (s *syncStub) DeactivateMissingDrives(_ context.Context, _ uuid.UUID, _ []uuid.UUID) error {
	s.prunedDrvs++
	return nil
}

func newSyncEngine(q *syncStub) http.Handler {
	h := newAdminHandler(q, &stubAdminInviteService{})
	h.ConfigureInfraSync(adminInfraConfig())
	r := newEngine()
	r.POST("/admin/system/sync", h.SyncInfrastructure)
	return r
}

func TestSyncInfrastructure_IndexesSwarmAndDrives(t *testing.T) {
	stub := &syncStub{serverID: uuid.New()}
	r := newSyncEngine(stub)

	req := httptest.NewRequest(http.MethodPost, "/admin/system/sync", nil)
	w := doRequest(r, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var summary struct {
		Servers int `json:"servers"`
		Nodes   int `json:"nodes"`
		Drives  int `json:"drives"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode: %v (raw: %s)", err, w.Body.String())
	}

	// One configured MinIO instance (fast) → one server.
	if summary.Servers != 1 {
		t.Errorf("expected 1 server, got %d", summary.Servers)
	}
	// The manager node should be indexed with the manager role.
	if len(stub.nodes) != 1 || stub.nodes[0].Role != "manager" {
		t.Fatalf("expected one manager node, got %+v", stub.nodes)
	}
	if stub.nodes[0].Hostname != "apollo-mgr" {
		t.Errorf("expected hostname apollo-mgr, got %q", stub.nodes[0].Hostname)
	}
	// The fast tier should become a single nvme drive against the configured
	// bucket (not per MinIO bucket), labelled by tier, with the reported capacity.
	if len(stub.drives) != 1 {
		t.Fatalf("expected one drive, got %d", len(stub.drives))
	}
	d := stub.drives[0]
	if d.DriveType != "nvme" {
		t.Errorf("expected nvme drive_type for fast tier, got %q", d.DriveType)
	}
	if d.Label != "fast" {
		t.Errorf("expected tier label fast, got %q", d.Label)
	}
	if d.CapacityBytes != 8<<40 {
		t.Errorf("expected capacity 8TiB, got %d", d.CapacityBytes)
	}
	if d.MinioBucket != "sfs-data" {
		t.Errorf("expected configured bucket sfs-data, got %q", d.MinioBucket)
	}
	// Stale rows are reconciled on every run.
	if stub.prunedNodes != 1 || stub.prunedDrvs != 1 {
		t.Errorf("expected prune calls per server, got nodes=%d drives=%d", stub.prunedNodes, stub.prunedDrvs)
	}
}

func TestSyncInfrastructure_Idempotent(t *testing.T) {
	stub := &syncStub{serverID: uuid.New()}
	r := newSyncEngine(stub)

	for i := 0; i < 2; i++ {
		w := doRequest(r, httptest.NewRequest(http.MethodPost, "/admin/system/sync", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("run %d: expected 200, got %d (%s)", i, w.Code, w.Body.String())
		}
	}
	// Two runs index the same node/drive twice (upserts), never erroring.
	if len(stub.nodes) != 2 || len(stub.drives) != 2 {
		t.Errorf("expected 2 upserts each across 2 runs, got nodes=%d drives=%d", len(stub.nodes), len(stub.drives))
	}
}

// TestSyncInfrastructure_TwoTierSingleServer verifies that a fast + standard
// deployment is reconciled into ONE server (not two), with the standard node
// carrying its own MinIO endpoint and the standard bucket's drive attached to it.
func TestSyncInfrastructure_TwoTierSingleServer(t *testing.T) {
	stub := &syncStub{serverID: uuid.New()}
	h := newAdminHandler(stub, &stubAdminInviteService{})
	h.ConfigureInfraSync(admin.InfraSyncConfig{
		Swarm: fakeSwarm{nodes: []services.SwarmNode{
			{Hostname: "apollo-sfs", Addr: "10.0.0.2", Tier: "fast", IsManager: false, Ready: true},
			{Hostname: "apollo-sfs-1", Addr: "10.0.0.1", Tier: "standard", IsManager: true, Ready: true},
		}},
		Storage: endpointStorage{byEndpoint: map[string]services.StorageInfo{
			"minio:9000":          {Buckets: []string{"fast-bucket"}, TotalBytes: 4 << 40},
			"minio-standard:9000": {Buckets: []string{"std-bucket"}, TotalBytes: 8 << 40},
		}},
		MinIOEndpoint:    "minio:9000",
		MinIOAccessKey:   "key",
		MinIOSecretKey:   "secret",
		MinIOBucketName:  "sfs-data",
		StandardEndpoint: "minio-standard:9000",
	})
	r := newEngine()
	r.POST("/admin/system/sync", h.SyncInfrastructure)

	w := doRequest(r, httptest.NewRequest(http.MethodPost, "/admin/system/sync", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (%s)", w.Code, w.Body.String())
	}
	var summary struct{ Servers, Nodes, Drives int }
	if err := json.Unmarshal(w.Body.Bytes(), &summary); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// The whole point: both tiers live under a single server.
	if summary.Servers != 1 {
		t.Errorf("expected 1 server, got %d", summary.Servers)
	}
	if summary.Nodes != 2 || summary.Drives != 2 {
		t.Fatalf("expected 2 nodes + 2 drives, got nodes=%d drives=%d", summary.Nodes, summary.Drives)
	}

	// Endpoint overrides: standard node carries minio-standard, fast node inherits.
	endpointByHost := map[string]*string{}
	for _, n := range stub.nodes {
		endpointByHost[n.Hostname] = n.MinioEndpoint
	}
	if ep := endpointByHost["apollo-sfs-1"]; ep == nil || *ep != "minio-standard:9000" {
		t.Errorf("standard node should override endpoint to minio-standard:9000, got %v", ep)
	}
	if ep := endpointByHost["apollo-sfs"]; ep != nil {
		t.Errorf("fast node should inherit the server endpoint (nil override), got %v", *ep)
	}

	// One drive per tier (labelled by tier, against the configured bucket): the
	// standard drive attaches to the standard node and is hdd; the fast drive
	// attaches to the fast node and is nvme.
	stdNodeID := stub.nodeIDByHostname["apollo-sfs-1"]
	fastNodeID := stub.nodeIDByHostname["apollo-sfs"]
	for _, d := range stub.drives {
		if d.MinioBucket != "sfs-data" {
			t.Errorf("expected configured bucket sfs-data, got %q", d.MinioBucket)
		}
		switch d.Label {
		case "standard":
			if d.NodeID == nil || *d.NodeID != stdNodeID {
				t.Errorf("standard drive should attach to the standard node")
			}
			if d.DriveType != "hdd" {
				t.Errorf("standard drive should be hdd, got %q", d.DriveType)
			}
		case "fast":
			if d.NodeID == nil || *d.NodeID != fastNodeID {
				t.Errorf("fast drive should attach to the fast node")
			}
			if d.DriveType != "nvme" {
				t.Errorf("fast drive should be nvme, got %q", d.DriveType)
			}
		default:
			t.Errorf("unexpected drive label %q", d.Label)
		}
	}
}
