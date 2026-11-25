package auth

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// socialCallbackPath is where Keycloak sends the browser back after a brokered
// sign-in.
const socialCallbackPath = "/api/v1/auth/social/callback"

// linkRedirectPath is the redirect_uri for the profile page's "Connect" flow.
// Must stay identical to brokeredLinkRedirectPath in routes/me.go, which is
// what the resulting code is exchanged against.
const linkRedirectPath = "/client/profile"

// SocialStart handles GET /api/v1/auth/social/start?provider=…&mode=…
//
// It 302s the browser into Keycloak's brokered authorization-code flow. The
// frontend links here rather than building a Keycloak URL itself, so no
// user-facing surface has to know (or hardcode) auth.apollo-sfs.com, and every
// parameter that decides where the user ends up — the redirect_uri above all —
// is fixed server-side instead of being attacker-suppliable in a link.
//
// kc_idp_hint is what keeps this off Keycloak's own login page: Keycloak
// forwards straight to the provider rather than rendering a username/password
// form. The realm's first-broker-login flow is configured to complete silently
// too (see keycloak/KC_setup.md §5), so a brokered sign-in never shows a
// Keycloak-rendered page at any step.
func (h *Handler) SocialStart(c *gin.Context) {
	provider := c.Query("provider")
	if provider != "google" && provider != "apple" && provider != "microsoft" {
		c.Redirect(http.StatusFound, "/login?social_error=unsupported_provider")
		return
	}

	// mode=link is the profile page's "Connect" flow, which must land back on
	// the SPA (not the API callback) so the code can be forwarded over a
	// same-site XHR that carries the SameSite=Strict session cookie.
	redirectPath := socialCallbackPath
	if c.Query("mode") == "link" {
		redirectPath = linkRedirectPath
	}

	c.Redirect(http.StatusFound, h.svc.BrokerAuthorizeURL(provider, redirectPath))
}
