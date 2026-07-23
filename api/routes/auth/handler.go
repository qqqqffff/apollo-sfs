package auth

import "apollo-sfs.com/api/routes/services"

// Handler holds the AuthService and implements all /api/v1/auth/* endpoints.
type Handler struct {
	svc             *services.AuthService
	cookieDomain    string
	cookieSecure    bool
	turnstileSecret string
	// verifyCaptcha overrides the real Turnstile HTTP call. When nil the
	// production verifyTurnstile function (captcha.go) is used.
	verifyCaptcha func(secret, token, ip string) (bool, error)
}

// NewHandler constructs an auth Handler.
func NewHandler(svc *services.AuthService, cookieDomain string, cookieSecure bool, turnstileSecret string) *Handler {
	return &Handler{svc: svc, cookieDomain: cookieDomain, cookieSecure: cookieSecure, turnstileSecret: turnstileSecret}
}

// SetVerifyCaptcha replaces the Turnstile verification function. Intended for
// tests that need to bypass real HTTP calls to Cloudflare.
func SetVerifyCaptcha(h *Handler, fn func(secret, token, ip string) (bool, error)) {
	h.verifyCaptcha = fn
}
