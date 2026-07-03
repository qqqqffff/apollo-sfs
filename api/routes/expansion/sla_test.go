package expansion

import (
	"testing"
	"time"
)

func TestAddBusinessDays(t *testing.T) {
	// Wednesday 2026-07-01 12:00 UTC.
	wed := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		name string
		from time.Time
		days int
		want time.Time
	}{
		{"7bd from Wednesday skips one weekend", wed, 7,
			time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)}, // Fri next week
		{"3bd from Wednesday lands Monday", wed, 3,
			time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)},
		{"14bd from Wednesday skips two weekends", wed, 14,
			time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)}, // Tue in three weeks
		{"from Saturday counts from next Monday", time.Date(2026, 7, 4, 9, 0, 0, 0, time.UTC), 1,
			time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)},
	}
	for _, tc := range cases {
		if got := addBusinessDays(tc.from, tc.days); !got.Equal(tc.want) {
			t.Errorf("%s: addBusinessDays(%v, %d) = %v, want %v", tc.name, tc.from, tc.days, got, tc.want)
		}
	}
}

func TestApprovalDeadline(t *testing.T) {
	wed := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	std := approvalDeadline(wed, false)
	custom := approvalDeadline(wed, true)
	if !std.Equal(addBusinessDays(wed, approvalSLABusinessDays)) {
		t.Errorf("standard approval deadline = %v", std)
	}
	if !custom.Equal(addBusinessDays(wed, customReviewSLABusinessDays)) {
		t.Errorf("custom approval deadline = %v", custom)
	}
	if !custom.Before(std) {
		t.Errorf("custom review SLA should be shorter than standard")
	}
}
