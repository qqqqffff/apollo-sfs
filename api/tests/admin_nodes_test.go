package tests

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// nodeStub augments stubAdminQuerier with a server + node so the node CRUD
// handlers get past their existence checks and exercise the success paths.
type nodeStub struct {
	stubAdminQuerier
	serverID uuid.UUID
	created  *db.CreateNodeParams
}

func (s *nodeStub) GetServer(_ context.Context, id uuid.UUID) (*models.Server, error) {
	return &models.Server{ID: id, Name: "NH-0001", State: "NH", IsActive: true}, nil
}

func (s *nodeStub) CreateNode(_ context.Context, p db.CreateNodeParams) (*models.Node, error) {
	s.created = &p
	return &models.Node{
		ID: uuid.New(), ServerID: p.ServerID, Hostname: p.Hostname,
		Role: p.Role, Address: p.Address, IsActive: true, CreatedAt: time.Now(),
	}, nil
}

func (s *nodeStub) GetNode(_ context.Context, id uuid.UUID) (*models.Node, error) {
	return &models.Node{ID: id, ServerID: s.serverID, Hostname: "n1", Role: "worker", IsActive: true}, nil
}

func newInfraEngine(q *nodeStub) http.Handler {
	h := newAdminHandler(q, &stubAdminInviteService{})
	r := newEngine()
	r.GET("/admin/system/infrastructure", h.GetInfrastructure)
	r.GET("/admin/system/drive-stats", h.GetDriveStats)
	r.POST("/admin/system/servers/:server_id/nodes", h.CreateNode)
	r.PATCH("/admin/system/servers/:server_id/nodes/:node_id", h.UpdateNode)
	r.DELETE("/admin/system/servers/:server_id/nodes/:node_id", h.DeleteNode)
	return r
}

// ── Infrastructure shape ────────────────────────────────────────────────────────

func TestGetInfrastructure_IncludesNodesAndDrives(t *testing.T) {
	r := newInfraEngine(&nodeStub{})
	req := httptest.NewRequest(http.MethodGet, "/admin/system/infrastructure", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body struct {
		Nodes  []json.RawMessage `json:"nodes"`
		Drives []json.RawMessage `json:"drives"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (raw: %s)", err, w.Body.String())
	}
	if body.Nodes == nil || body.Drives == nil {
		t.Fatalf("expected both nodes and drives arrays, got: %s", w.Body.String())
	}
}

// ── Drive stats ─────────────────────────────────────────────────────────────────

func TestGetDriveStats_Returns200WithStatsObject(t *testing.T) {
	r := newInfraEngine(&nodeStub{})
	req := httptest.NewRequest(http.MethodGet, "/admin/system/drive-stats", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body struct {
		Stats map[string]json.RawMessage `json:"stats"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (raw: %s)", err, w.Body.String())
	}
	if body.Stats == nil {
		t.Fatalf("expected a stats object, got: %s", w.Body.String())
	}
}

// ── Create node ─────────────────────────────────────────────────────────────────

func TestCreateNode_DefaultsRoleToWorker(t *testing.T) {
	q := &nodeStub{}
	r := newInfraEngine(q)
	sid := uuid.New()
	req := httptest.NewRequest(http.MethodPost, "/admin/system/servers/"+sid.String()+"/nodes",
		jsonBody(map[string]any{"hostname": "apollo-sfs-2"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d (body: %s)", w.Code, w.Body.String())
	}
	if q.created == nil || q.created.Role != "worker" {
		t.Fatalf("expected role defaulted to worker, got %+v", q.created)
	}
}

func TestCreateNode_RejectsInvalidRole(t *testing.T) {
	r := newInfraEngine(&nodeStub{})
	sid := uuid.New()
	req := httptest.NewRequest(http.MethodPost, "/admin/system/servers/"+sid.String()+"/nodes",
		jsonBody(map[string]any{"hostname": "n2", "role": "overlord"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid role, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestCreateNode_RequiresHostname(t *testing.T) {
	r := newInfraEngine(&nodeStub{})
	sid := uuid.New()
	req := httptest.NewRequest(http.MethodPost, "/admin/system/servers/"+sid.String()+"/nodes",
		jsonBody(map[string]any{"role": "worker"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing hostname, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestCreateNode_RejectsBadServerID(t *testing.T) {
	r := newInfraEngine(&nodeStub{})
	req := httptest.NewRequest(http.MethodPost, "/admin/system/servers/not-a-uuid/nodes",
		jsonBody(map[string]any{"hostname": "n2"}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad server_id, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// ── Delete node ─────────────────────────────────────────────────────────────────

func TestDeleteNode_RejectsBadNodeID(t *testing.T) {
	sid := uuid.New()
	r := newInfraEngine(&nodeStub{})
	req := httptest.NewRequest(http.MethodDelete, "/admin/system/servers/"+sid.String()+"/nodes/not-a-uuid", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for bad node_id, got %d (body: %s)", w.Code, w.Body.String())
	}
}
