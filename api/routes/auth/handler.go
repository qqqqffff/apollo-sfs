package auth

import "apollo-sfs.com/api/routes/services"

// Handler holds the AuthService and implements all /api/v1/auth/* endpoints.
type Handler struct {
	svc *services.AuthService
}

// NewHandler constructs an auth Handler.
func NewHandler(svc *services.AuthService) *Handler {
	return &Handler{svc: svc}
}
