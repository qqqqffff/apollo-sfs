package admin

import (
	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/routes/services"
)

// Handler holds dependencies for all /api/v1/admin/* endpoints.
type Handler struct {
	queries *db.Queries
	invites *services.InviteService
	metrics *services.MetricsService
}

// NewHandler constructs an admin Handler.
func NewHandler(queries *db.Queries, inviteSvc *services.InviteService, metricsSvc *services.MetricsService) *Handler {
	return &Handler{queries: queries, invites: inviteSvc, metrics: metricsSvc}
}
