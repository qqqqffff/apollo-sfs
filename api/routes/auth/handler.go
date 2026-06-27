package auth

import "apollo-sfs.com/api/routes/services"

// Handler holds the AuthService and implements all /api/v1/auth/* endpoints.
type Handler struct {
	svc          *services.AuthService
	cookieDomain string
	cookieSecure bool
}

// NewHandler constructs an auth Handler.
func NewHandler(svc *services.AuthService, cookieDomain string, cookieSecure bool) *Handler {
	return &Handler{svc: svc, cookieDomain: cookieDomain, cookieSecure: cookieSecure}
}
