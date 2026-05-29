package tests

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

func TestAdminGetInvitations_Empty(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.GET("/admin/invitations", h.GetInvitations)

	req := httptest.NewRequest(http.MethodGet, "/admin/invitations", nil)
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

func TestAdminGetInvitations_PopulateURL(t *testing.T) {
	pending := sampleInvitation()
	inv := &stubAdminInviteService{invs: []models.Invitation{*pending}}
	h := newAdminHandler(&stubAdminQuerier{}, inv)

	r := newEngine()
	r.GET("/admin/invitations", h.GetInvitations)

	req := httptest.NewRequest(http.MethodGet, "/admin/invitations", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	items, _ := body["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("expected 1 invitation, got %d", len(items))
	}

	// Pending invitations should include an invitation_url
	item, _ := items[0].(map[string]any)
	if item["invitation_url"] == nil {
		t.Errorf("expected invitation_url for pending invite, got nil")
	}
}

func TestAdminGetInvitations_AcceptedNoURL(t *testing.T) {
	accepted := sampleInvitation()
	now := time.Now()
	accepted.AcceptedAt = &now
	inv := &stubAdminInviteService{invs: []models.Invitation{*accepted}}
	h := newAdminHandler(&stubAdminQuerier{}, inv)

	r := newEngine()
	r.GET("/admin/invitations", h.GetInvitations)

	req := httptest.NewRequest(http.MethodGet, "/admin/invitations", nil)
	w := doRequest(r, req)

	var body map[string]any
	decodeBody(w, &body) //nolint
	items, _ := body["items"].([]any)
	item, _ := items[0].(map[string]any)
	if _, ok := item["invitation_url"]; ok {
		t.Errorf("accepted invitation should not have invitation_url")
	}
}

func TestAdminCreateInvitation_Valid(t *testing.T) {
	inv := &stubAdminInviteService{inv: sampleInvitation()}
	h := newAdminHandler(&stubAdminQuerier{}, inv)

	r := newEngine()
	ginContext(r, uuid.New().String(), "admin", true)
	r.POST("/admin/invitations", h.CreateInvitation)

	body := jsonBody(map[string]any{
		"email":               "newuser@example.com",
		"initial_quota_bytes": 10_737_418_240,
	})
	req := httptest.NewRequest(http.MethodPost, "/admin/invitations", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminCreateInvitation_InvalidEmail(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, uuid.New().String(), "admin", true)
	r.POST("/admin/invitations", h.CreateInvitation)

	body := jsonBody(map[string]any{"email": "not-an-email"})
	req := httptest.NewRequest(http.MethodPost, "/admin/invitations", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAdminCreateInvitation_AlreadyPending(t *testing.T) {
	inv := &stubAdminInviteService{invErr: services.ErrInviteAlreadyPending}
	h := newAdminHandler(&stubAdminQuerier{}, inv)

	r := newEngine()
	ginContext(r, uuid.New().String(), "admin", true)
	r.POST("/admin/invitations", h.CreateInvitation)

	body := jsonBody(map[string]any{
		"email":               "existing@example.com",
		"initial_quota_bytes": 5_000_000_000,
	})
	req := httptest.NewRequest(http.MethodPost, "/admin/invitations", body)
	req.Header.Set("Content-Type", "application/json")
	w := doRequest(r, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d", w.Code)
	}
}

func TestAdminResendInvitation_Valid(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	ginContext(r, uuid.New().String(), "admin", true)
	r.POST("/admin/invitations/:id/resend", h.ResendInvitation)

	id := uuid.New()
	req := httptest.NewRequest(http.MethodPost, "/admin/invitations/"+id.String()+"/resend", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminResendInvitation_NotFound(t *testing.T) {
	inv := &stubAdminInviteService{resendErr: services.ErrInviteNotFound}
	h := newAdminHandler(&stubAdminQuerier{}, inv)

	r := newEngine()
	ginContext(r, uuid.New().String(), "admin", true)
	r.POST("/admin/invitations/:id/resend", h.ResendInvitation)

	req := httptest.NewRequest(http.MethodPost, "/admin/invitations/"+uuid.New().String()+"/resend", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestAdminResendInvitation_Expired(t *testing.T) {
	inv := &stubAdminInviteService{resendErr: services.ErrInviteExpired}
	h := newAdminHandler(&stubAdminQuerier{}, inv)

	r := newEngine()
	ginContext(r, uuid.New().String(), "admin", true)
	r.POST("/admin/invitations/:id/resend", h.ResendInvitation)

	req := httptest.NewRequest(http.MethodPost, "/admin/invitations/"+uuid.New().String()+"/resend", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusGone {
		t.Fatalf("expected 410, got %d", w.Code)
	}
}

func TestAdminRevokeInvitation_Valid(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.DELETE("/admin/invitations/:id", h.RevokeInvitation)

	req := httptest.NewRequest(http.MethodDelete, "/admin/invitations/"+uuid.New().String(), nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}
}

func TestAdminRevokeInvitation_InvalidUUID(t *testing.T) {
	h := newAdminHandler(&stubAdminQuerier{}, &stubAdminInviteService{})

	r := newEngine()
	r.DELETE("/admin/invitations/:id", h.RevokeInvitation)

	req := httptest.NewRequest(http.MethodDelete, "/admin/invitations/not-a-uuid", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}
