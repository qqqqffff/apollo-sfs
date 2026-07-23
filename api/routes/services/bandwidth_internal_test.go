package services

import (
	"bytes"
	"context"
	"io"
	"sync"
	"testing"
	"time"

	"golang.org/x/time/rate"
)

type fixedSpeedSource struct {
	mbps float64
	ok   bool
}

func (f fixedSpeedSource) CleanNetworkSpeedMbps() (float64, bool) { return f.mbps, f.ok }

// No speed source configured at all — the common state right after startup,
// before SetSpeedSource has ever been called — must not throttle anything.
func TestBandwidthManager_NoSpeedSource_Unlimited(t *testing.T) {
	m := NewBandwidthManager()
	limiter, release := m.Acquire("alice")
	defer release()

	if got := limiter.Limit(); got != rate.Inf {
		t.Errorf("expected unlimited rate with no speed source, got %v", got)
	}
}

// A speed source with no clean sample yet (ok=false) must also not throttle —
// failing open, not closed, since this is a "no data" state, not a deliberate cap.
func TestBandwidthManager_NoCleanSample_Unlimited(t *testing.T) {
	m := NewBandwidthManager()
	m.SetSpeedSource(fixedSpeedSource{mbps: 0, ok: false})
	limiter, release := m.Acquire("alice")
	defer release()

	if got := limiter.Limit(); got != rate.Inf {
		t.Errorf("expected unlimited rate when no clean sample is available, got %v", got)
	}
}

// Reserve formula: min(100 Mbps, 15% of speed). On a fast (800 Mbps) link,
// the 100 Mbps flat cap should govern over the 15% (120 Mbps) figure.
func TestBandwidthManager_ReserveCapsAt100Mbps_OnFastLink(t *testing.T) {
	m := NewBandwidthManager()
	m.SetSpeedSource(fixedSpeedSource{mbps: 800, ok: true}) // 15% = 120 > 100
	limiter, release := m.Acquire("alice")
	defer release()

	// (800 - 100) Mbps net = 700 Mbps = 87,500,000 bytes/sec.
	const want = 87_500_000
	if got := limiter.Limit(); got != rate.Limit(want) {
		t.Errorf("got limit %v, want %v (reserve should cap at 100 Mbps, not 15%% of 800)", got, want)
	}
}

// On a slower (100 Mbps) link, 15% (15 Mbps) is below the 100 Mbps flat cap,
// so the percentage should govern instead.
func TestBandwidthManager_ReserveUsesPercentage_OnSlowerLink(t *testing.T) {
	m := NewBandwidthManager()
	m.SetSpeedSource(fixedSpeedSource{mbps: 100, ok: true}) // 15% = 15 < 100
	limiter, release := m.Acquire("alice")
	defer release()

	// (100 - 15) Mbps net = 85 Mbps = 10,625,000 bytes/sec.
	const want = 10_625_000
	if got := limiter.Limit(); got != rate.Limit(want) {
		t.Errorf("got limit %v, want %v (reserve should be 15%% of 100 Mbps, not the 100 Mbps flat cap)", got, want)
	}
}

// A lone uploader should get the entire net budget, not a pre-divided slice.
func TestBandwidthManager_SoleUser_GetsFullBudget(t *testing.T) {
	m := NewBandwidthManager()
	m.SetSpeedSource(fixedSpeedSource{mbps: 800, ok: true})
	limiter, release := m.Acquire("alice")
	defer release()

	const want = 87_500_000
	if got := limiter.Limit(); got != rate.Limit(want) {
		t.Errorf("sole active user should get the full net budget: got limit %v, want %v", got, want)
	}
}

// Two concurrently active users should each be capped at half the budget —
// the whole point of the "equitable" allocation requested.
func TestBandwidthManager_TwoUsers_SplitEvenly(t *testing.T) {
	m := NewBandwidthManager()
	m.SetSpeedSource(fixedSpeedSource{mbps: 800, ok: true}) // net budget 87,500,000 B/s
	limiterA, releaseA := m.Acquire("alice")
	defer releaseA()

	// limiterA is a live pointer into the manager's per-user state: SetLimit
	// mutates it in place, so bob joining should be reflected without a
	// second Acquire call for alice.
	_, releaseB := m.Acquire("bob")
	defer releaseB()

	const want = 87_500_000 / 2
	if got := limiterA.Limit(); got != rate.Limit(want) {
		t.Errorf("two active users should split the budget evenly: got limit %v, want %v", got, want)
	}
}

// When one user's uploads finish, the remaining active user should reclaim
// the full budget — shares must be recomputed on release, not just Acquire.
func TestBandwidthManager_ReleaseRebalances(t *testing.T) {
	m := NewBandwidthManager()
	m.SetSpeedSource(fixedSpeedSource{mbps: 800, ok: true})
	limiterA, releaseA := m.Acquire("alice")
	_, releaseB := m.Acquire("bob")

	const half = 87_500_000 / 2
	if got := limiterA.Limit(); got != rate.Limit(half) {
		t.Fatalf("expected %v while both active, got %v", rate.Limit(half), got)
	}

	releaseB()

	const full = 87_500_000
	if got := limiterA.Limit(); got != rate.Limit(full) {
		t.Errorf("alice should reclaim the full budget after bob releases: got limit %v, want %v", got, rate.Limit(full))
	}
	releaseA()
}

