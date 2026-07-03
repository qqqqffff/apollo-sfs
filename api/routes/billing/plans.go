package billing

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
	{ID: "256gb", BytesAdded: 256 * 1 << 30,  PriceCents: map[string]int{"nvme": 10000, "hdd": 5000}},
	{ID: "512gb", BytesAdded: 512 * 1 << 30,  PriceCents: map[string]int{"nvme": 20000, "hdd": 8000}},
	{ID: "1tb",   BytesAdded: 1024 * 1 << 30, PriceCents: map[string]int{"nvme": 40000, "hdd": 12000}},
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
