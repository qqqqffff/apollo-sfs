package tests

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"apollo-sfs.com/api/routes/services"
)

func TestValidateInvitationToken_Valid(t *testing.T) {
	inv := &services.InviteValidation{
		Email:     "bob@example.com",
		ExpiresAt: time.Now().Add(48 * time.Hour),
	}
	h := newRoutesHandler(&stubQuerier{}, &stubInviteValidator{result: inv})

	r := newEngine()
	r.GET("/invitations/:token", h.ValidateInvitationToken)

	req := httptest.NewRequest(http.MethodGet, "/invitations/validtoken123", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d (body: %s)", w.Code, w.Body.String())
	}

	var body map[string]any
	decodeBody(w, &body) //nolint
	if body["email"] != "bob@example.com" {
		t.Errorf("expected email in response, got %v", body["email"])
	}
}

func TestValidateInvitationToken_NotFound(t *testing.T) {
	h := newRoutesHandler(&stubQuerier{}, &stubInviteValidator{err: services.ErrInviteNotFound})

	r := newEngine()
	r.GET("/invitations/:token", h.ValidateInvitationToken)

	req := httptest.NewRequest(http.MethodGet, "/invitations/badtoken", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestValidateInvitationToken_Expired(t *testing.T) {
	h := newRoutesHandler(&stubQuerier{}, &stubInviteValidator{err: services.ErrInviteExpired})

	r := newEngine()
	r.GET("/invitations/:token", h.ValidateInvitationToken)

	req := httptest.NewRequest(http.MethodGet, "/invitations/expiredtoken", nil)
	w := doRequest(r, req)

	if w.Code != http.StatusGone {
		t.Fatalf("expected 410, got %d", w.Code)
	}
}
