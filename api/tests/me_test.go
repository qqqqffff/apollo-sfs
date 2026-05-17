package tests

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"

	"apollo-sfs.com/api/routes"
)

func TestMe_ReturnsUser(t *testing.T) {
	q := &stubQuerier{user: sampleUser()}
	h := newRoutesHandler(q, nil)

	r := newEngine()
	ginContext(r, "user-uuid-123", "alice", false)
	r.GET("/me", h.Me)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	if err := decodeBody(w, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["username"] != "alice" {
		t.Errorf("expected username=alice, got %v", body["username"])
	}
	if body["email"] != "alice@example.com" {
		t.Errorf("expected email=alice@example.com, got %v", body["email"])
	}
}

func TestMe_AdminRoleFromJWT(t *testing.T) {
	u := sampleUser()
	u.IsAdmin = false // DB says false
	q := &stubQuerier{user: u}
	h := newRoutesHandler(q, nil)

	r := newEngine()
	ginContext(r, "user-uuid-123", "alice", true) // JWT says admin
	r.GET("/me", h.Me)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["is_admin"] != true {
		t.Errorf("expected is_admin=true from JWT roles, got %v", body["is_admin"])
	}
}

func TestMe_StoragePercentCalculated(t *testing.T) {
	u := sampleUser()
	u.StorageUsedBytes = 500
	u.StorageQuotaBytes = 1000
	q := &stubQuerier{user: u}
	h := newRoutesHandler(q, nil)

	r := newEngine()
	ginContext(r, "uid", "alice", false)
	r.GET("/me", h.Me)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	w := doRequest(r, req)

	var body map[string]any
	decodeBody(w, &body) //nolint
	pct, _ := body["storage_used_pct"].(float64)
	if pct != 50.0 {
		t.Errorf("expected storage_used_pct=50.0, got %v", pct)
	}
}

func TestMe_ZeroQuotaNoDiv(t *testing.T) {
	u := sampleUser()
	u.StorageUsedBytes = 0
	u.StorageQuotaBytes = 0
	q := &stubQuerier{user: u}
	h := newRoutesHandler(q, nil)

	r := newEngine()
	ginContext(r, "uid", "alice", false)
	r.GET("/me", h.Me)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

func TestMe_UserNotFound(t *testing.T) {
	q := &stubQuerier{userErr: sql.ErrNoRows}
	h := newRoutesHandler(q, nil)

	r := newEngine()
	ginContext(r, "uid", "ghost", false)
	r.GET("/me", h.Me)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestMe_MissingUsernameContext(t *testing.T) {
	h := newRoutesHandler(&stubQuerier{}, nil)

	r := newEngine() // no ginContext middleware — username not set
	r.GET("/me", h.Me)

	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
}

func TestMe_RegistersRoute(t *testing.T) {
	h := routes.NewHandler(&stubQuerier{user: sampleUser()}, nil, nil, nil, nil, nil, nil, nil, "")
	_ = h // ensure the handler is constructible; handler registration tested in other tests
}
