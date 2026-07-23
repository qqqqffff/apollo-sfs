package services

import (
	"context"
	"io"
	"sync"

	"golang.org/x/time/rate"
)

// minBandwidthBurstBytes is the floor applied to every user's token-bucket
// burst, regardless of how small their computed fair share is. Without a
// floor, a large number of simultaneous uploaders could shrink a user's burst
// below the size of a single Read() call made while parsing the multipart
// body, which would make rate.Limiter.WaitN error out instead of throttling.
// 256 KiB comfortably covers the buffer sizes Go's multipart/http stack uses
// internally, at the cost of allowing a brief burst above the strict fair
// share right after a low-share user's request starts.
const minBandwidthBurstBytes = 256 * 1024

// maxReserveMbps caps how much of the measured link speed is ever held back
// from uploaders, however fast the connection: on a multi-gigabit line, 15%
// would reserve an unreasonably large slice for the rest of the API.
const maxReserveMbps = 100.0

// reserveFraction is the share of the measured link speed reserved on
// slower connections, where maxReserveMbps alone would eat too much of the
// budget. The effective reserve is min(maxReserveMbps, speedMbps*reserveFraction).
const reserveFraction = 0.15

// NetworkSpeedSource supplies the most recent WAN speed measurement that is
// safe to size the upload bandwidth budget from. Implementations must only
// report a measurement taken while no uploads were active immediately before
// and after the probe — otherwise the uploads being budgeted would have
// competed with the probe itself and skewed the reading downward, causing the
// budget to under-report real capacity. ok is false when no such clean
// measurement is available yet (e.g. at startup, or if every probe since has
// overlapped an upload), in which case BandwidthManager applies no cap at all
// rather than guessing.
type NetworkSpeedSource interface {
	CleanNetworkSpeedMbps() (mbps float64, ok bool)
}

// BandwidthManager enforces a fair upload bandwidth cap derived from the
// server's actual measured WAN speed (via NetworkSpeedSource) rather than a
// manually configured number: the budget is (speed - reserve), where reserve
// is min(100 Mbps, 15% of speed), split evenly among however many users are
// currently mid-upload. A lone uploader gets the whole budget; as more users
// start uploading concurrently, everyone's individual cap shrinks so the
// total stays under budget, then rises again as they finish.
//
// Nil-safe by convention (see BandwidthManager.acquire callers): a nil
// *BandwidthManager means bandwidth throttling is not wired up at all (e.g.
// in tests), and upload handlers skip wrapping the request body entirely.
// A non-nil manager with no speed source configured yet, or no clean sample
// available, applies no cap either — see NetworkSpeedSource.
type BandwidthManager struct {
	mu          sync.Mutex
	speedSource NetworkSpeedSource
	users       map[string]*bandwidthUser
}

type bandwidthUser struct {
	refCount int
	limiter  *rate.Limiter
}

// NewBandwidthManager builds a manager with no speed source yet — call
// SetSpeedSource once one is available (main.go wires this after
// constructing the admin handler, which implements NetworkSpeedSource via
// its WAN speed test). Until then, and whenever the source reports no clean
// sample, every acquired limiter is unlimited.
func NewBandwidthManager() *BandwidthManager {
	return &BandwidthManager{users: make(map[string]*bandwidthUser)}
}

// SetSpeedSource installs (or replaces) the WAN speed measurement source.
// Safe to call concurrently with Acquire/release.
func (m *BandwidthManager) SetSpeedSource(src NetworkSpeedSource) {
	m.mu.Lock()
	m.speedSource = src
	m.rebalanceLocked()
	m.mu.Unlock()
}

// Acquire marks userID as actively uploading and returns the rate limiter it
// should be throttled with plus a release func. The caller must invoke
// release exactly once, after it is done reading upload bytes for this
// request (e.g. via defer, right after calling Acquire). Every other active
// user's limit is recomputed on both Acquire and release so the budget always
// stays split fairly across whoever is active at that moment.
func (m *BandwidthManager) Acquire(userID string) (*rate.Limiter, func()) {
	m.mu.Lock()
	u, ok := m.users[userID]
	if !ok {
		u = &bandwidthUser{limiter: rate.NewLimiter(rate.Inf, minBandwidthBurstBytes)}
		m.users[userID] = u
	}
	u.refCount++
	m.rebalanceLocked()
	m.mu.Unlock()

	var once sync.Once
	release := func() {
		once.Do(func() {
			m.mu.Lock()
			u.refCount--
			if u.refCount <= 0 {
				delete(m.users, userID)
			}
			m.rebalanceLocked()
			m.mu.Unlock()
		})
	}
	return u.limiter, release
}

