package models

import (
	"time"

	"github.com/google/uuid"
)

// PricingItem is one purchasable storage line item on a server tier —
// admin-edited via the pricing page and purchased by its UUID (the plan_id
// recorded on storage_orders). Servers without any items fall back to the
// legacy hardcoded plan table in routes/billing/plans.go.
type PricingItem struct {
	ID          uuid.UUID `json:"id"`
	ServerID    uuid.UUID `json:"server_id"`
	StorageType string    `json:"storage_type"` // "nvme" | "hdd"
	Bytes       int64     `json:"bytes"`
	PriceCents  int       `json:"price_cents"`
	SortOrder   int       `json:"sort_order"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// Pricing discount scopes and modes. Exactly one discount row exists per
// exact target (server / server+tier / item); the most specific applicable
// one wins at resolution time — discounts never stack.
const (
	DiscountScopeServer = "server"
	DiscountScopeTier   = "tier"
	DiscountScopeItem   = "item"

	DiscountModePercent = "percent"
	DiscountModePrice   = "price"
)

// PricingDiscount is an admin-created markdown of one pricing target.
// ServerID and StorageType are always populated (denormalized from the item
// for scope='item') so listings and recipient queries never need a join.
type PricingDiscount struct {
	ID          uuid.UUID  `json:"id"`
	Scope       string     `json:"scope"`
	ServerID    uuid.UUID  `json:"server_id"`
	StorageType *string    `json:"storage_type,omitempty"`
	ItemID      *uuid.UUID `json:"item_id,omitempty"`
	Mode        string     `json:"mode"`
	PercentOff  *int       `json:"percent_off,omitempty"`
	PriceCents  *int       `json:"price_cents,omitempty"`
	PremiumOnly bool       `json:"premium_only"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
	NotifyGroup *string    `json:"notify_group,omitempty"`
	CreatedBy   string     `json:"created_by"`
	CreatedAt   time.Time  `json:"created_at"`
}

// Active reports whether the discount is in effect at t (not expired).
func (d *PricingDiscount) Active(t time.Time) bool {
	return d.ExpiresAt == nil || d.ExpiresAt.After(t)
}

// AppliesTo reports whether the discount targets the given item, ignoring
// expiry and premium gating (callers filter those separately).
func (d *PricingDiscount) AppliesTo(item *PricingItem) bool {
	switch d.Scope {
	case DiscountScopeItem:
		return d.ItemID != nil && *d.ItemID == item.ID
	case DiscountScopeTier:
		return d.ServerID == item.ServerID &&
			d.StorageType != nil && *d.StorageType == item.StorageType
	case DiscountScopeServer:
		return d.ServerID == item.ServerID
	}
	return false
}

// discountScopeRank orders scopes most-specific-first for resolution.
var discountScopeRank = map[string]int{
	DiscountScopeItem:   0,
	DiscountScopeTier:   1,
	DiscountScopeServer: 2,
}

// ResolveDiscount picks the discount that applies to item from candidates:
// the most specific (item > tier > server) discount that is unexpired at now
// and — unless privileged (premium or admin user) — not premium-gated.
// Returns nil when none apply.
func ResolveDiscount(item *PricingItem, candidates []PricingDiscount, privileged bool, now time.Time) *PricingDiscount {
	var best *PricingDiscount
	for i := range candidates {
		d := &candidates[i]
		if !d.Active(now) || (d.PremiumOnly && !privileged) || !d.AppliesTo(item) {
			continue
		}
		if best == nil || discountScopeRank[d.Scope] < discountScopeRank[best.Scope] {
			best = d
		}
	}
	return best
}

// DiscountedPriceCents applies d to a base price. Percent mode rounds
// half-up; price mode clamps to the base price so a tier/server-wide reduced
// price can never mark an item up.
func (d *PricingDiscount) DiscountedPriceCents(baseCents int) int {
	switch d.Mode {
	case DiscountModePercent:
		if d.PercentOff == nil {
			return baseCents
		}
		return (baseCents*(100-*d.PercentOff) + 50) / 100
	case DiscountModePrice:
		if d.PriceCents == nil || *d.PriceCents > baseCents {
			return baseCents
		}
		return *d.PriceCents
	}
	return baseCents
}

// DiscountPercentFor is the percentage shown on the markdown badge: the
// stored percentage in percent mode, or the per-item deduction derived from
// the reduced price in price mode (rounded to the nearest whole percent).
func (d *PricingDiscount) DiscountPercentFor(baseCents int) int {
	if d.Mode == DiscountModePercent && d.PercentOff != nil {
		return *d.PercentOff
	}
	if baseCents <= 0 {
		return 0
	}
	off := baseCents - d.DiscountedPriceCents(baseCents)
	return (off*100 + baseCents/2) / baseCents
}
