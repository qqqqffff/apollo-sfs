package admin

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
	"apollo-sfs.com/api/routes/services"
)

// DiscountMailer is the subset of *services.EmailService used to announce a
// new discount. Wired from main via SetDiscountMailer; nil skips
// notifications (the discount is still created).
type DiscountMailer interface {
	SendDiscountNotification(ctx context.Context, toEmail string, data services.DiscountEmailData) error
}

// SetDiscountMailer installs the mailer used by CreatePricingDiscount's
// notification checkboxes. Call once at startup after NewHandler.
func (h *Handler) SetDiscountMailer(m DiscountMailer) {
	h.discountMailer = m
}

// ── GET /api/v1/admin/pricing/servers ─────────────────────────────────────────

// ListPricingServers returns every server with the storage tiers it offers,
// for the pricing page's server picker.
func (h *Handler) ListPricingServers(c *gin.Context) {
	servers, err := h.queries.ListPricingServers(c.Request.Context())
	if err != nil {
		log.Printf("admin ListPricingServers: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list servers"})
		return
	}
	if servers == nil {
		servers = []db.PricingServer{}
	}
	c.JSON(http.StatusOK, gin.H{"servers": servers})
}

// ── GET /api/v1/admin/pricing?server_id= ──────────────────────────────────────

// GetPricing returns a server's line items and its active (unexpired)
// discounts. The frontend computes display prices from the two lists.
func (h *Handler) GetPricing(c *gin.Context) {
	serverID, err := uuid.Parse(c.Query("server_id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid server_id"})
		return
	}
	items, err := h.queries.ListPricingItems(c.Request.Context(), serverID)
	if err != nil {
		log.Printf("admin GetPricing items: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list pricing"})
		return
	}
	discounts, err := h.queries.ListActivePricingDiscounts(c.Request.Context(), serverID)
	if err != nil {
		log.Printf("admin GetPricing discounts: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "list pricing"})
		return
	}
	if items == nil {
		items = []models.PricingItem{}
	}
	if discounts == nil {
		discounts = []models.PricingDiscount{}
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "discounts": discounts})
}

// ── POST /api/v1/admin/pricing/items ──────────────────────────────────────────

