package routes

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/sanitize"
)

// logAudit fires an audit record in a goroutine so it never blocks the response.
func (h *Handler) logAudit(in db.AuditInput) {
	go func() {
		if err := h.queries.InsertAuditLog(context.Background(), in); err != nil {
			log.Printf("audit log: %v", err)
		}
	}()
}

// strPtr is a convenience helper used when building AuditInput fields.
func strPtr(s string) *string { return &s }

// AdminLogImpersonation handles POST /api/v1/admin/users/:user_id/audit-logs.
// Called by the frontend when an admin clicks a username to view their files.
// Records an impersonation_access event with the acting admin as actor.
func (h *Handler) AdminLogImpersonation(c *gin.Context) {
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	if _, err := h.queries.GetUserByUsername(c.Request.Context(), username); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	actor := c.GetString("username")
	if err := h.queries.InsertAuditLog(c.Request.Context(), db.AuditInput{
		TargetUsername: username,
		ActorUsername:  actor,
		Action:         "impersonation_access",
	}); err != nil {
		log.Printf("AdminLogImpersonation: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not log access"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// AdminGetUserAuditLogs handles GET /api/v1/admin/users/:user_id/audit-logs.
// Returns paginated audit log entries for the specified user, newest first.
// Query params: cursor=<opaque>, limit=<int>.
func (h *Handler) AdminGetUserAuditLogs(c *gin.Context) {
	username := sanitize.String(c.Param("user_id"))
	if username == "" || len(username) > 150 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid user_id"})
		return
	}

	if _, err := h.queries.GetUserByUsername(c.Request.Context(), username); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not fetch user"})
		return
	}

	p := db.PageInput{Cursor: c.Query("cursor")}
	if raw := c.Query("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			p.Limit = n
		}
	}

	result, err := h.queries.ListAuditLogsForUser(c.Request.Context(), username, p)
	if err != nil {
		log.Printf("AdminGetUserAuditLogs: username=%s err=%v", username, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not retrieve audit logs"})
		return
	}

	c.JSON(http.StatusOK, result)
}
