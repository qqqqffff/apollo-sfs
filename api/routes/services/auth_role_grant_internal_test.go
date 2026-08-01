package services

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"apollo-sfs.com/api/models"
)

// fakeKeycloak stands in for the Keycloak admin REST API used by
// grantInvitationRoles: GET /admin/realms/{realm}/roles/{name} and
// POST /admin/realms/{realm}/users/{id}/role-mappings/realm.
type fakeKeycloak struct {
	missingRoles map[string]bool // role name -> respond 404 on lookup
	grantStatus  int             // status code for the role-mappings POST; 0 means 204
	grantedBody  []kcRoleRef     // captures the last grant request body
	grantCalled  bool
}

func newFakeKeycloak(t *testing.T, fk *fakeKeycloak) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/admin/realms/test-realm/roles/", func(w http.ResponseWriter, r *http.Request) {
		roleName := r.URL.Path[len("/admin/realms/test-realm/roles/"):]
		if fk.missingRoles[roleName] {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(kcRoleRef{ID: "id-" + roleName, Name: roleName})
	})
	mux.HandleFunc("/admin/realms/test-realm/users/user-1/role-mappings/realm", func(w http.ResponseWriter, r *http.Request) {
		fk.grantCalled = true
		_ = json.NewDecoder(r.Body).Decode(&fk.grantedBody)
		if fk.grantStatus != 0 {
			w.WriteHeader(fk.grantStatus)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newTestAuthService(t *testing.T, srv *httptest.Server) *AuthService {
	t.Helper()
	return NewAuthService(nil, AuthServiceConfig{
		KeycloakURL:   srv.URL,
		KeycloakRealm: "test-realm",
	})
}

func TestGrantInvitationRoles_NoRolesRequested_NoOp(t *testing.T) {
	fk := &fakeKeycloak{}
	srv := newFakeKeycloak(t, fk)
	s := newTestAuthService(t, srv)

	err := s.grantInvitationRoles(t.Context(), "admin-token", "user-1", "alice", &models.Invitation{})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if fk.grantCalled {
		t.Error("expected no role-mappings call when neither grant flag is set")
	}
}

func TestGrantInvitationRoles_Premium_GrantsPremiumOnly(t *testing.T) {
	fk := &fakeKeycloak{}
	srv := newFakeKeycloak(t, fk)
	s := newTestAuthService(t, srv)

	err := s.grantInvitationRoles(t.Context(), "admin-token", "user-1", "alice", &models.Invitation{GrantPremium: true})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if !fk.grantCalled {
		t.Fatal("expected role-mappings call")
	}
	if len(fk.grantedBody) != 1 || fk.grantedBody[0].Name != "premium" {
		t.Errorf("expected only premium granted, got %+v", fk.grantedBody)
	}
}

func TestGrantInvitationRoles_Admin_GrantsAdminAndPremium(t *testing.T) {
	fk := &fakeKeycloak{}
	srv := newFakeKeycloak(t, fk)
	s := newTestAuthService(t, srv)

	err := s.grantInvitationRoles(t.Context(), "admin-token", "user-1", "alice", &models.Invitation{GrantAdmin: true})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if !fk.grantCalled {
		t.Fatal("expected role-mappings call")
	}
	if len(fk.grantedBody) != 2 {
		t.Fatalf("expected admin+premium granted, got %+v", fk.grantedBody)
	}
	names := map[string]bool{}
	for _, r := range fk.grantedBody {
		names[r.Name] = true
	}
	if !names["admin"] || !names["premium"] {
		t.Errorf("expected admin and premium both granted, got %+v", fk.grantedBody)
	}
}

// TestGrantInvitationRoles_RoleLookupFails_ReturnsError guards against the bug
// where a failed realm-role lookup was silently swallowed (`continue`),
// letting registration succeed with the requested role missing.
func TestGrantInvitationRoles_RoleLookupFails_ReturnsError(t *testing.T) {
	fk := &fakeKeycloak{missingRoles: map[string]bool{"admin": true}}
	srv := newFakeKeycloak(t, fk)
	s := newTestAuthService(t, srv)

	err := s.grantInvitationRoles(t.Context(), "admin-token", "user-1", "alice", &models.Invitation{GrantAdmin: true})
	if err == nil {
		t.Fatal("expected an error when the admin role cannot be looked up")
	}
	if !errors.Is(err, ErrRoleProvisioningFailed) {
		t.Errorf("error %v does not wrap ErrRoleProvisioningFailed — the register/mobile "+
			"handlers match on it to return a retryable failure", err)
	}
	if fk.grantCalled {
		t.Error("role-mappings should not be called when a role lookup failed")
	}
}

// TestGrantInvitationRoles_GrantCallFails_ReturnsError guards against the bug
// where a failed role-mappings POST was silently swallowed
// (`_ = grantErr // non-fatal`), letting registration succeed even though
// Keycloak never actually assigned the role.
func TestGrantInvitationRoles_GrantCallFails_ReturnsError(t *testing.T) {
	fk := &fakeKeycloak{grantStatus: http.StatusForbidden}
	srv := newFakeKeycloak(t, fk)
	s := newTestAuthService(t, srv)

	err := s.grantInvitationRoles(t.Context(), "admin-token", "user-1", "alice", &models.Invitation{GrantAdmin: true})
	if err == nil {
		t.Fatal("expected an error when Keycloak rejects the role grant")
	}
	if !errors.Is(err, ErrRoleProvisioningFailed) {
		t.Errorf("error %v does not wrap ErrRoleProvisioningFailed", err)
	}
}
