package storage

import (
	"sync"
	"time"
)

type speedBucket struct {
	count   int
	resetAt time.Time
}

// speedRateLimiter enforces a per-user per-minute call limit on speed-test
// endpoints. A single counter is shared across download and upload calls so
// the combined total stays within the configured limit.
type speedRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*speedBucket
	limit   int
}

func newSpeedRateLimiter(limit int) *speedRateLimiter {
	return &speedRateLimiter{
		buckets: make(map[string]*speedBucket),
		limit:   limit,
	}
}

// Allow returns true and increments the counter if the user is under the
// per-minute limit. Returns false without incrementing when the limit is
// already reached.
func (rl *speedRateLimiter) Allow(username string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	b := rl.buckets[username]
	if b == nil || now.After(b.resetAt) {
		rl.buckets[username] = &speedBucket{count: 1, resetAt: now.Add(time.Minute)}
		return true
	}
	if b.count >= rl.limit {
		return false
	}
	b.count++
	return true
}