// A user issuing several concurrent requests (e.g. parallel chunk uploads)
// must not be double-counted as multiple distinct users in the fair split.
func TestBandwidthManager_SameUserMultipleAcquires_CountsOnce(t *testing.T) {
	m := NewBandwidthManager()
	_, release1 := m.Acquire("alice")
	_, release2 := m.Acquire("alice")
	_, releaseOther := m.Acquire("bob")

	if got := m.ActiveUsers(); got != 2 {
		t.Fatalf("expected 2 distinct active users (alice counted once), got %d", got)
	}

	release1()
	if got := m.ActiveUsers(); got != 2 {
		t.Errorf("alice has a second in-flight request; releasing one of two should not drop her from the active set, got %d active users", got)
	}
	release2()
	if got := m.ActiveUsers(); got != 1 {
		t.Errorf("alice's last in-flight request released; expected 1 active user, got %d", got)
	}
	releaseOther()
}

// release must be idempotent (defer + an explicit early-return path could
// both invoke it) — a double release must not double-decrement the refcount.
func TestBandwidthManager_ReleaseIsIdempotent(t *testing.T) {
	m := NewBandwidthManager()
	_, release := m.Acquire("alice")
	_, releaseOther := m.Acquire("bob")
	release()
	release() // second call must be a no-op

	if got := m.ActiveUsers(); got != 1 {
		t.Errorf("double release should not affect the active set beyond the first call, got %d active users, want 1", got)
	}
	releaseOther()
}

// SetSpeedSource must immediately rebalance already-active users, not just
// apply to future Acquire calls — e.g. the periodic speed test landing a
// fresh clean sample mid-upload should tighten/loosen the cap right away.
func TestBandwidthManager_SetSpeedSource_RebalancesActiveUsers(t *testing.T) {
	m := NewBandwidthManager()
	limiter, release := m.Acquire("alice")
	defer release()

	if got := limiter.Limit(); got != rate.Inf {
		t.Fatalf("expected unlimited before any speed source is set, got %v", got)
	}

	m.SetSpeedSource(fixedSpeedSource{mbps: 800, ok: true})

	const want = 87_500_000
	if got := limiter.Limit(); got != rate.Limit(want) {
		t.Errorf("expected the already-active user to be rebalanced once a speed source lands, got %v, want %v", got, want)
	}
}

func TestBandwidthManager_ZeroOrNegativeSpeed_TreatedAsNoData(t *testing.T) {
	for _, mbps := range []float64{0, -5} {
		m := NewBandwidthManager()
		m.SetSpeedSource(fixedSpeedSource{mbps: mbps, ok: true})
		limiter, release := m.Acquire("alice")
		if got := limiter.Limit(); got != rate.Inf {
			t.Errorf("mbps=%v: expected unlimited rate for a non-positive speed reading, got %v", mbps, got)
		}
		release()
	}
}

// End-to-end: a throttled body reader actually paces reads according to the
// active limiter, rather than just adjusting a number nothing consults.
func TestThrottledBody_PacesReads(t *testing.T) {
	// A fast enough link that the net budget (after the 100 Mbps reserve
	// cap) comfortably exceeds minBandwidthBurstBytes, so the limiter's
	// burst equals the budget itself rather than being clamped up by the
	// floor — otherwise the whole payload could drain from the pre-filled
	// bucket without ever blocking. The exact byte figure is read back from
	// the limiter rather than hand-computed, since only "well above the
	// burst floor" matters here, not a specific number.
	m := NewBandwidthManager()
	m.SetSpeedSource(fixedSpeedSource{mbps: 5000, ok: true})
	limiter, release := m.Acquire("alice")
	defer release()

	budgetBytesPerSec := int64(limiter.Limit())
	if budgetBytesPerSec <= minBandwidthBurstBytes {
		t.Fatalf("test setup: budget %d must exceed the burst floor %d for this test to be meaningful", budgetBytesPerSec, minBandwidthBurstBytes)
	}

	// First budgetBytesPerSec bytes drain the initial full bucket instantly;
	// the extra half-second's worth must be earned at the configured rate.
	extra := budgetBytesPerSec / 2
	payload := bytes.Repeat([]byte("x"), int(budgetBytesPerSec+extra))
	body := NewThrottledBody(io.NopCloser(bytes.NewReader(payload)), context.Background(), limiter)

	start := time.Now()
	n, err := io.Copy(io.Discard, body)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != int64(len(payload)) {
		t.Fatalf("copied %d bytes, want %d", n, len(payload))
	}
	// Expect ~0.5s of forced waiting; allow generous slack for CI jitter
	// while still catching "throttling does nothing" (near-instant) and
	// "throttling is wildly miscalibrated" (many seconds).
	if elapsed < 300*time.Millisecond {
		t.Errorf("expected throttling to force ~0.5s of waiting, took only %v", elapsed)
	}
	if elapsed > 3*time.Second {
		t.Errorf("throttling took implausibly long: %v", elapsed)
	}
}

// Cancelling the request context must unblock a pending wait instead of
// hanging until the limiter would otherwise allow the read to proceed.
func TestThrottledBody_ContextCancellationUnblocks(t *testing.T) {
	m := NewBandwidthManager()
	m.SetSpeedSource(fixedSpeedSource{mbps: 0.001, ok: true}) // tiny budget — anything beyond the burst floor blocks for a long time
	limiter, release := m.Acquire("alice")
	defer release()

	ctx, cancel := context.WithCancel(context.Background())
	payload := bytes.Repeat([]byte("x"), minBandwidthBurstBytes*4)
	body := NewThrottledBody(io.NopCloser(bytes.NewReader(payload)), ctx, limiter)

	done := make(chan error, 1)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, err := io.Copy(io.Discard, body)
		done <- err
	}()

	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Errorf("expected an error from the cancelled context, got nil")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("throttled read did not unblock after context cancellation")
	}
	wg.Wait()
}
