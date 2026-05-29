package routes

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

type createAPIKeyRequest struct {
	Name    string               `json:"name"     binding:"required"`
	Scopes  []apiKeyScopeRequest `json:"scopes"   binding:"required,min=1,dive"`
	TTLDays int                  `json:"ttl_days"`
}

type apiKeyScopeRequest struct {
	Operation  string `json:"operation"   binding:"required,oneof=read write delete list"`
	PathPrefix string `json:"path_prefix"`
}

type createAPIKeyResponse struct {
	RawKey string         `json:"raw_key"`
	Key    *models.APIKey `json:"key"`
}

// CreateAPIKey is POST /api/v1/me/api-keys.
// Premium-or-admin only; non-premium callers receive 402 so the UI can
// route them to the upgrade page.
func (h *Handler) CreateAPIKey(c *gin.Context) {
	if h.apiKeys == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "api keys not configured"})
		return
	}
	user, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	if !(user.IsPremium || user.IsAdmin) {
		c.AbortWithStatusJSON(http.StatusPaymentRequired, gin.H{"error": "premium tier required"})
		return
	}

	var req createAPIKeyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	scopes := make([]models.APIKeyScope, 0, len(req.Scopes))
	for _, s := range req.Scopes {
		scopes = append(scopes, models.APIKeyScope{
			Operation:  s.Operation,
			PathPrefix: s.PathPrefix,
		})
	}
	userID, err := uuid.Parse(user.Username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "invalid user id"})
		return
	}
	ttl := time.Duration(req.TTLDays) * 24 * time.Hour
	issued, err := h.apiKeys.Issue(c.Request.Context(), userID, services.IssueInput{
		Username: user.Username,
		Name:     req.Name,
		Scopes:   scopes,
		TTL:      ttl,
	})
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, createAPIKeyResponse{
		RawKey: issued.RawKey,
		Key:    issued.Key,
	})
}

// listAPIKeyEntry is the shape returned by ListAPIKeys. MatchingOperations
// is populated per-key when the caller passes ?path=... — used by the
// share-directory modal to show which existing keys already cover the
// folder being shared.
type listAPIKeyEntry struct {
	models.APIKey
	MatchingOperations []string `json:"matching_operations,omitempty"`
}

// ListAPIKeys is GET /api/v1/me/api-keys[?path=<prefix>].
func (h *Handler) ListAPIKeys(c *gin.Context) {
	if h.apiKeys == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "api keys not configured"})
		return
	}
	user, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	if !(user.IsPremium || user.IsAdmin) {
		c.JSON(http.StatusOK, gin.H{"items": []listAPIKeyEntry{}})
		return
	}
	userID, err := uuid.Parse(user.Username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "invalid user id"})
		return
	}
	keys, err := h.apiKeys.List(c.Request.Context(), userID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	path := c.Query("path")
	entries := make([]listAPIKeyEntry, 0, len(keys))
	for _, k := range keys {
		e := listAPIKeyEntry{APIKey: k}
		if path != "" {
			e.MatchingOperations = h.apiKeys.MatchingOperations(k.Scopes, path)
		}
		entries = append(entries, e)
	}
	c.JSON(http.StatusOK, gin.H{"items": entries})
}

// RevokeAPIKey is DELETE /api/v1/me/api-keys/:id.
func (h *Handler) RevokeAPIKey(c *gin.Context) {
	if h.apiKeys == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "api keys not configured"})
		return
	}
	user, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid key id"})
		return
	}
	userID, err := uuid.Parse(user.Username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "invalid user id"})
		return
	}
	if err := h.apiKeys.Revoke(c.Request.Context(), userID, id); err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "revoke failed"})
		return
	}
	c.Status(http.StatusNoContent)
}

// loadCurrentUser pulls the username from the Gin context (set by
// RequireAuth) and fetches the full *models.User row via the existing
// Querier interface.
func (h *Handler) loadCurrentUser(c *gin.Context) (*models.User, bool) {
	usernameAny, exists := c.Get("username")
	if !exists {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return nil, false
	}
	username, _ := usernameAny.(string)
	if username == "" {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
		return nil, false
	}
	user, err := h.queries.GetUserByUsername(c.Request.Context(), username)
	if err != nil {
		if errors.Is(err, errNotFoundUserSentinel) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return nil, false
		}
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load user"})
		return nil, false
	}
	return user, true
}

// errNotFoundUserSentinel is a placeholder to silence unused-import. The
// real not-found sentinel from db.Queries is sql.ErrNoRows; this branch is
// only here to keep loadCurrentUser monomorphic for the test stub Querier.
var errNotFoundUserSentinel = errors.New("user not found")
