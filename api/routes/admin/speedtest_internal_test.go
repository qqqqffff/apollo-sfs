package admin

import (
	"testing"

	"apollo-sfs.com/api/routes/services"
)

// A genuinely clean, successful probe (dirtiness 0) is always promoted
// immediately, regardless of any accumulated unclean streak.
func TestRecordSpeedTestSample_CleanProbe_PromotedImmediately(t *testing.T) {
	state := cleanSampleState{consecutiveUnclean: 5} // mid-streak from prior unclean probes
	result := &SpeedTestResult{UploadMbps: 200, DownloadMbps: 300}

	newState, promote := recordSpeedTestSample(state, result, 0)

	if promote != result {
		t.Fatalf("expected the clean result to be promoted as-is, got %+v", promote)
	}
	if promote.FallbackReason != "" {
		t.Errorf("a genuinely clean promotion should carry no FallbackReason, got %q", promote.FallbackReason)
	}
	if newState != (cleanSampleState{}) {
		t.Errorf("expected the streak to reset on a clean promotion, got %+v", newState)
	}
}

// A dirty-but-successful probe below the hard cap is tracked as a fallback
// candidate but does not get promoted yet.
func TestRecordSpeedTestSample_UncleanBelowCap_NotPromotedYet(t *testing.T) {
	result := &SpeedTestResult{UploadMbps: 50, DownloadMbps: 60}

	newState, promote := recordSpeedTestSample(cleanSampleState{}, result, 3)

	if promote != nil {
		t.Fatalf("expected no promotion below the hard cap, got %+v", promote)
	}
	if newState.consecutiveUnclean != 1 {
		t.Errorf("expected the streak to advance to 1, got %d", newState.consecutiveUnclean)
	}
	if newState.leastDirty != result || newState.leastDirtyCount != 3 {
		t.Errorf("expected this result to become the least-dirty candidate, got %+v (count %d)", newState.leastDirty, newState.leastDirtyCount)
	}
}

// Among several unclean candidates, only the least-dirty one is kept.
func TestRecordSpeedTestSample_TracksLeastDirtyCandidate(t *testing.T) {
	state := cleanSampleState{}
	worse := &SpeedTestResult{UploadMbps: 10}
	better := &SpeedTestResult{UploadMbps: 20}
	worseAgain := &SpeedTestResult{UploadMbps: 5}

	state, _ = recordSpeedTestSample(state, worse, 5)
	state, _ = recordSpeedTestSample(state, better, 2)     // less dirty — should replace
	state, _ = recordSpeedTestSample(state, worseAgain, 8) // dirtier — should NOT replace

	if state.leastDirty != better || state.leastDirtyCount != 2 {
		t.Errorf("expected the least-dirty candidate to be %+v (count 2), got %+v (count %d)", better, state.leastDirty, state.leastDirtyCount)
	}
}

// A run that errors doesn't become a fallback candidate (no usable Mbps
// data), but still advances the streak toward the hard cap.
func TestRecordSpeedTestSample_ErroredProbe_NoCandidateButStreakAdvances(t *testing.T) {
	failed := &SpeedTestResult{Error: "timeout"}

	newState, promote := recordSpeedTestSample(cleanSampleState{}, failed, 0)

	if promote != nil {
		t.Fatalf("an errored probe must never be promoted, got %+v", promote)
	}
	if newState.consecutiveUnclean != 1 {
		t.Errorf("expected the streak to advance even on error, got %d", newState.consecutiveUnclean)
	}
	if newState.leastDirty != nil {
		t.Errorf("an errored probe must not become a fallback candidate, got %+v", newState.leastDirty)
	}
}

// Hitting the hard cap with a least-dirty candidate available promotes that
// candidate (tier 1 fallback), annotated with why.
func TestRecordSpeedTestSample_HardCap_PromotesLeastDirtyCandidate(t *testing.T) {
	candidate := &SpeedTestResult{UploadMbps: 40, DownloadMbps: 45}
	state := cleanSampleState{
		consecutiveUnclean: maxConsecutiveUncleanSpeedTests - 1,
		leastDirty:         candidate,
		leastDirtyCount:    2,
	}
	final := &SpeedTestResult{UploadMbps: 40, DownloadMbps: 45} // this run's own (unclean) result

	newState, promote := recordSpeedTestSample(state, final, 4)

	if promote == nil {
		t.Fatal("expected a promotion once the hard cap is reached")
	}
	if promote.UploadMbps != candidate.UploadMbps || promote.DownloadMbps != candidate.DownloadMbps {
		t.Errorf("expected the least-dirty candidate's readings to be promoted, got %+v", promote)
	}
	if promote.FallbackReason == "" {
		t.Error("expected a non-empty FallbackReason explaining the tier-1 fallback")
	}
	if promote == candidate {
		t.Error("expected a copy to be promoted, not the original candidate pointer (avoid mutating shared state)")
	}
	if newState != (cleanSampleState{}) {
		t.Errorf("expected the streak to reset after a hard-cap promotion, got %+v", newState)
	}
}

