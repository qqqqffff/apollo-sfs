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
		Storage:        fakeStorage{info: services.StorageInfo{Buckets: []string{"sfs-data"}, TotalBytes: 8 << 40}},
		MinIOEndpoint:  "minio:9000",
		MinIOAccessKey: "key",
		MinIOSecretKey: "secret",
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

// syncStub records the upserts the sync performs so the test can assert on them.
type syncStub struct {
	stubAdminQuerier
	serverID    uuid.UUID
	nodes       []db.CreateNodeParams
	drives      []db.UpsertDriveParams
	prunedNodes int
	prunedDrvs  int
}

func (s *syncStub) GetServerByEndpoint(_ context.Context, endpoint string) (*models.Server, error) {
	// Pretend the server already exists and is active so the sync skips
	// credential encryption / registry registration (no registry in the test).
	return &models.Server{ID: s.serverID, Name: "Fast-tier", MinioEndpoint: endpoint, IsActive: true}, nil
}

func (s *syncStub) UpsertNode(_ context.Context, p db.CreateNodeParams, isActive bool) (*models.Node, error) {
	s.nodes = append(s.nodes, p)
	return &models.Node{ID: uuid.New(), ServerID: p.ServerID, Hostname: p.Hostname, Role: p.Role, Address: p.Address, IsActive: isActive}, nil
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
	// The fast-tier bucket should become an nvme drive with the reported capacity.
	if len(stub.drives) != 1 {
		t.Fatalf("expected one drive, got %d", len(stub.drives))
	}
	d := stub.drives[0]
	if d.DriveType != "nvme" {
		t.Errorf("expected nvme drive_type for fast tier, got %q", d.DriveType)
	}
	if d.CapacityBytes != 8<<40 {
		t.Errorf("expected capacity 8TiB, got %d", d.CapacityBytes)
	}
	if d.MinioBucket != "sfs-data" {
		t.Errorf("expected bucket sfs-data, got %q", d.MinioBucket)
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