// rebalanceLocked recomputes and applies every active user's fair-share rate
// from the current speed source reading. Callers must hold m.mu.
func (m *BandwidthManager) rebalanceLocked() {
	if len(m.users) == 0 {
		return
	}

	budgetBytesPerSec, ok := m.budgetBytesPerSecLocked()
	if !ok {
		for _, u := range m.users {
			u.limiter.SetLimit(rate.Inf)
		}
		return
	}

	share := budgetBytesPerSec / int64(len(m.users))
	if share < 1 {
		share = 1
	}
	burst := share
	if burst < minBandwidthBurstBytes {
		burst = minBandwidthBurstBytes
	}
	for _, u := range m.users {
		u.limiter.SetBurst(int(burst))
		u.limiter.SetLimit(rate.Limit(share))
	}
}

// budgetBytesPerSecLocked converts the speed source's latest clean reading
// into a total budget (already net of reserve) to split among active users.
// ok is false when there's no speed source or no clean sample yet, meaning
// callers should apply no cap. Callers must hold m.mu.
func (m *BandwidthManager) budgetBytesPerSecLocked() (int64, bool) {
	if m.speedSource == nil {
		return 0, false
	}
	speedMbps, ok := m.speedSource.CleanNetworkSpeedMbps()
	if !ok || speedMbps <= 0 {
		return 0, false
	}

	reserveMbps := speedMbps * reserveFraction
	if reserveMbps > maxReserveMbps {
		reserveMbps = maxReserveMbps
	}
	// netMbps is always positive here: reserveMbps <= speedMbps*reserveFraction
	// < speedMbps whenever speedMbps > 0 (already checked above).
	netMbps := speedMbps - reserveMbps
	bytesPerSec := int64(netMbps * 1_000_000 / 8)
	if bytesPerSec < 1 {
		bytesPerSec = 1
	}
	return bytesPerSec, true
}

// ActiveUsers reports how many distinct users currently have at least one
// upload request in flight. Used both for observability and — critically —
// by the speed test (routes/admin) to know whether a probe overlapped real
// upload traffic and so must not be trusted as a "clean" sample.
func (m *BandwidthManager) ActiveUsers() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.users)
}

// throttledBody wraps an http.Request.Body so every Read() is paced by a
// per-user rate.Limiter, applying backpressure to the actual TCP connection
// (the client's kernel slows down once our read rate drops, via normal TCP
// flow control) rather than buffering bytes at full speed and throttling
// something downstream after the fact.
type throttledBody struct {
	io.ReadCloser
	ctx     context.Context
	limiter *rate.Limiter
}

// NewThrottledBody wraps body so reads are paced by limiter. ctx should be
// the request's context, so an aborted/cancelled request unblocks any pending
// wait instead of leaking a goroutine until the limiter would otherwise allow
// it to proceed.
func NewThrottledBody(body io.ReadCloser, ctx context.Context, limiter *rate.Limiter) io.ReadCloser {
	return &throttledBody{ReadCloser: body, ctx: ctx, limiter: limiter}
}

func (t *throttledBody) Read(p []byte) (int, error) {
	n, err := t.ReadCloser.Read(p)
	for remaining := n; remaining > 0; {
		// Re-read Burst() on every iteration: a concurrent rebalance (another
		// user starting/finishing an upload) can shrink it mid-loop. When the
		// limit is Inf (no cap in force — the common "no clean speed sample
		// yet" case), WaitN always returns immediately regardless of n vs
		// burst, so the loop still runs but never actually blocks.
		burst := t.limiter.Burst()
		if burst < 1 {
			burst = 1
		}
		chunk := remaining
		if chunk > burst {
			chunk = burst
		}
		if werr := t.limiter.WaitN(t.ctx, chunk); werr != nil {
			return n, werr
		}
		remaining -= chunk
	}
	return n, err
}
