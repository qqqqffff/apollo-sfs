package tests

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"apollo-sfs.com/api/routes/auth"
	"apollo-sfs.com/api/routes/services"
)

// socialStartEngine builds just the /auth/social/start route. Nothing here
// touches the database or Keycloak — the handler only assembles a redirect.
func socialStartEngine() http.Handler {
	svc := services.NewAuthService(nil, services.AuthServiceConfig{
		KeycloakURL:       "http://keycloak:8180",
		KeycloakPublicURL: "https://auth.example.com",
		KeycloakRealm:     "test-realm",
		KeycloakClientID:  "test-client",
		AppBaseURL:        "https://app.example.com",
	})
	h := auth.NewHandler(svc, "example.com", true, "")
	r := newEngine()
	r.GET("/auth/social/start", h.SocialStart)
	return r
}

func startRedirect(t *testing.T, target string) *url.URL {
	t.Helper()
	w := doRequest(socialStartEngine(), httptest.NewRequest(http.MethodGet, target, nil))
	if w.Code != http.StatusFound {
		t.Fatalf("expected 302, got %d", w.Code)
	}
	loc, err := url.Parse(w.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse Location: %v", err)
	}
	return loc
}

// A brokered sign-in must go to Keycloak's *public* origin (the user's browser
// follows it, unlike our server-to-server calls) and carry kc_idp_hint — that is
// what makes Keycloak forward straight to the provider instead of rendering its
// own login page.
func TestSocialStartRedirectsToProviderViaKeycloak(t *testing.T) {
	loc := startRedirect(t, "/auth/social/start?provider=google")

	if loc.Host != "auth.example.com" {
		t.Errorf("expected Keycloak public host, got %q", loc.Host)
	}
	if loc.Path != "/realms/test-realm/protocol/openid-connect/auth" {
		t.Errorf("unexpected authorization path %q", loc.Path)
	}
	q := loc.Query()
	if got := q.Get("kc_idp_hint"); got != "google" {
		t.Errorf("kc_idp_hint = %q, want google — without it Keycloak renders its own login page", got)
	}
	if got := q.Get("redirect_uri"); got != "https://app.example.com/api/v1/auth/social/callback" {
		t.Errorf("redirect_uri = %q", got)
	}
	if got := q.Get("prompt"); got != "login" {
		t.Errorf("prompt = %q, want login", got)
	}
	if got := q.Get("state"); got != "google" {
		t.Errorf("state = %q, want the provider so the callback knows who returned", got)
	}
}

// mode=link is the profile page's "Connect" flow: Keycloak must return to the
// SPA, not to the API callback, because the SameSite=Strict session cookie is
// not sent on the cross-site redirect back.
func TestSocialStartLinkModeReturnsToProfilePage(t *testing.T) {
	loc := startRedirect(t, "/auth/social/start?provider=microsoft&mode=link")

	if got := loc.Query().Get("redirect_uri"); got != "https://app.example.com/client/profile" {
		t.Errorf("redirect_uri = %q, want the profile page", got)
	}
	if got := loc.Query().Get("kc_idp_hint"); got != "microsoft" {
		t.Errorf("kc_idp_hint = %q, want microsoft", got)
	}
}

func TestSocialStartSupportsEveryProvider(t *testing.T) {
	for _, p := range []string{"google", "apple", "microsoft"} {
		loc := startRedirect(t, "/auth/social/start?provider="+p)
		if got := loc.Query().Get("kc_idp_hint"); got != p {
			t.Errorf("provider %s: kc_idp_hint = %q", p, got)
		}
	}
}

// An unknown provider must not be reflected into a Keycloak URL — it goes back
// to the app's own login page with an error instead.
func TestSocialStartRejectsUnknownProvider(t *testing.T) {
	for _, target := range []string{
		"/auth/social/start",
		"/auth/social/start?provider=",
		"/auth/social/start?provider=evil",
	} {
		w := doRequest(socialStartEngine(), httptest.NewRequest(http.MethodGet, target, nil))
		if w.Code != http.StatusFound {
			t.Fatalf("%s: expected 302, got %d", target, w.Code)
		}
		if got := w.Header().Get("Location"); got != "/login?social_error=unsupported_provider" {
			t.Errorf("%s: redirected to %q", target, got)
		}
	}
}
