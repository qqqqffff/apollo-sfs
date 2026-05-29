package tests

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// ── List submissions ──────────────────────────────────────────────────────────

func TestAdminListInterest_Empty(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/interest", h.ListInterestSubmissions)

	req := httptest.NewRequest(http.MethodGet, "/admin/interest", nil)
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

func TestAdminListInterest_WithSubmissions(t *testing.T) {
	q := &stubAdminQuerier{
		submissions: []models.InterestSubmission{
			{ID: uuid.New(), Name: "Alice", Email: "alice@example.com", DesiredStorageGB: 10, UseCase: "backups", IPAddress: "1.2.3.4", CreatedAt: time.Now()},
			{ID: uuid.New(), Name: "Bob", Email: "bob@example.com", DesiredStorageGB: 50, UseCase: "media", IPAddress: "5.6.7.8", CreatedAt: time.Now()},
		},
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/interest", h.ListInterestSubmissions)

	req := httptest.NewRequest(http.MethodGet, "/admin/interest", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	items, _ := body["items"].([]any)
	if len(items) != 2 {
		t.Errorf("expected 2 submissions, got %d", len(items))
	}
}

// ── Settings ──────────────────────────────────────────────────────────────────

func TestAdminGetInterestSettings(t *testing.T) {
	q := &stubAdminQuerier{
		settings: &models.InterestFormSettings{DailyCap: 42, UpdatedAt: time.Now()},
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/interest/settings", h.GetInterestFormSettings)

	req := httptest.NewRequest(http.MethodGet, "/admin/interest/settings", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["daily_cap"] != float64(42) {
		t.Errorf("expected daily_cap=42, got %v", body["daily_cap"])
	}
}

func TestAdminUpdateInterestSettings_Valid(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.PUT("/admin/interest/settings", h.UpdateInterestFormSettings)

	body := jsonBody(map[string]any{"daily_cap": 200})
	req := httptest.NewRequest(http.MethodPut, "/admin/interest/settings", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var resp map[string]any
	decodeBody(w, &resp) //nolint
	if resp["daily_cap"] != float64(200) {
		t.Errorf("expected daily_cap=200 in response, got %v", resp["daily_cap"])
	}
}

func TestAdminUpdateInterestSettings_InvalidBody(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.PUT("/admin/interest/settings", h.UpdateInterestFormSettings)

	cases := []map[string]any{
		{},                    // missing daily_cap
		{"daily_cap": 0},     // below min (1)
		{"daily_cap": -1},    // negative
	}
	for _, payload := range cases {
		req := httptest.NewRequest(http.MethodPut, "/admin/interest/settings", jsonBody(payload))
		req.Header.Set("Content-Type", "application/json")
		w := doRequest(r, req)
		if w.Code != http.StatusBadRequest {
			t.Errorf("payload %v: expected 400, got %d", payload, w.Code)
		}
	}
}

// ── Provision ─────────────────────────────────────────────────────────────────

func TestAdminProvisionInterest_Happy(t *testing.T) {
	subID := uuid.New()
	q := &stubAdminQuerier{
		singleSub: &models.InterestSubmission{
			ID:               subID,
			Name:             "Alice",
			Email:            "alice@example.com",
			DesiredStorageGB: 10,
			UseCase:          "backups",
			IPAddress:        "1.2.3.4",
			CreatedAt:        time.Now(),
		},
	}
	inv := &stubAdminInviteService{inv: sampleInvitation()}
	h := newAdminHandler(q, inv)

	r := newEngine()
	ginContext(r, uuid.New().String(), "admin", true)
	r.POST("/admin/interest/:id/provision", h.ProvisionInterestSubmission)

	body := jsonBody(map[string]any{"initial_quota_bytes": 10_737_418_240})
	req := httptest.NewRequest(http.MethodPost, "/admin/interest/"+subID.String()+"/provision", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminProvisionInterest_AlreadyProvisioned(t *testing.T) {
	now := time.Now()
	subID := uuid.New()
	q := &stubAdminQuerier{
		singleSub: &models.InterestSubmission{
			ID:            subID,
			Email:         "alice@example.com",
			ProvisionedAt: &now, // already provisioned
		},
	}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, uuid.New().String(), "admin", true)
	r.POST("/admin/interest/:id/provision", h.ProvisionInterestSubmission)

	body := jsonBody(map[string]any{"initial_quota_bytes": 10_000_000_000})
	req := httptest.NewRequest(http.MethodPost, "/admin/interest/"+subID.String()+"/provision", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminProvisionInterest_SubmissionNotFound(t *testing.T) {
	q := &stubAdminQuerier{singleSubErr: sql.ErrNoRows}
	h := newAdminHandler(q, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, uuid.New().String(), "admin", true)
	r.POST("/admin/interest/:id/provision", h.ProvisionInterestSubmission)

	body := jsonBody(map[string]any{"initial_quota_bytes": 10_000_000_000})
	req := httptest.NewRequest(http.MethodPost, "/admin/interest/"+uuid.New().String()+"/provision", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestAdminProvisionInterest_InviteAlreadyPending(t *testing.T) {
	subID := uuid.New()
	q := &stubAdminQuerier{
		singleSub: &models.InterestSubmission{
			ID:    subID,
			Email: "dup@example.com",
		},
	}
	inv := &stubAdminInviteService{invErr: services.ErrInviteAlreadyPending}
	h := newAdminHandler(q, inv)

	r := newEngine()
	ginContext(r, uuid.New().String(), "admin", true)
	r.POST("/admin/interest/:id/provision", h.ProvisionInterestSubmission)

	body := jsonBody(map[string]any{"initial_quota_bytes": 10_000_000_000})
	req := httptest.NewRequest(http.MethodPost, "/admin/interest/"+subID.String()+"/provision", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminProvisionInterest_InvalidUUID(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.POST("/admin/interest/:id/provision", h.ProvisionInterestSubmission)

	req := httptest.NewRequest(http.MethodPost, "/admin/interest/not-a-uuid/provision", jsonBody(map[string]any{}))
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}
