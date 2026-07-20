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

func TestAdminSearchUsers_ReturnsUsersWithTotal(t *testing.T) {
	q := &stubAdminQuerier{
		users: []models.User{
			{Username: "alice", Email: "alice@example.com", CreatedAt: time.Now()},
			{Username: "bob", Email: "bob@example.com", CreatedAt: time.Now()},
		},
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/users/search", h.SearchUsers)

	req := httptest.NewRequest(http.MethodGet, "/admin/users/search?search=al&role=user&sort=username&dir=asc&page=1&page_size=25", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	items, _ := body["items"].([]any)
	if len(items) != 2 {
		t.Errorf("expected 2 users, got %d", len(items))
	}
	if total, _ := body["total"].(float64); total != 2 {
		t.Errorf("expected total=2, got %v", body["total"])
	}
	if page, _ := body["page"].(float64); page != 1 {
		t.Errorf("expected page=1, got %v", body["page"])
	}
	if pageSize, _ := body["page_size"].(float64); pageSize != 25 {
		t.Errorf("expected page_size=25, got %v", body["page_size"])
	}
}

func TestAdminSearchUsers_InvalidPage(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/users/search", h.SearchUsers)

	req := httptest.NewRequest(http.MethodGet, "/admin/users/search?page=notanumber", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminSearchUsers_InvalidPageSize(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/users/search", h.SearchUsers)

	req := httptest.NewRequest(http.MethodGet, "/admin/users/search?page_size=notanumber", nil)
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

func TestAdminUpdateUserFeedbackAccess_Enable(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.PATCH("/admin/users/:user_id/feedback-access", h.UpdateUserFeedbackAccess)

	req := httptest.NewRequest(http.MethodPatch, "/admin/users/alice/feedback-access", jsonBody(map[string]any{"enabled": true}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["feedback_access_enabled"] != true {
		t.Errorf("expected feedback_access_enabled=true, got %v", body["feedback_access_enabled"])
	}
}

func TestAdminUpdateUserFeedbackAccess_Disable(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.PATCH("/admin/users/:user_id/feedback-access", h.UpdateUserFeedbackAccess)

	req := httptest.NewRequest(http.MethodPatch, "/admin/users/alice/feedback-access", jsonBody(map[string]any{"enabled": false}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["feedback_access_enabled"] != false {
		t.Errorf("expected feedback_access_enabled=false, got %v", body["feedback_access_enabled"])
	}
}

func TestAdminUpdateUserFeedbackAccess_MissingBody(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.PATCH("/admin/users/:user_id/feedback-access", h.UpdateUserFeedbackAccess)

	req := httptest.NewRequest(http.MethodPatch, "/admin/users/alice/feedback-access", jsonBody(map[string]any{}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminUpdateUserFeedbackAccess_IDTooLong(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.PATCH("/admin/users/:user_id/feedback-access", h.UpdateUserFeedbackAccess)

	longID := strings.Repeat("a", 151)
	req := httptest.NewRequest(http.MethodPatch, "/admin/users/"+longID+"/feedback-access", jsonBody(map[string]any{"enabled": true}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminUpdateUserFeedbackAccess_QueryError(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{setFeedbackAccessErr: errBoom}, &stubAdminInviteService{})

	r := newEngine()
	r.PATCH("/admin/users/:user_id/feedback-access", h.UpdateUserFeedbackAccess)

	req := httptest.NewRequest(http.MethodPatch, "/admin/users/alice/feedback-access", jsonBody(map[string]any{"enabled": true}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", w.Code)
	}
}
