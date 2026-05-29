package services

import (
	"testing"
	"time"
)

func TestHumanizeDuration(t *testing.T) {
	cases := []struct {
		d    time.Duration
		want string
	}{
		{1 * time.Hour, "1 hour"},
		{2 * time.Hour, "2 hours"},
		{23 * time.Hour, "23 hours"},
		{24 * time.Hour, "1 day"},
		{48 * time.Hour, "2 days"},
		{72 * time.Hour, "3 days"},
		{168 * time.Hour, "7 days"},
	}
	for _, tc := range cases {
		got := humanizeDuration(tc.d)
		if got != tc.want {
			t.Errorf("humanizeDuration(%v) = %q, want %q", tc.d, got, tc.want)
		}
	}
}