// CreatePricingItem adds a line item to a server tier.
// Body: { server_id, storage_type, bytes, price_cents, sort_order }.
func (h *Handler) CreatePricingItem(c *gin.Context) {
	var req struct {
		ServerID    string `json:"server_id"    binding:"required"`
		StorageType string `json:"storage_type" binding:"required,oneof=nvme hdd"`
		Bytes       int64  `json:"bytes"        binding:"required,gt=0"`
		PriceCents  *int   `json:"price_cents"  binding:"required,gte=0"`
		SortOrder   int    `json:"sort_order"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	serverID, err := uuid.Parse(req.ServerID)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid server_id"})
		return
	}
	srv, err := h.queries.GetServer(c.Request.Context(), serverID)
	if err != nil {
		log.Printf("admin CreatePricingItem server: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load server"})
		return
	}
	if srv == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "server not found"})
		return
	}

	item, err := h.queries.CreatePricingItem(c.Request.Context(), db.CreatePricingItemParams{
		ServerID:    serverID,
		StorageType: req.StorageType,
		Bytes:       req.Bytes,
		PriceCents:  *req.PriceCents,
		SortOrder:   req.SortOrder,
	})
	if err != nil {
		if errors.Is(err, db.ErrDuplicatePricingItem) {
			c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		log.Printf("admin CreatePricingItem: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "create item"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"item": item})
}

// ── PATCH /api/v1/admin/pricing/items/:item_id ────────────────────────────────

// UpdatePricingItem overwrites a line item's quantity, price, and order.
// Body: { bytes, price_cents, sort_order }.
func (h *Handler) UpdatePricingItem(c *gin.Context) {
	itemID, err := uuid.Parse(c.Param("item_id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid item id"})
		return
	}
	var req struct {
		Bytes      int64 `json:"bytes"       binding:"required,gt=0"`
		PriceCents *int  `json:"price_cents" binding:"required,gte=0"`
		SortOrder  int   `json:"sort_order"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	item, err := h.queries.UpdatePricingItem(c.Request.Context(), itemID, req.Bytes, *req.PriceCents, req.SortOrder)
	if err != nil {
		if errors.Is(err, db.ErrDuplicatePricingItem) {
			c.AbortWithStatusJSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		log.Printf("admin UpdatePricingItem: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "update item"})
		return
	}
	if item == nil {
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "item not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"item": item})
}

// ── DELETE /api/v1/admin/pricing/items/:item_id ───────────────────────────────

// DeletePricingItem removes a line item (its item-scope discount cascades).
func (h *Handler) DeletePricingItem(c *gin.Context) {
	itemID, err := uuid.Parse(c.Param("item_id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid item id"})
		return
	}
	if err := h.queries.DeletePricingItem(c.Request.Context(), itemID); err != nil {
		log.Printf("admin DeletePricingItem: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "delete item"})
		return
	}
	c.Status(http.StatusNoContent)
}

// ── POST /api/v1/admin/pricing/discounts ──────────────────────────────────────

// CreatePricingDiscount creates (or replaces) the discount on one target —
// a whole server, one server tier, or a single line item — and optionally
// emails a user group about it.
// Body: { scope, server_id?, storage_type?, item_id?, mode, percent_off?,
//         price_cents?, premium_only, expires_at?, notify? }.
// notify is "all" | "server" | "server_tier" | "" (no emails). When
// premium_only is set, notifications go only to premium users and admins —
// the group the discount actually applies to.
func (h *Handler) CreatePricingDiscount(c *gin.Context) {
	var req struct {
		Scope       string     `json:"scope"        binding:"required,oneof=server tier item"`
		ServerID    string     `json:"server_id"`
		StorageType string     `json:"storage_type" binding:"omitempty,oneof=nvme hdd"`
		ItemID      string     `json:"item_id"`
		Mode        string     `json:"mode"         binding:"required,oneof=percent price"`
		PercentOff  *int       `json:"percent_off"`
		PriceCents  *int       `json:"price_cents"`
		PremiumOnly bool       `json:"premium_only"`
		ExpiresAt   *time.Time `json:"expires_at"`
		Notify      string     `json:"notify"       binding:"omitempty,oneof=all server server_tier"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	d := &models.PricingDiscount{
		Scope:       req.Scope,
		Mode:        req.Mode,
		PremiumOnly: req.PremiumOnly,
		ExpiresAt:   req.ExpiresAt,
		CreatedBy:   c.GetString("username"),
	}

	switch req.Mode {
	case models.DiscountModePercent:
		if req.PercentOff == nil || *req.PercentOff < 1 || *req.PercentOff > 100 {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "percent_off must be between 1 and 100"})
			return
		}
		d.PercentOff = req.PercentOff
	case models.DiscountModePrice:
		if req.PriceCents == nil || *req.PriceCents < 0 {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "price_cents must be a non-negative reduced price"})
			return
		}
		d.PriceCents = req.PriceCents
	}

	if req.ExpiresAt != nil && !req.ExpiresAt.After(time.Now()) {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "expires_at must be in the future"})
		return
	}

	// Resolve the target. Item scope derives server/tier from the item so the
	// stored row never needs a join; the other scopes validate the server.
	var scopedItem *models.PricingItem
	switch req.Scope {
	case models.DiscountScopeItem:
		itemID, err := uuid.Parse(req.ItemID)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid item_id"})
			return
		}
		item, err := h.queries.GetPricingItem(c.Request.Context(), itemID)
		if err != nil {
			log.Printf("admin CreatePricingDiscount item: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load item"})
			return
		}
		if item == nil {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "item not found"})
			return
		}
		if req.Mode == models.DiscountModePrice && *req.PriceCents >= item.PriceCents {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "reduced price must be below the item's current price"})
			return
		}
		scopedItem = item
		d.ItemID = &item.ID
		d.ServerID = item.ServerID
		d.StorageType = &item.StorageType
	case models.DiscountScopeTier, models.DiscountScopeServer:
		serverID, err := uuid.Parse(req.ServerID)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid server_id"})
			return
		}
		srv, err := h.queries.GetServer(c.Request.Context(), serverID)
		if err != nil {
			log.Printf("admin CreatePricingDiscount server: %v", err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "load server"})
			return
		}
		if srv == nil {
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "server not found"})
			return
		}
		d.ServerID = serverID
		if req.Scope == models.DiscountScopeTier {
			if req.StorageType == "" {
				c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "storage_type required for tier discounts"})
				return
			}
			st := req.StorageType
			d.StorageType = &st
		}
	}

	if req.Notify != "" {
		n := req.Notify
		d.NotifyGroup = &n
	}

	if err := h.queries.CreatePricingDiscount(c.Request.Context(), d); err != nil {
		log.Printf("admin CreatePricingDiscount: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "create discount"})
		return
	}

	notified := 0
	if req.Notify != "" {
		notified = h.notifyDiscount(c.Request.Context(), d, scopedItem, req.Notify)
	}

	c.JSON(http.StatusCreated, gin.H{"discount": d, "recipients_notified": notified})
}

// ── DELETE /api/v1/admin/pricing/discounts/:discount_id ───────────────────────

// DeletePricingDiscount removes a discount, restoring the underlying prices.
func (h *Handler) DeletePricingDiscount(c *gin.Context) {
	id, err := uuid.Parse(c.Param("discount_id"))
	if err != nil {
		c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid discount id"})
		return
	}
	if err := h.queries.DeletePricingDiscount(c.Request.Context(), id); err != nil {
		log.Printf("admin DeletePricingDiscount: %v", err)
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "delete discount"})
		return
	}
	c.Status(http.StatusNoContent)
}

// ── Notification emails ───────────────────────────────────────────────────────

// notifyDiscount enqueues the discount announcement to every user in the
// selected group and returns how many were enqueued. Failures are logged and
// skipped — the discount itself is already committed.
func (h *Handler) notifyDiscount(ctx context.Context, d *models.PricingDiscount, scopedItem *models.PricingItem, group string) int {
	if h.discountMailer == nil {
		log.Printf("admin notifyDiscount: no mailer configured, skipping")
		return 0
	}

	storageType := ""
	if d.StorageType != nil {
		storageType = *d.StorageType
	}
	recipients, err := h.queries.ListDiscountRecipients(ctx, group, d.ServerID, storageType, d.PremiumOnly)
	if err != nil {
		log.Printf("admin notifyDiscount recipients: %v", err)
		return 0
	}
	if len(recipients) == 0 {
		return 0
	}

	data, err := h.buildDiscountEmail(ctx, d, scopedItem)
	if err != nil {
		log.Printf("admin notifyDiscount build email: %v", err)
		return 0
	}

	notified := 0
	for _, to := range recipients {
		if err := h.discountMailer.SendDiscountNotification(ctx, to, data); err != nil {
			log.Printf("admin notifyDiscount enqueue %s: %v", to, err)
			continue
		}
		notified++
	}
	return notified
}

// buildDiscountEmail assembles the announcement's display data: the affected
// line items with old vs new price and badge percentage.
func (h *Handler) buildDiscountEmail(ctx context.Context, d *models.PricingDiscount, scopedItem *models.PricingItem) (services.DiscountEmailData, error) {
	srv, err := h.queries.GetServer(ctx, d.ServerID)
	if err != nil {
		return services.DiscountEmailData{}, err
	}
	serverName := "your server"
	if srv != nil {
		serverName = srv.Name
	}

	var affected []models.PricingItem
	if scopedItem != nil {
		affected = []models.PricingItem{*scopedItem}
	} else {
		items, err := h.queries.ListPricingItems(ctx, d.ServerID)
		if err != nil {
			return services.DiscountEmailData{}, err
		}
		for _, it := range items {
			if d.AppliesTo(&it) {
				affected = append(affected, it)
			}
		}
	}

	deals := make([]services.DiscountDeal, 0, len(affected))
	for _, it := range affected {
		newCents := d.DiscountedPriceCents(it.PriceCents)
		if newCents >= it.PriceCents {
			continue // tier/server reduced price at or above this item's price — no deal
		}
		deals = append(deals, services.DiscountDeal{
			Label:    fmt.Sprintf("%s %s", formatBytesLabel(it.Bytes), tierLabel(it.StorageType)),
			OldPrice: formatUSD(it.PriceCents),
			NewPrice: formatUSD(newCents),
			Percent:  d.DiscountPercentFor(it.PriceCents),
		})
	}

	scopeLabel := ""
	switch d.Scope {
	case models.DiscountScopeServer:
		scopeLabel = fmt.Sprintf("all storage plans on %s", serverName)
	case models.DiscountScopeTier:
		scopeLabel = fmt.Sprintf("all %s storage plans on %s", tierLabel(*d.StorageType), serverName)
	case models.DiscountScopeItem:
		if len(deals) > 0 {
			scopeLabel = fmt.Sprintf("the %s plan on %s", deals[0].Label, serverName)
		} else {
			scopeLabel = fmt.Sprintf("a storage plan on %s", serverName)
		}
	}

	expires := ""
	if d.ExpiresAt != nil {
		expires = d.ExpiresAt.Format("Mon, 02 Jan 2006 15:04 MST")
	}

	return services.DiscountEmailData{
		ServerName:  serverName,
		ScopeLabel:  scopeLabel,
		Deals:       deals,
		ExpiresAt:   expires,
		PremiumOnly: d.PremiumOnly,
	}, nil
}

func tierLabel(storageType string) string {
	switch storageType {
	case "nvme":
		return "Fast (NVMe)"
	case "hdd":
		return "Standard (HDD)"
	}
	return strings.ToUpper(storageType)
}

func formatUSD(cents int) string {
	return fmt.Sprintf("$%.2f", float64(cents)/100)
}

// formatBytesLabel renders a storage quantity as plan labels do: whole GB
// below 1 TiB, TB with up to two decimals above.
func formatBytesLabel(bytes int64) string {
	const gib = int64(1) << 30
	const tib = int64(1) << 40
	if bytes <= 0 {
		return "0 GB"
	}
	if bytes < tib {
		return fmt.Sprintf("%d GB", (bytes+gib-1)/gib)
	}
	tb := float64(bytes) / float64(tib)
	s := strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", tb), "0"), ".")
	return s + " TB"
}
