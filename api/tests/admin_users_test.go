package tests

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"apollo-sfs.com/api/models"
)

func TestAdminGetUsers_EmptyList(t *testing.T) {
	q := &stubAdminQuerier{}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/users", h.GetUsers)

	req := httptest.NewRequest(http.MethodGet, "/admin/users", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	items, _ := body["items"].([]any)
	if len(items) != 0 {
		t.Errorf("expected empty items, got %d", len(items))
	}
}

func TestAdminGetUsers_ReturnsUsers(t *testing.T) {
	q := &stubAdminQuerier{
		users: []models.User{
			{Username: "alice", Email: "alice@example.com", CreatedAt: time.Now()},
			{Username: "bob", Email: "bob@example.com", CreatedAt: time.Now()},
		},
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/users", h.GetUsers)

	req := httptest.NewRequest(http.MethodGet, "/admin/users", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	items, _ := body["items"].([]any)
	if len(items) != 2 {
		t.Errorf("expected 2 users, got %d", len(items))
	}
}

func TestAdminGetUsers_InvalidLimit(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/users", h.GetUsers)

	req := httptest.NewRequest(http.MethodGet, "/admin/users?limit=notanumber", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminGetUser_Found(t *testing.T) {
	q := &stubAdminQuerier{user: sampleUser()}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/users/:user_id", h.GetUser)

	req := httptest.NewRequest(http.MethodGet, "/admin/users/alice", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["username"] != "alice" {
		t.Errorf("expected username=alice, got %v", body["username"])
	}
}

func TestAdminGetUser_NotFound(t *testing.T) {
	q := &stubAdminQuerier{userErr: sql.ErrNoRows}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/users/:user_id", h.GetUser)

	req := httptest.NewRequest(http.MethodGet, "/admin/users/ghost", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestAdminGetUser_IDTooLong(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/users/:user_id", h.GetUser)

	longID := strings.Repeat("a", 151)
	req := httptest.NewRequest(http.MethodGet, "/admin/users/"+longID, nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for oversized user_id, got %d", w.Code)
	}
}

func TestAdminUpdateUserQuota_NoDrive_OK(t *testing.T) {
	q := &stubAdminQuerier{
		userDrive: nil, // no drive allocation — capacity check is skipped
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	r.PATCH("/admin/users/:user_id/quota", h.UpdateUserQuota)

	body := jsonBody(map[string]any{"quota_bytes": 5_000_000_000})
	req := httptest.NewRequest(http.MethodPatch, "/admin/users/alice/quota", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminUpdateUserQuota_MissingBody(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.PATCH("/admin/users/:user_id/quota", h.UpdateUserQuota)

	req := httptest.NewRequest(http.MethodPatch, "/admin/users/alice/quota", jsonBody(map[string]any{}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}