// Hitting the hard cap with NO successful probe anywhere in the streak
// (every attempt errored) falls back to the flat assumed budget (tier 2).
func TestRecordSpeedTestSample_HardCap_NoCandidate_FallsBackToFlatBudget(t *testing.T) {
	state := cleanSampleState{consecutiveUnclean: maxConsecutiveUncleanSpeedTests - 1}
	failed := &SpeedTestResult{Error: "timeout"}

	newState, promote := recordSpeedTestSample(state, failed, 0)

	if promote == nil {
		t.Fatal("expected a promotion once the hard cap is reached")
	}
	if promote.UploadMbps != fallbackBudgetMbps || promote.DownloadMbps != fallbackBudgetMbps {
		t.Errorf("expected the flat %v Mbps fallback, got %+v", fallbackBudgetMbps, promote)
	}
	if promote.FallbackReason == "" {
		t.Error("expected a non-empty FallbackReason explaining the tier-2 fallback")
	}
	if newState != (cleanSampleState{}) {
		t.Errorf("expected the streak to reset after a hard-cap promotion, got %+v", newState)
	}
}

func TestHandler_ActiveUploadCount(t *testing.T) {
	t.Run("nil bandwidth manager (unwired, e.g. tests) reports 0", func(t *testing.T) {
		h := &Handler{}
		if got := h.activeUploadCount(); got != 0 {
			t.Errorf("expected 0 with no bandwidth manager wired up, got %d", got)
		}
	})

	t.Run("reflects the bandwidth manager's active user count", func(t *testing.T) {
		mgr := services.NewBandwidthManager()
		h := &Handler{bandwidthMgr: mgr}
		if got := h.activeUploadCount(); got != 0 {
			t.Fatalf("expected 0 before any upload acquires the manager, got %d", got)
		}
		_, release := mgr.Acquire("alice")
		if got := h.activeUploadCount(); got != 1 {
			t.Errorf("expected 1 while alice's upload is in flight, got %d", got)
		}
		release()
		if got := h.activeUploadCount(); got != 0 {
			t.Errorf("expected 0 again after alice's upload releases, got %d", got)
		}
	})
}

func TestHandler_CleanNetworkSpeedMbps(t *testing.T) {
	t.Run("no clean sample yet", func(t *testing.T) {
		h := &Handler{}
		if _, ok := h.CleanNetworkSpeedMbps(); ok {
			t.Error("expected ok=false with no clean sample recorded")
		}
	})

	t.Run("a dirty (upload-overlapping) sample in latestSpeedTest is ignored", func(t *testing.T) {
		h := &Handler{latestSpeedTest: &SpeedTestResult{UploadMbps: 900, DownloadMbps: 900}}
		if _, ok := h.CleanNetworkSpeedMbps(); ok {
			t.Error("expected ok=false: only latestCleanSpeedTest should ever be consulted, not latestSpeedTest")
		}
	})

	t.Run("reports the larger of upload/download from the clean sample", func(t *testing.T) {
		h := &Handler{latestCleanSpeedTest: &SpeedTestResult{UploadMbps: 120, DownloadMbps: 340}}
		mbps, ok := h.CleanNetworkSpeedMbps()
		if !ok || mbps != 340 {
			t.Errorf("got (%v, %v), want (340, true)", mbps, ok)
		}
	})

	t.Run("a failed clean-window probe is still excluded", func(t *testing.T) {
		h := &Handler{latestCleanSpeedTest: &SpeedTestResult{Error: "timeout"}}
		if _, ok := h.CleanNetworkSpeedMbps(); ok {
			t.Error("expected ok=false for an errored result")
		}
	})

	t.Run("a hard-cap fallback promotion is still readable (has real Mbps values)", func(t *testing.T) {
		h := &Handler{latestCleanSpeedTest: &SpeedTestResult{
			UploadMbps: fallbackBudgetMbps, DownloadMbps: fallbackBudgetMbps,
			FallbackReason: "no successful speed test in 48 attempts — assuming a flat 900 Mbps budget",
		}}
		mbps, ok := h.CleanNetworkSpeedMbps()
		if !ok || mbps != fallbackBudgetMbps {
			t.Errorf("got (%v, %v), want (%v, true)", mbps, ok, fallbackBudgetMbps)
		}
	})
}
