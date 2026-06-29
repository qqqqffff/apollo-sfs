package tests

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const testAdminUsername = "admin"

func adminUser() *models.User {
	return &models.User{Username: "admin", Email: "admin@example.com"}
}

// ── GET alarm subscriptions ───────────────────────────────────────────────────

func TestAdminGetAlarmSubscriptions_Empty(t *testing.T) {
	q := &stubAdminQuerier{user: adminUser()}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.GET("/admin/system/alarm/subscriptions", h.GetAlarmSubscriptions)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/alarm/subscriptions", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body []models.AlarmSubscription
	decodeBody(w, &body) //nolint
	if len(body) != 0 {
		t.Errorf("expected empty subscriptions, got %d", len(body))
	}
}

func TestAdminGetAlarmSubscriptions_WithRows(t *testing.T) {
	nodeID := uuid.New()
	q := &stubAdminQuerier{
		user: adminUser(),
		alarmSubs: []models.AlarmSubscription{
			{ID: uuid.New(), Email: "admin@example.com", AlarmType: models.AlarmCPUUsage, NodeID: &nodeID, Threshold: 90},
		},
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.GET("/admin/system/alarm/subscriptions", h.GetAlarmSubscriptions)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/alarm/subscriptions", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body []models.AlarmSubscription
	decodeBody(w, &body) //nolint
	if len(body) != 1 || body[0].AlarmType != models.AlarmCPUUsage {
		t.Errorf("unexpected subscriptions: %+v", body)
	}
}

func TestAdminGetAlarmSubscriptions_UserLookupError(t *testing.T) {
	q := &stubAdminQuerier{userErr: errors.New("not found")}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.GET("/admin/system/alarm/subscriptions", h.GetAlarmSubscriptions)

	req := httptest.NewRequest(http.MethodGet, "/admin/system/alarm/subscriptions", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

// ── PUT alarm subscription ────────────────────────────────────────────────────

func TestAdminUpsertAlarmSubscription_NodeScope(t *testing.T) {
	q := &stubAdminQuerier{user: adminUser()}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.PUT("/admin/system/alarm/subscriptions", h.UpsertAlarmSubscription)

	payload := map[string]any{"alarm_type": "cpu_usage", "node_id": uuid.New().String(), "threshold": 85}
	req := httptest.NewRequest(http.MethodPut, "/admin/system/alarm/subscriptions", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminUpsertAlarmSubscription_ClusterScope(t *testing.T) {
	q := &stubAdminQuerier{user: adminUser()}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.PUT("/admin/system/alarm/subscriptions", h.UpsertAlarmSubscription)

	payload := map[string]any{"alarm_type": "api_error_rate", "threshold": 5}
	req := httptest.NewRequest(http.MethodPut, "/admin/system/alarm/subscriptions", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

// A node-scoped alarm without a node_id is an invalid target and must be rejected.
func TestAdminUpsertAlarmSubscription_MissingNodeTarget(t *testing.T) {
	q := &stubAdminQuerier{user: adminUser()}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.PUT("/admin/system/alarm/subscriptions", h.UpsertAlarmSubscription)

	payload := map[string]any{"alarm_type": "cpu_usage", "threshold": 85}
	req := httptest.NewRequest(http.MethodPut, "/admin/system/alarm/subscriptions", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminUpsertAlarmSubscription_BadThreshold(t *testing.T) {
	q := &stubAdminQuerier{user: adminUser()}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.PUT("/admin/system/alarm/subscriptions", h.UpsertAlarmSubscription)

	payload := map[string]any{"alarm_type": "api_error_rate", "threshold": 0}
	req := httptest.NewRequest(http.MethodPut, "/admin/system/alarm/subscriptions", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminUpsertAlarmSubscription_DBError(t *testing.T) {
	q := &stubAdminQuerier{user: adminUser(), subscriptionErr: errors.New("db down")}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.PUT("/admin/system/alarm/subscriptions", h.UpsertAlarmSubscription)

	payload := map[string]any{"alarm_type": "api_error_rate", "threshold": 5}
	req := httptest.NewRequest(http.MethodPut, "/admin/system/alarm/subscriptions", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}

// ── DELETE alarm subscription ─────────────────────────────────────────────────

func TestAdminDeleteAlarmSubscription(t *testing.T) {
	q := &stubAdminQuerier{user: adminUser()}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.DELETE("/admin/system/alarm/subscriptions", h.DeleteAlarmSubscription)

	payload := map[string]any{"alarm_type": "cpu_usage", "node_id": uuid.New().String()}
	req := httptest.NewRequest(http.MethodDelete, "/admin/system/alarm/subscriptions", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminDeleteAlarmSubscription_UnknownType(t *testing.T) {
	q := &stubAdminQuerier{user: adminUser()}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, "uid-admin", testAdminUsername, true)
	r.DELETE("/admin/system/alarm/subscriptions", h.DeleteAlarmSubscription)

	payload := map[string]any{"alarm_type": "bogus"}
	req := httptest.NewRequest(http.MethodDelete, "/admin/system/alarm/subscriptions", jsonBody(payload))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}
