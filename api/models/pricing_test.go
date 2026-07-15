package models

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func ptr[T any](v T) *T { return &v }

func TestResolveDiscountPrecedenceAndFilters(t *testing.T) {
	now := time.Now()
	serverID := uuid.New()
	item := &PricingItem{ID: uuid.New(), ServerID: serverID, StorageType: "nvme", PriceCents: 8000}

	server := PricingDiscount{ID: uuid.New(), Scope: DiscountScopeServer, ServerID: serverID,
		Mode: DiscountModePercent, PercentOff: ptr(10)}
	tier := PricingDiscount{ID: uuid.New(), Scope: DiscountScopeTier, ServerID: serverID,
		StorageType: ptr("nvme"), Mode: DiscountModePercent, PercentOff: ptr(20)}
	itemD := PricingDiscount{ID: uuid.New(), Scope: DiscountScopeItem, ServerID: serverID,
		StorageType: ptr("nvme"), ItemID: ptr(item.ID), Mode: DiscountModePercent, PercentOff: ptr(30)}

	// Most specific scope wins regardless of slice order.
	got := ResolveDiscount(item, []PricingDiscount{server, itemD, tier}, false, now)
	if got == nil || got.ID != itemD.ID {
		t.Fatalf("want item-scope discount, got %+v", got)
	}

	// Expired item discount falls through to the tier one.
	expired := itemD
	expired.ExpiresAt = ptr(now.Add(-time.Minute))
	got = ResolveDiscount(item, []PricingDiscount{server, expired, tier}, false, now)
	if got == nil || got.ID != tier.ID {
		t.Fatalf("want tier-scope discount after expiry, got %+v", got)
	}

	// Premium-gated tier discount is skipped for a non-privileged user but
	// applies to a privileged one.
	gated := tier
	gated.PremiumOnly = true
	got = ResolveDiscount(item, []PricingDiscount{server, gated}, false, now)
	if got == nil || got.ID != server.ID {
		t.Fatalf("want server-scope discount for non-premium user, got %+v", got)
	}
	got = ResolveDiscount(item, []PricingDiscount{server, gated}, true, now)
	if got == nil || got.ID != gated.ID {
		t.Fatalf("want premium tier discount for privileged user, got %+v", got)
	}

	// A tier discount for the other storage type never applies.
	otherTier := tier
	otherTier.StorageType = ptr("hdd")
	if got = ResolveDiscount(item, []PricingDiscount{otherTier}, false, now); got != nil {
		t.Fatalf("hdd tier discount must not apply to nvme item, got %+v", got)
	}
}

func TestDiscountedPriceCents(t *testing.T) {
	percent := PricingDiscount{Mode: DiscountModePercent, PercentOff: ptr(25)}
	if got := percent.DiscountedPriceCents(8000); got != 6000 {
		t.Fatalf("25%% of 8000: want 6000, got %d", got)
	}
	// Rounds half-up: 15% off 999 = 849.15 → 849.
	fifteen := PricingDiscount{Mode: DiscountModePercent, PercentOff: ptr(15)}
	if got := fifteen.DiscountedPriceCents(999); got != 849 {
		t.Fatalf("15%% off 999: want 849, got %d", got)
	}

	price := PricingDiscount{Mode: DiscountModePrice, PriceCents: ptr(6000)}
	if got := price.DiscountedPriceCents(8000); got != 6000 {
		t.Fatalf("reduced price: want 6000, got %d", got)
	}
	// A server/tier-wide reduced price above a cheaper item's own price is
	// clamped — never a markup.
	if got := price.DiscountedPriceCents(5000); got != 5000 {
		t.Fatalf("reduced price clamp: want 5000, got %d", got)
	}
}

func TestDiscountPercentFor(t *testing.T) {
	percent := PricingDiscount{Mode: DiscountModePercent, PercentOff: ptr(25)}
	if got := percent.DiscountPercentFor(8000); got != 25 {
		t.Fatalf("want stored 25, got %d", got)
	}
	price := PricingDiscount{Mode: DiscountModePrice, PriceCents: ptr(6000)}
	if got := price.DiscountPercentFor(8000); got != 25 {
		t.Fatalf("derived percent: want 25, got %d", got)
	}
	if got := price.DiscountPercentFor(0); got != 0 {
		t.Fatalf("zero base: want 0, got %d", got)
	}
}
