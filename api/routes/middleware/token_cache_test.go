package middleware

import (
	"testing"
	"time"
)

func TestAccessTokenCache(t *testing.T) {
	c := newAccessTokenCache()

	// miss on empty/unknown keys
	if got := c.get(""); got != "" {
		t.Fatalf("empty refresh token should miss, got %q", got)
	}
	if got := c.get("unknown"); got != "" {
		t.Fatalf("unknown refresh token should miss, got %q", got)
	}

	// hit while valid
	c.set("r1", "a1", time.Now().Add(5*time.Minute))
	if got := c.get("r1"); got != "a1" {
		t.Fatalf("expected cached access token a1, got %q", got)
	}

	// within earlyExpiry of expiry → treated as expired (miss)
	c.set("r2", "a2", time.Now().Add(earlyExpiry/2))
	if got := c.get("r2"); got != "" {
		t.Fatalf("token within earlyExpiry window should miss, got %q", got)
	}

	// already expired → miss
	c.set("r3", "a3", time.Now().Add(-time.Second))
	if got := c.get("r3"); got != "" {
		t.Fatalf("expired token should miss, got %q", got)
	}

	// empty values are not stored
	c.set("r4", "", time.Now().Add(time.Minute))
	if got := c.get("r4"); got != "" {
		t.Fatalf("empty access token should not be cached, got %q", got)
	}
}

func TestAccessTokenCacheEviction(t *testing.T) {
	c := newAccessTokenCache()
	// fill past the sweep threshold with already-expired entries
	for i := 0; i < cacheSweepThreshold+10; i++ {
		c.set(string(rune(i))+"-old", "a", time.Now().Add(-time.Minute))
	}
	// a fresh write triggers the opportunistic sweep of expired entries
	c.set("fresh", "afresh", time.Now().Add(5*time.Minute))
	if got := c.get("fresh"); got != "afresh" {
		t.Fatalf("expected fresh entry to survive, got %q", got)
	}
	c.mu.RLock()
	size := len(c.m)
	c.mu.RUnlock()
	if size > cacheSweepThreshold {
		t.Fatalf("expired entries should have been swept; map size=%d", size)
	}
}
