package services

import (
	"testing"
	"time"
)

// The self-billed renewal policy is the part of the premium billing stack with
// no PayPal safety net behind it: nothing else decides when a card/wallet
// subscription is charged, retried, or given up on. These cover the decisions
// that policy makes, independent of the DB and PayPal round-trips around them.

func TestPlanPeriodEnd(t *testing.T) {
	from := time.Date(2026, time.January, 31, 12, 0, 0, 0, time.UTC)

	if got, want := PlanPeriodEnd("monthly", from), from.AddDate(0, 1, 0); !got.Equal(want) {
		t.Errorf("monthly: got %v, want %v", got, want)
	}
	if got, want := PlanPeriodEnd("annual", from), from.AddDate(1, 0, 0); !got.Equal(want) {
		t.Errorf("annual: got %v, want %v", got, want)
	}
	// Anything that isn't the annual plan bills monthly rather than silently
	// granting a free period.
	if got, want := PlanPeriodEnd("", from), from.AddDate(0, 1, 0); !got.Equal(want) {
		t.Errorf("unknown plan: got %v, want %v", got, want)
	}
}

func TestNextRenewalAttempt_BacksOffThenGivesUp(t *testing.T) {
	tests := []struct {
		failedCount int
		wantDelay   time.Duration
		wantGiveUp  bool
	}{
		{1, 24 * time.Hour, false},
		{2, 72 * time.Hour, false},
		{3, 120 * time.Hour, false},
		// selfBilledMaxAttempts is 4 — the fourth failure ends it.
		{4, 0, true},
		{9, 0, true},
	}
	for _, tt := range tests {
		delay, giveUp := nextRenewalAttempt(tt.failedCount)
		if giveUp != tt.wantGiveUp {
			t.Errorf("failedCount=%d: giveUp=%v, want %v", tt.failedCount, giveUp, tt.wantGiveUp)
		}
		if delay != tt.wantDelay {
			t.Errorf("failedCount=%d: delay=%v, want %v", tt.failedCount, delay, tt.wantDelay)
		}
	}
}

// A retried renewal must extend the period the shopper already paid through,
// not the moment the retry happened — otherwise every declined charge would
// walk the billing date forward and a subscription would drift off its
// anniversary.
func TestRenewalPeriodStart_DoesNotDriftOnLateRetry(t *testing.T) {
	periodEnd := time.Date(2026, time.March, 1, 0, 0, 0, 0, time.UTC)
	// Charge succeeded on the third retry, four days after the period ended.
	now := periodEnd.AddDate(0, 0, 4)

	got := renewalPeriodStart("monthly", &periodEnd, now)
	if !got.Equal(periodEnd) {
		t.Fatalf("got %v, want the old period end %v", got, periodEnd)
	}
	if next := PlanPeriodEnd("monthly", got); !next.Equal(periodEnd.AddDate(0, 1, 0)) {
		t.Errorf("next period end %v drifted off the %v anniversary", next, periodEnd)
	}
}

// A subscription resurrected long after its period lapsed shouldn't be handed
// a period that has already elapsed.
func TestRenewalPeriodStart_LongLapseBillsFromNow(t *testing.T) {
	periodEnd := time.Date(2026, time.March, 1, 0, 0, 0, 0, time.UTC)
	now := periodEnd.AddDate(0, 3, 0) // three months later

	got := renewalPeriodStart("monthly", &periodEnd, now)
	if !got.Equal(now) {
		t.Fatalf("got %v, want now (%v)", got, now)
	}
	if next := PlanPeriodEnd("monthly", got); !next.After(now) {
		t.Errorf("next period end %v is not in the future", next)
	}
}

func TestRenewalPeriodStart_NilPeriodEndBillsFromNow(t *testing.T) {
	now := time.Date(2026, time.March, 1, 0, 0, 0, 0, time.UTC)
	if got := renewalPeriodStart("annual", nil, now); !got.Equal(now) {
		t.Fatalf("got %v, want now (%v)", got, now)
	}
}
