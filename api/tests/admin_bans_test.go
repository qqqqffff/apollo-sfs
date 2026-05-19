package tests

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// ── helpers ───────────────────────────────────────────────────────────────────

func bansRouter(q *stubAdminQuerier, fileSvc *stubFileService) *gin.Engine {
	h := newAdminHandlerWithFiles(q, fileSvc)
	r := newEngine()
	ginContext(r, "00000000-0000-0000-0000-000000000001", "adminuser", true)
	r.POST("/users/:user_id/ban", h.BanUser)
	r.POST("/users/:user_id/suspend", h.SuspendUser)
	r.POST("/users/:user_id/pardon", h.PardonUser)
	r.GET("/bans", h.ListUserBans)
	return r
}

// ── BanUser ───────────────────────────────────────────────────────────────────

func TestBanUser_Success(t *testing.T) {
	q := &stubAdminQuerier{user: sampleUser()}
	fs := &stubFileService{}
	r := bansRouter(q, fs)

	req := httptest.NewRequest(http.MethodPost, "/users/alice/ban", jsonBody(map[string]any{
		"violation_code": "spam",
		"comments":       "sent unsolicited bulk messages",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body map[string]string
	decodeBody(w, &body) //nolint
	if body["message"] != "user banned" {
		t.Errorf("expected message 'user banned', got %q", body["message"])
	}
}

func TestBanUser_NotFound(t *testing.T) {
	q := &stubAdminQuerier{userErr: sql.ErrNoRows}
	r := bansRouter(q, &stubFileService{})

	req := httptest.NewRequest(http.MethodPost, "/users/ghost/ban", jsonBody(map[string]any{
		"violation_code": "spam",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestBanUser_InvalidViolationCode(t *testing.T) {
	q := &stubAdminQuerier{user: sampleUser()}
	r := bansRouter(q, &stubFileService{})

	req := httptest.NewRequest(http.MethodPost, "/users/alice/ban", jsonBody(map[string]any{
		"violation_code": "made_up_code",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "unknown violation_code") {
		t.Errorf("expected body to contain 'unknown violation_code', got: %s", w.Body.String())
	}
}

func TestBanUser_MissingBody(t *testing.T) {
	q := &stubAdminQuerier{user: sampleUser()}
	r := bansRouter(q, &stubFileService{})

	req := httptest.NewRequest(http.MethodPost, "/users/alice/ban", nil)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestBanUser_UserIDTooLong(t *testing.T) {
	r := bansRouter(&stubAdminQuerier{}, &stubFileService{})

	longID := strings.Repeat("a", 151)
	req := httptest.NewRequest(http.MethodPost, "/users/"+longID+"/ban", jsonBody(map[string]any{
		"violation_code": "spam",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for oversized user_id, got %d", w.Code)
	}
}

// ── SuspendUser ───────────────────────────────────────────────────────────────

func TestSuspendUser_Success(t *testing.T) {
	q := &stubAdminQuerier{user: sampleUser()}
	r := bansRouter(q, &stubFileService{})

	req := httptest.NewRequest(http.MethodPost, "/users/alice/suspend", jsonBody(map[string]any{
		"violation_code": "spam",
		"comments":       "temp suspension",
		"hours":          24,
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body map[string]string
	decodeBody(w, &body) //nolint
	if body["message"] != "user suspended" {
		t.Errorf("expected 'user suspended', got %q", body["message"])
	}
}

func TestSuspendUser_InvalidHours_Zero(t *testing.T) {
	q := &stubAdminQuerier{user: sampleUser()}
	r := bansRouter(q, &stubFileService{})

	req := httptest.NewRequest(http.MethodPost, "/users/alice/suspend", jsonBody(map[string]any{
		"violation_code": "spam",
		"hours":          0,
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSuspendUser_InvalidHours_Negative(t *testing.T) {
	q := &stubAdminQuerier{user: sampleUser()}
	r := bansRouter(q, &stubFileService{})

	req := httptest.NewRequest(http.MethodPost, "/users/alice/suspend", jsonBody(map[string]any{
		"violation_code": "spam",
		"hours":          -5,
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSuspendUser_MissingViolationCode(t *testing.T) {
	q := &stubAdminQuerier{user: sampleUser()}
	r := bansRouter(q, &stubFileService{})

	req := httptest.NewRequest(http.MethodPost, "/users/alice/suspend", jsonBody(map[string]any{
		"hours": 12,
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestSuspendUser_NotFound(t *testing.T) {
	q := &stubAdminQuerier{userErr: sql.ErrNoRows}
	r := bansRouter(q, &stubFileService{})

	req := httptest.NewRequest(http.MethodPost, "/users/ghost/suspend", jsonBody(map[string]any{
		"violation_code": "spam",
		"hours":          8,
	}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

// ── PardonUser ────────────────────────────────────────────────────────────────

func TestPardonUser_Success(t *testing.T) {
	r := bansRouter(&stubAdminQuerier{}, &stubFileService{})

	req := httptest.NewRequest(http.MethodPost, "/users/alice/pardon", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body map[string]string
	decodeBody(w, &body) //nolint
	if body["message"] != "user pardoned" {
		t.Errorf("expected 'user pardoned', got %q", body["message"])
	}
}

func TestPardonUser_UserIDTooLong(t *testing.T) {
	r := bansRouter(&stubAdminQuerier{}, &stubFileService{})

	longID := strings.Repeat("x", 151)
	req := httptest.NewRequest(http.MethodPost, "/users/"+longID+"/pardon", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

// ── ListUserBans ──────────────────────────────────────────────────────────────

func TestListUserBans_Empty(t *testing.T) {
	r := bansRouter(&stubAdminQuerier{}, &stubFileService{})

	req := httptest.NewRequest(http.MethodGet, "/bans", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body map[string]any
	decodeBody(w, &body) //nolint
	items, _ := body["items"].([]any)
	if len(items) != 0 {
		t.Errorf("expected 0 items, got %d", len(items))
	}
}

func TestListUserBans_ReturnsBans(t *testing.T) {
	// Wire a custom querier that returns one ban
	ban := models.UserBan{ID: 1, Username: "alice", BanType: "banned", ViolationCode: "spam", BannedBy: "adminuser"}
	cq := &customListBansQuerier{stubAdminQuerier: &stubAdminQuerier{}, bans: []models.UserBan{ban}}
	h := newAdminHandlerWithFiles(cq, &stubFileService{})
	r2 := newEngine()
	ginContext(r2, "00000000-0000-0000-0000-000000000001", "adminuser", true)
	r2.GET("/bans", h.ListUserBans)

	req := httptest.NewRequest(http.MethodGet, "/bans", nil)
	w := doRequest(r2, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
	var body map[string]any
	decodeBody(w, &body) //nolint
	items, _ := body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(items))
	}
	item, _ := items[0].(map[string]any)
	if item["username"] != "alice" {
		t.Errorf("expected username 'alice', got %v", item["username"])
	}
}

func TestListUserBans_InvalidLimit(t *testing.T) {
	r := bansRouter(&stubAdminQuerier{}, &stubFileService{})

	req := httptest.NewRequest(http.MethodGet, "/bans?limit=bad", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

// customListBansQuerier embeds stubAdminQuerier and overrides ListUserBans.
type customListBansQuerier struct {
	*stubAdminQuerier
	bans []models.UserBan
}

func (q *customListBansQuerier) ListUserBans(_ context.Context, _ bool, _ db.PageInput) (*db.PageResult[models.UserBan], error) {
	return &db.PageResult[models.UserBan]{Items: q.bans}, nil
}
