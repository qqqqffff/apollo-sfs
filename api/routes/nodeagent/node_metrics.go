// Package nodeagent holds the internal endpoints the per-node metrics agents
// push to. They are reachable only from inside the cluster's overlay network
// (never proxied by the public nginx) and authenticate with a shared token
// rather than a Keycloak session.
package nodeagent

import (
	"crypto/subtle"
	"net/http"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// Handler serves the internal node-metrics ingest endpoint. token is the shared
// secret each node agent must present in the X-Internal-Token header.
type Handler struct {
	ingest *services.NodeIngestService
	token  string
}

// NewHandler constructs an internal Handler. An empty token disables ingest:
// every request is rejected, so a misconfigured deployment fails closed.
func NewHandler(ingestSvc *services.NodeIngestService, token string) *Handler {
	return &Handler{ingest: ingestSvc, token: token}
}

// IngestNodeMetrics handles POST /api/v1/internal/node-metrics.
// A per-node agent pushes its host's latest hardware metrics here every sample.
func (h *Handler) IngestNodeMetrics(c *gin.Context) {
	if !h.authorized(c.GetHeader("X-Internal-Token")) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return
	}

	var payload models.NodeMetricsPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if payload.Hostname == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "hostname is required"})
		return
	}

	if err := h.ingest.UpdateNodeMetrics(c.Request.Context(), &payload); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not ingest node metrics"})
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"status": "accepted"})
}

// authorized constant-time-compares the presented token to the configured one.
// An empty configured token always fails (ingest disabled / fail closed).
func (h *Handler) authorized(presented string) bool {
	if h.token == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(h.token)) == 1
}
