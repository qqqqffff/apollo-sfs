package billing

import "fmt"

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
