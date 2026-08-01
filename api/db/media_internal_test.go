package db

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestMediaSortOrderClause(t *testing.T) {
	cases := map[MediaSort]string{
		MediaSortTakenAt:   "COALESCE(f.taken_at, f.created_at) DESC",
		MediaSortCreated:   "f.created_at DESC",
		MediaSortName:      "f.name ASC",
		MediaSortSource:    "f.source ASC",
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

func TestMediaFilterIsZero(t *testing.T) {
	if !(MediaFilter{}).IsZero() {
		t.Error("zero MediaFilter should report IsZero")
	}
	now := time.Now()
	nonZero := []MediaFilter{
		{TakenAfter: &now},
		{TakenBefore: &now},
		{UploadedAfter: &now},
		{UploadedBefore: &now},
		{Sources: []string{"web"}},
		{MediaTypes: []string{MediaTypeImage}},
		{GroupIDs: []uuid.UUID{uuid.New()}},
	}
	for i, f := range nonZero {
		if f.IsZero() {
			t.Errorf("case %d: expected IsZero() == false", i)
		}
	}
}

// The filter's placeholders must stay in lockstep with the args it appends —
// a mismatch is the classic way a dynamic WHERE clause turns into a runtime
// "bind message supplies N parameters" error (or, worse, a silent mis-bind).
func TestMediaFilterClausePlaceholdersMatchArgs(t *testing.T) {
	after := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	before := time.Date(2024, 12, 31, 0, 0, 0, 0, time.UTC)
	f := MediaFilter{
		TakenAfter:     &after,
		TakenBefore:    &before,
		UploadedAfter:  &after,
		UploadedBefore: &before,
		Sources:        []string{"web", "device"},
		MediaTypes:     []string{MediaTypeImage, MediaTypeVideo, MediaTypeOther},
		GroupIDs:       []uuid.UUID{uuid.New()},
	}

	// $1 is already taken by the collection id, mirroring the real callers.
	args := []any{uuid.New()}
	clause := f.clauses(&args)

	// 4 dates + sources array + group array = 6 new binds, numbered $2..$7.
	if len(args) != 7 {
		t.Fatalf("len(args) = %d, want 7", len(args))
	}
	for i := 2; i <= 7; i++ {
		want := "$" + strconv.Itoa(i)
		if !strings.Contains(clause, want) {
			t.Errorf("clause is missing placeholder %s: %s", want, clause)
		}
	}
	if strings.Contains(clause, "$8") {
		t.Errorf("clause references an unbound placeholder $8: %s", clause)
	}
	// Media types are literal fragments, never binds.
	for _, want := range []string{"'image/%'", "'video/%'", "NOT LIKE"} {
		if !strings.Contains(clause, want) {
			t.Errorf("clause is missing media-type fragment %s: %s", want, clause)
		}
	}
	if !strings.Contains(clause, "recognition_group_members") {
		t.Errorf("clause is missing the recognition group join: %s", clause)
	}
}

func TestMediaFilterClauseEmpty(t *testing.T) {
	args := []any{uuid.New()}
	if got := (MediaFilter{}).clauses(&args); got != "" {
		t.Errorf("empty filter produced %q, want empty string", got)
	}
	if len(args) != 1 {
		t.Errorf("empty filter appended %d args, want 0", len(args)-1)
	}
}

// Unknown media-type buckets are dropped by the route parser, but the clause
// builder must also refuse to emit anything for them rather than producing a
// dangling "AND ()".
func TestMediaFilterClauseDropsUnknownMediaTypes(t *testing.T) {
	args := []any{uuid.New()}
	if got := (MediaFilter{MediaTypes: []string{"bogus"}}).clauses(&args); got != "" {
		t.Errorf("unknown media type produced %q, want empty string", got)
	}
}
