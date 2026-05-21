package db

import (
	"strings"
	"testing"
)

func TestMediaSortOrderClause(t *testing.T) {
	cases := map[MediaSort]string{
		MediaSortTakenAt: "COALESCE(f.taken_at, f.created_at) DESC",
		MediaSortCreated: "f.created_at DESC",
		MediaSortName:    "f.name ASC",
		MediaSort("bogus"): "COALESCE(f.taken_at, f.created_at) DESC", // unknown falls back to taken_at
	}
	for sort, want := range cases {
		if got := sort.orderClause(); !strings.Contains(got, want) {
			t.Errorf("orderClause(%q) = %q, want it to contain %q", sort, got, want)
		}
	}
}

func TestHiddenFilterClause(t *testing.T) {
	if got := HiddenExclude.hiddenClause(); got != "AND f.hidden = FALSE" {
		t.Errorf("HiddenExclude = %q", got)
	}
	if got := HiddenInclude.hiddenClause(); got != "" {
		t.Errorf("HiddenInclude = %q, want empty", got)
	}
	if got := HiddenOnly.hiddenClause(); got != "AND f.hidden = TRUE" {
		t.Errorf("HiddenOnly = %q", got)
	}
}
