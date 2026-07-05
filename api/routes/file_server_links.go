package routes

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/routes/services"
)

// File-server mount links (premium WebDAV feature). One link per storage
// server; the raw mount URL is returned on every read since possession of
// the URL alone grants nothing — DAV requests also require the owner's
// login credentials.

type createFileServerLinkRequest struct {
	ServerID         string `json:"server_id" binding:"required"`
	EnhancedSecurity bool   `json:"enhanced_security"`
}

type createFileServerLinkResponse struct {
	Link *services.FileServerLinkInfo `json:"link"`
	// Created is false when a link already existed for the chosen server —
	// the UI shows the existing link instead of a success state.
	Created bool `json:"created"`
}

// CreateFileServerLink is POST /api/v1/me/file-server-links.
// Premium-or-admin only; non-premium callers receive 402 so the UI can
// route them to the upgrade page.
func (h *Handler) CreateFileServerLink(c *gin.Context) {
	if h.fileServerLinks == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "file server links not configured"})
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
	var req createFileServerLinkRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	serverID, err := uuid.Parse(req.ServerID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid server id"})
		return
	}
	userID, err := uuid.Parse(c.GetString("userID"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "invalid user id"})
		return
	}
	link, created, err := h.fileServerLinks.Create(c.Request.Context(), userID, user.Username, serverID, req.EnhancedSecurity)
	if err != nil {
		if errors.Is(err, services.ErrLinkServerNotOwned) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": err.Error()})
			return
		}
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "create link failed"})
		return
	}
	status := http.StatusCreated
	if !created {
		status = http.StatusOK
	}
	c.JSON(status, createFileServerLinkResponse{Link: link, Created: created})
}

// ListFileServerLinks is GET /api/v1/me/file-server-links.
// Non-premium users get an empty list (their links, if any existed, were
// destroyed when premium lapsed).
func (h *Handler) ListFileServerLinks(c *gin.Context) {
	if h.fileServerLinks == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "file server links not configured"})
		return
	}
	user, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	if !(user.IsPremium || user.IsAdmin) {
		c.JSON(http.StatusOK, gin.H{"items": []services.FileServerLinkInfo{}})
		return
	}
	links, err := h.fileServerLinks.List(c.Request.Context(), user.Username)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": links})
}

// DeleteFileServerLink is DELETE /api/v1/me/file-server-links/:id.
// Destroys the link immediately: the backend row is removed and every
// subsequent DAV request against its token 404s.
func (h *Handler) DeleteFileServerLink(c *gin.Context) {
	if h.fileServerLinks == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "file server links not configured"})
		return
	}
	user, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid link id"})
		return
	}
	if err := h.fileServerLinks.Delete(c.Request.Context(), user.Username, id); err != nil {
		if errors.Is(err, services.ErrLinkNotFound) {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "link not found"})
			return
		}
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
		return
	}
	c.Status(http.StatusNoContent)
}

type updateFileServerLinkRequest struct {
	EnhancedSecurity *bool `json:"enhanced_security" binding:"required"`
}

// UpdateFileServerLink is PATCH /api/v1/me/file-server-links/:id.
// Currently only the enhanced-security toggle is mutable.
func (h *Handler) UpdateFileServerLink(c *gin.Context) {
	if h.fileServerLinks == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "file server links not configured"})
		return
	}
	user, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid link id"})
		return
	}
	var req updateFileServerLinkRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.EnhancedSecurity == nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "enhanced_security is required"})
		return
	}
	if err := h.fileServerLinks.SetEnhancedSecurity(c.Request.Context(), user.Username, id, *req.EnhancedSecurity); err != nil {
		if errors.Is(err, services.ErrLinkNotFound) {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "link not found"})
			return
		}
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "update failed"})
		return
	}
	c.Status(http.StatusNoContent)
}

type verifyLocationRequest struct {
	Token string `json:"token" binding:"required"`
}

// VerifyFileServerLocation is POST /api/v1/me/file-server-links/verify-location.
// Consumes an emailed enhanced-security verification token. The caller must
// be the signed-in link owner — that sign-in is the second factor.
func (h *Handler) VerifyFileServerLocation(c *gin.Context) {
	if h.fileServerLinks == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "file server links not configured"})
		return
	}
	user, ok := h.loadCurrentUser(c)
	if !ok {
		return
	}
	var req verifyLocationRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "token is required"})
		return
	}
	if err := h.fileServerLinks.VerifyLocation(c.Request.Context(), user.Username, req.Token); err != nil {
		if errors.Is(err, services.ErrLinkNotFound) {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "verification link is invalid or has expired"})
			return
		}
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "verification failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"verified": true})
}
