// Package orders serves the admin Orders page: a combined, searchable view of
// premium payments and storage add-on purchases, with a 90-day refund action.
package orders

import (
	"context"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/routes/services"
)

// refundWindowDays is how long after capture an order stays refundable.
const refundWindowDays = 90

// Querier is the subset of *db.Queries used by the orders handler.
type Querier interface {
	ListAdminOrders(ctx context.Context, search, sort string, limit, offset int) ([]db.AdminOrder, int, error)
	GetAdminOrder(ctx context.Context, orderType string, id uuid.UUID) (*db.AdminOrder, error)
	MarkPaymentRefundedByID(ctx context.Context, id uuid.UUID, refundID string) (bool, error)
	MarkStorageOrderRefunded(ctx context.Context, id uuid.UUID, refundID string) (bool, error)
	AddUserQuota(ctx context.Context, username string, bytesAdded int64) (int64, error)
	RevokePremium(ctx context.Context, username string) error
}

// Compile-time check.
var _ Querier = (*db.Queries)(nil)

// Handler wires the /api/v1/admin/orders endpoints.
type Handler struct {
	paypal  *services.PayPalClient
	queries Querier
}

func NewHandler(paypal *services.PayPalClient, q Querier) *Handler {
	return &Handler{paypal: paypal, queries: q}
}

// List returns searched, sorted, offset-paginated combined orders.
// GET /api/v1/admin/orders?search=&sort=&page=&page_size=
// sort: "date" (default) | "amount".
func (h *Handler) List(c *gin.Context) {
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "25"))
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	if page < 1 {
		page = 1
	}

	items, total, err := h.queries.ListAdminOrders(
		c.Request.Context(),
		strings.TrimSpace(c.Query("search")),
		c.Query("sort"),
		pageSize, (page-1)*pageSize,
	)
	if err != nil {
		log.Printf("orders List: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list failed"})
		return
	}
	if items == nil {
		items = []db.AdminOrder{}
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "total": total, "page": page, "page_size": pageSize})
}

// Refund refunds a captured order in full via PayPal. Premium refunds revoke
// the premium flag; storage refunds subtract the purchased quota. The refund
// window closes 90 days after capture.
// POST /api/v1/admin/orders/:type/:id/refund
func (h *Handler) Refund(c *gin.Context) {
	if h.paypal == nil {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{"error": "payments not configured"})
		return
	}

	orderType := c.Param("type")
	if orderType != "premium" && orderType != "storage" {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "type must be premium or storage"})
		return
	}
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}

	order, err := h.queries.GetAdminOrder(c.Request.Context(), orderType, id)
	if err != nil {
		log.Printf("orders Refund load: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load order"})
		return
	}
	if order == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	if order.Status != "captured" || order.PayPalCaptureID == nil {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": "order is not refundable"})
		return
	}
	if order.CapturedAt == nil || time.Since(*order.CapturedAt) > refundWindowDays*24*time.Hour {
		c.AbortWithStatusJSON(http.StatusConflict, gin.H{
			"error": "refund window has closed (90 days after capture)",
		})
		return
	}

	refund, err := h.paypal.RefundCapture(c.Request.Context(), *order.PayPalCaptureID, int(order.AmountCents), order.Currency)
	if err != nil {
		log.Printf("orders Refund paypal: %v", err)
		c.AbortWithStatusJSON(http.StatusBadGateway, gin.H{"error": "refund failed"})
		return
	}

	var applied bool
	if orderType == "premium" {
		applied, err = h.queries.MarkPaymentRefundedByID(c.Request.Context(), id, refund.RefundID)
	} else {
		applied, err = h.queries.MarkStorageOrderRefunded(c.Request.Context(), id, refund.RefundID)
	}
	if err != nil {
		log.Printf("orders Refund persist: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "record refund"})
		return
	}
	if applied {
		if orderType == "premium" {
			if err := h.queries.RevokePremium(c.Request.Context(), order.Username); err != nil {
				log.Printf("orders Refund revoke premium: %v", err)
			}
		} else if order.BytesAdded > 0 {
			if _, err := h.queries.AddUserQuota(c.Request.Context(), order.Username, -order.BytesAdded); err != nil {
				log.Printf("orders Refund revert quota: %v", err)
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"refund_id": refund.RefundID})
}
