package admin

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// InboundEmailServicer is the subset of *services.InboundEmailService used by
// the inbound email handlers. Defined as an interface so tests can stub it.
type InboundEmailServicer interface {
	StoreEmail(ctx context.Context, toAddr string, msg models.StoredEmail) (*models.InboundEmail, error)
	ListWorkers(ctx context.Context) ([]models.WorkerSummary, error)
	ListEmails(ctx context.Context, worker string, in db.PageInput) (*db.PageResult[models.InboundEmail], error)
	GetEmail(ctx context.Context, id uuid.UUID) (*models.EmailDetail, error)
	MarkRead(ctx context.Context, id uuid.UUID) error
	DeleteEmail(ctx context.Context, id uuid.UUID) error
}

var _ InboundEmailServicer = (*services.InboundEmailService)(nil)

// InboundEmailHandler serves the SendGrid Inbound Parse webhook (public) and the
// admin console's email browsing endpoints. webhookSecret, when non-empty, is a
// shared secret that callers of the webhook must supply as the ?token= query
// param — SendGrid Inbound Parse provides no signature, so this guards the
// public endpoint against unsolicited POSTs.
type InboundEmailHandler struct {
	svc           InboundEmailServicer
	webhookSecret string
}

// NewInboundEmailHandler constructs the handler. webhookSecret may be "" to
// disable the shared-secret check (not recommended in production).
func NewInboundEmailHandler(svc InboundEmailServicer, webhookSecret string) *InboundEmailHandler {
	return &InboundEmailHandler{svc: svc, webhookSecret: webhookSecret}
}

// ListEmailWorkers handles GET /api/v1/admin/emails/workers.
// Returns one entry per service mailbox with total + unread counts.
func (h *InboundEmailHandler) ListEmailWorkers(c *gin.Context) {
	workers, err := h.svc.ListWorkers(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list workers"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"workers": workers})
}

// ListEmails handles GET /api/v1/admin/emails?worker=&cursor=&limit=.
// worker is optional; when omitted all mailboxes are listed newest-first.
func (h *InboundEmailHandler) ListEmails(c *gin.Context) {
	page := db.PageInput{Cursor: strings.TrimSpace(c.Query("cursor"))}
	if err := parseLimit(c, &page.Limit); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be a positive integer"})
		return
	}

	worker := strings.TrimSpace(c.Query("worker"))
	result, err := h.svc.ListEmails(c.Request.Context(), worker, page)
	if err != nil {
		if errors.Is(err, services.ErrInvalidWorker) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid worker"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list emails"})
		return
	}
	c.JSON(http.StatusOK, result)
}

// GetEmail handles GET /api/v1/admin/emails/:id.
// Returns the index metadata plus the full message body read from disk.
func (h *InboundEmailHandler) GetEmail(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid email id"})
		return
	}
	detail, err := h.svc.GetEmail(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "email not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not load email"})
		return
	}
	c.JSON(http.StatusOK, detail)
}

// MarkEmailRead handles PATCH /api/v1/admin/emails/:id/read.
func (h *InboundEmailHandler) MarkEmailRead(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid email id"})
		return
	}
	if err := h.svc.MarkRead(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not mark email read"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "email marked read"})
}

// DeleteEmail handles DELETE /api/v1/admin/emails/:id.
func (h *InboundEmailHandler) DeleteEmail(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid email id"})
		return
	}
	if err := h.svc.DeleteEmail(c.Request.Context(), id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			c.JSON(http.StatusNotFound, gin.H{"error": "email not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not delete email"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "email deleted"})
}
