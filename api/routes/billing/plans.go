package billing

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

// Plan describes a purchasable storage add-on tier.
type Plan struct {
	ID         string
	BytesAdded int64
	// PriceCents keyed by storage_type ("nvme" | "hdd").
	PriceCents map[string]int
}

// storagePlans mirrors the PLANS constant in the mobile app's StorageUpgradeModal.
var storagePlans = []Plan{
	{ID: "64gb",  BytesAdded: 64 * 1 << 30,   PriceCents: map[string]int{"nvme": 3000,  "hdd": 2000}},
	{ID: "128gb", BytesAdded: 128 * 1 << 30,  PriceCents: map[string]int{"nvme": 5000,  "hdd": 3000}},
	{ID: "256gb", BytesAdded: 256 * 1 << 30,  PriceCents: map[string]int{"nvme": 8000,  "hdd": 5000}},
	{ID: "512gb", BytesAdded: 512 * 1 << 30,  PriceCents: map[string]int{"nvme": 15000, "hdd": 8000}},
	{ID: "1tb",   BytesAdded: 1024 * 1 << 30, PriceCents: map[string]int{"nvme": 25000, "hdd": 12000}},
}

// LookupPlan returns the Plan for the given ID, or false if not found.
func LookupPlan(id string) (Plan, bool) {
	for _, p := range storagePlans {
		if p.ID == id {
			return p, true
		}
	}
	return Plan{}, false
}

// keep unexported alias so existing handler.go code compiles unchanged
func lookupPlan(id string) (Plan, bool) { return LookupPlan(id) }

// ── Custom capacity (expansion requests only) ─────────────────────────────────

const (
	// CustomPlanID is the plan_id recorded for manually-reviewed custom
	// capacity expansion requests.
	CustomPlanID = "custom"

	tib = int64(1) << 40

	// CustomMinBytes / CustomMaxBytes bound the custom capacity slider:
	// 1 TiB up to 10 PiB. Custom amounts are only available as expansion
	// requests (manual review), never as instant purchases.
	CustomMinBytes = 1 * tib
	CustomMaxBytes = 10 * 1024 * tib
)

// ── DB-backed pricing (admin pricing page) ────────────────────────────────────

// PricingQuerier is the subset of *db.Queries needed to resolve admin-managed
// pricing items and their discounts. Shared with the expansion handler so the
// deposit flow prices UUID plan ids identically.
type PricingQuerier interface {
	GetPricingItem(ctx context.Context, id uuid.UUID) (*models.PricingItem, error)
	ListActivePricingDiscounts(ctx context.Context, serverID uuid.UUID) ([]models.PricingDiscount, error)
	GetUserByUsername(ctx context.Context, username string) (*models.User, error)
}

// Plan resolution errors — handlers map these to 400s.
var (
	ErrPlanNotFound = errors.New("unknown plan_id")
	ErrPlanMismatch = errors.New("plan does not match the requested storage type or server")
)

// ResolvePlanPrice resolves planID into a Plan and the price (cents) the
// calling user actually pays. planID is either a storage_pricing_items UUID
// (admin-managed pricing, with any applicable discount applied — the most
// specific of item/tier/server scope wins; premium-gated discounts apply only
// to premium users and admins) or a legacy slug from the hardcoded table
// ("64gb"…"1tb"), which keeps its hardcoded price so pre-pricing-page mobile
// clients charge exactly what they display. serverID may be nil (legacy
// clients); when set it must match a UUID item's server.
func ResolvePlanPrice(ctx context.Context, q PricingQuerier, planID, storageType, username string, serverID *uuid.UUID) (Plan, int, error) {
	itemID, err := uuid.Parse(planID)
	if err != nil {
		// Legacy slug.
		pl, found := LookupPlan(planID)
		if !found {
			return Plan{}, 0, ErrPlanNotFound
		}
		cents, ok := pl.PriceCents[storageType]
		if !ok {
			return Plan{}, 0, ErrPlanMismatch
		}
		return pl, cents, nil
	}

	item, err := q.GetPricingItem(ctx, itemID)
	if err != nil {
		return Plan{}, 0, err
	}
	if item == nil {
		return Plan{}, 0, ErrPlanNotFound
	}
	if item.StorageType != storageType || (serverID != nil && *serverID != item.ServerID) {
		return Plan{}, 0, ErrPlanMismatch
	}

	cents := item.PriceCents
	discounts, err := q.ListActivePricingDiscounts(ctx, item.ServerID)
	if err != nil {
		return Plan{}, 0, err
	}
	if len(discounts) > 0 {
		privileged, err := userIsPrivileged(ctx, q, username)
		if err != nil {
			return Plan{}, 0, err
		}
		if d := models.ResolveDiscount(item, discounts, privileged, time.Now()); d != nil {
			cents = d.DiscountedPriceCents(cents)
		}
	}

	return Plan{
		ID:         planID,
		BytesAdded: item.Bytes,
		PriceCents: map[string]int{storageType: cents},
	}, cents, nil
}

// userIsPrivileged reports whether username may use premium-gated discounts:
// premium users and admins (both synced onto users from the JWT by the auth
// middleware).
func userIsPrivileged(ctx context.Context, q PricingQuerier, username string) (bool, error) {
	user, err := q.GetUserByUsername(ctx, username)
	if err != nil {
		return false, err
	}
	return user != nil && (user.IsPremium || user.IsAdmin), nil
}

// customPerTiBCents extends the 1 TB plan's price linearly per TiB.
var customPerTiBCents = map[string]int64{"nvme": 25000, "hdd": 12000}

// CustomPlan builds a Plan for an arbitrary capacity between CustomMinBytes
// and CustomMaxBytes, priced pro-rata (rounded up) from the 1 TB plan.
func CustomPlan(bytes int64, storageType string) (Plan, error) {
	if bytes < CustomMinBytes || bytes > CustomMaxBytes {
		return Plan{}, fmt.Errorf("custom capacity must be between 1 TB and 10 PB")
	}
	rate, ok := customPerTiBCents[storageType]
	if !ok {
		return Plan{}, fmt.Errorf("unknown storage_type %q", storageType)
	}
	// Compute in GiB so bytes*rate cannot overflow int64 at the 10 PiB bound.
	gib := (bytes + (1 << 30) - 1) >> 30
	cents := (gib*rate + 1023) / 1024
	return Plan{
		ID:         CustomPlanID,
		BytesAdded: bytes,
		PriceCents: map[string]int{storageType: int(cents)},
	}, nil
}
