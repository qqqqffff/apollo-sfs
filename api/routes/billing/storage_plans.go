package billing

import (
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// ── GET /api/v1/billing/storage/plans ─────────────────────────────────────────

// planDiscountInfo describes the active discount applied to one plan row, for
// the client's marked-down price display (badge percentage + countdown).
type planDiscountInfo struct {
	ID          uuid.UUID  `json:"id"`
	Scope       string     `json:"scope"`
	Mode        string     `json:"mode"`
	Percent     int        `json:"percent"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
	PremiumOnly bool       `json:"premium_only"`
}

type storagePlanResponse struct {
	ID          uuid.UUID `json:"id"`
	StorageType string    `json:"storage_type"`
	Bytes       int64     `json:"bytes"`
	PriceCents  int       `json:"price_cents"`
	// EffectiveCents is what this user pays right now (== PriceCents when no
	// discount applies to them).
	EffectiveCents int               `json:"effective_cents"`
	Discount       *planDiscountInfo `json:"discount,omitempty"`
}

// GetStoragePlans returns the admin-managed storage line items for a server,
// priced for the calling user (premium-gated discounts are resolved against
// their premium/admin status). An empty items list means the server has no
// admin-managed pricing and the client should fall back to the legacy
// hardcoded plans. Query: ?server_id=<uuid>.
func (h *Handler) GetStoragePlans(c *gin.Context) {
	username, ok := h.currentUsername(c)
	if !ok {
		return
	}
	serverID, err := uuid.Parse(c.Query("server_id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid server_id"})
		return
	}

	items, err := h.queries.ListPricingItems(c.Request.Context(), serverID)
	if err != nil {
		log.Printf("billing GetStoragePlans items: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list plans"})
		return
	}

	resp := make([]storagePlanResponse, 0, len(items))
	if len(items) > 0 {
		discounts, err := h.queries.ListActivePricingDiscounts(c.Request.Context(), serverID)
		if err != nil {
			log.Printf("billing GetStoragePlans discounts: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list plans"})
			return
		}
		privileged := false
		if len(discounts) > 0 {
			if privileged, err = userIsPrivileged(c.Request.Context(), h.queries, username); err != nil {
				log.Printf("billing GetStoragePlans user: %v", err)
				c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list plans"})
				return
			}
		}
		now := time.Now()
		for i := range items {
			it := &items[i]
			row := storagePlanResponse{
				ID:             it.ID,
				StorageType:    it.StorageType,
				Bytes:          it.Bytes,
				PriceCents:     it.PriceCents,
				EffectiveCents: it.PriceCents,
			}
			if d := models.ResolveDiscount(it, discounts, privileged, now); d != nil {
				row.EffectiveCents = d.DiscountedPriceCents(it.PriceCents)
				row.Discount = &planDiscountInfo{
					ID:          d.ID,
					Scope:       d.Scope,
					Mode:        d.Mode,
					Percent:     d.DiscountPercentFor(it.PriceCents),
					ExpiresAt:   d.ExpiresAt,
					PremiumOnly: d.PremiumOnly,
				}
			}
			resp = append(resp, row)
		}
	}

	c.JSON(http.StatusOK, gin.H{"items": resp})
}
