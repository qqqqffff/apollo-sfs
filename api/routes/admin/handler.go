package admin

import (
	"github.com/oschwald/geoip2-golang"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/routes/services"
)

// Handler holds dependencies for all /api/v1/admin/* endpoints.
type Handler struct {
	queries  *db.Queries
	invites  *services.InviteService
	metrics  *services.MetricsService
	auth     *services.AuthService
	registry *services.MinIORegistry
	geo      *geoip2.Reader
}

// NewHandler constructs an admin Handler.
func NewHandler(queries *db.Queries, inviteSvc *services.InviteService, metricsSvc *services.MetricsService, authSvc *services.AuthService, registry *services.MinIORegistry, geoReader *geoip2.Reader) *Handler {
	return &Handler{queries: queries, invites: inviteSvc, metrics: metricsSvc, auth: authSvc, registry: registry, geo: geoReader}
}
