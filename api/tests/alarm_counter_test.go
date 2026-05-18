package tests

import (
	"testing"
	"time"

	"apollo-sfs.com/api/routes/services"
)

// ── APICounter ────────────────────────────────────────────────────────────────

func TestAPICounter_ZeroRate_WhenEmpty(t *testing.T) {
	c := &services.APICounter{}
	if rate := c.ErrorRate(); rate != 0 {
		t.Errorf("expected 0 rate on empty counter, got %f", rate)
	}
}

func TestAPICounter_ZeroRate_NoErrors(t *testing.T) {
	c := &services.APICounter{}
	for range 10 {
		c.RecordRequest(false)
	}
	if rate := c.ErrorRate(); rate != 0 {
		t.Errorf("expected 0 error rate, got %f", rate)
	}
}

func TestAPICounter_FullErrorRate(t *testing.T) {
	c := &services.APICounter{}
	for range 5 {
		c.RecordRequest(true)
	}
	if rate := c.ErrorRate(); rate != 1.0 {
		t.Errorf("expected 1.0 error rate, got %f", rate)
	}
}

func TestAPICounter_MixedRate(t *testing.T) {
	c := &services.APICounter{}
	for range 95 {
		c.RecordRequest(false)
	}
	for range 5 {
		c.RecordRequest(true)
	}
	rate := c.ErrorRate()
	if rate < 0.049 || rate > 0.051 {
		t.Errorf("expected ~0.05 error rate, got %f", rate)
	}
}

func TestAPICounter_BelowAlarmThreshold(t *testing.T) {
	c := &services.APICounter{}
	for range 96 {
		c.RecordRequest(false)
	}
	for range 4 { // 4% — below 5% threshold
		c.RecordRequest(true)
	}
	rate := c.ErrorRate()
	if rate >= 0.05 {
		t.Errorf("expected rate below 5%%, got %f", rate)
	}
}

func TestAPICounter_AboveAlarmThreshold(t *testing.T) {
	c := &services.APICounter{}
	for range 90 {
		c.RecordRequest(false)
	}
	for range 10 { // 10% — above 5% threshold
		c.RecordRequest(true)
	}
	rate := c.ErrorRate()
	if rate < 0.05 {
		t.Errorf("expected rate at or above 5%%, got %f", rate)
	}
}

func TestAPICounter_BucketRotation(t *testing.T) {
	// Record some errors, then advance time by rotating past all 30 buckets.
	// After a full rotation the old counts should be gone.
	c := &services.APICounter{}
	for range 10 {
		c.RecordRequest(true)
	}
	if c.ErrorRate() == 0 {
		t.Fatal("expected non-zero rate before rotation")
	}

	// Rewind the internal minute marker by 31 minutes so the next
	// RecordRequest sees all old buckets as stale and clears them.
	c.AdvanceMinutes(31)
	c.RecordRequest(false) // triggers rotation; zeros out the 10 old error buckets

	if rate := c.ErrorRate(); rate != 0 {
		t.Errorf("expected 0 rate after sliding window has fully rotated, got %f", rate)
	}
}

func TestAPICounter_ConcurrentSafety(t *testing.T) {
	c := &services.APICounter{}
	done := make(chan struct{})
	for range 4 {
		go func() {
			for range 250 {
				c.RecordRequest(false)
				c.RecordRequest(true)
				_ = c.ErrorRate()
			}
			done <- struct{}{}
		}()
	}
	for range 4 {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("goroutine did not finish within 5 seconds")
		}
	}
}
