package tests

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"

	_ "github.com/lib/pq"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/routes/auth"
	"apollo-sfs.com/api/routes/services"
)

// resetPasswordEngine wires just POST /auth/reset_password. Only requests that
// fail binding are exercised here — anything that gets past it would need a real
// database and Keycloak, which this package deliberately does without.
func resetPasswordEngine() http.Handler {
	svc := services.NewAuthService(nil, services.AuthServiceConfig{
		KeycloakURL:   "http://keycloak:8180",
		KeycloakRealm: "test-realm",
		AppBaseURL:    "https://app.example.com",
	})
	h := auth.NewHandler(svc, "example.com", true, "")
	r := newEngine()
	r.POST("/auth/reset_password", h.ResetPassword)
	return r
}

// The request field is new_password, matching what the frontend sends. It was
// previously bound as `password`, so every reset the UI attempted failed binding
// and came back 400 no matter how valid the token was — the whole flow was dead.
func TestResetPasswordRejectsLegacyPasswordField(t *testing.T) {
	w := doRequest(resetPasswordEngine(), httptest.NewRequest(
		http.MethodPost, "/auth/reset_password",
		jsonBody(map[string]string{"token": "tok", "password": "Sup3rSecret!x"}),
	))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a payload missing new_password, got %d", w.Code)
	}
}

func TestResetPasswordRequiresToken(t *testing.T) {
	w := doRequest(resetPasswordEngine(), httptest.NewRequest(
		http.MethodPost, "/auth/reset_password",
		jsonBody(map[string]string{"new_password": "Sup3rSecret!x"}),
	))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 without a token, got %d", w.Code)
	}
}

// Mirrors the realm's length(12) policy so a too-short password is a clear 400
// here rather than an opaque failure from the Keycloak admin API.
func TestResetPasswordRejectsShortPassword(t *testing.T) {
	w := doRequest(resetPasswordEngine(), httptest.NewRequest(
		http.MethodPost, "/auth/reset_password",
		jsonBody(map[string]string{"token": "tok", "new_password": "short"}),
	))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an 11-or-fewer character password, got %d", w.Code)
	}
}

// forgotPasswordEngine wires POST /auth/forgot_password over a database handle
// that never connects. sql.Open is lazy, so queries fail at dial time with an
// error rather than panicking — which is exactly the "no such user" path.
func forgotPasswordEngine(t *testing.T) http.Handler {
	t.Helper()
	sqlDB, err := sql.Open("postgres", "postgres://unused:unused@127.0.0.1:1/unused?sslmode=disable&connect_timeout=1")
	if err != nil {
		t.Fatalf("open stub db: %v", err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	svc := services.NewAuthService(db.New(sqlDB), services.AuthServiceConfig{
		KeycloakURL:   "http://keycloak:8180",
		KeycloakRealm: "test-realm",
		AppBaseURL:    "https://app.example.com",
	})
	h := auth.NewHandler(svc, "example.com", true, "")
	r := newEngine()
	r.POST("/auth/forgot_password", h.ForgotPassword)
	return r
}

// The forgot-password request answers identically whether or not the address is
// registered, so a stranger cannot use it to discover who has an account.
func TestForgotPasswordDoesNotRevealWhetherEmailExists(t *testing.T) {
	w := doRequest(forgotPasswordEngine(t), httptest.NewRequest(
		http.MethodPost, "/auth/forgot_password",
		jsonBody(map[string]string{"email": "nobody@example.com"}),
	))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for an unknown address, got %d", w.Code)
	}

	var body map[string]string
	if err := decodeBody(w, &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["error"] != "" {
		t.Errorf("response leaked an error: %q", body["error"])
	}
}

func TestForgotPasswordRequiresValidEmail(t *testing.T) {
	svc := services.NewAuthService(nil, services.AuthServiceConfig{
		KeycloakURL: "http://keycloak:8180", KeycloakRealm: "test-realm", AppBaseURL: "https://app.example.com",
	})
	h := auth.NewHandler(svc, "example.com", true, "")
	r := newEngine()
	r.POST("/auth/forgot_password", h.ForgotPassword)

	w := doRequest(r, httptest.NewRequest(
		http.MethodPost, "/auth/forgot_password",
		jsonBody(map[string]string{"email": "not-an-email"}),
	))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a malformed address, got %d", w.Code)
	}
}
