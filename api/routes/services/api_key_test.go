package services

import (
	"strings"
	"testing"

	"apollo-sfs.com/api/models"
)

func TestAuthorize_BoundaryAndOperationCoverage(t *testing.T) {
	svc := &APIKeyService{} // Authorize doesn't touch storage

	read := func(prefix string) models.APIKeyScope { return models.APIKeyScope{Operation: "read", PathPrefix: prefix} }
	write := func(prefix string) models.APIKeyScope { return models.APIKeyScope{Operation: "write", PathPrefix: prefix} }

	cases := []struct {
		name   string
		scopes []models.APIKeyScope
		op     string
		key    string
		want   bool
	}{
		{"read-photos-covers-photos-cat", []models.APIKeyScope{read("photos")}, "read", "photos/cat.jpg", true},
		{"read-photos-does-not-cover-photographer", []models.APIKeyScope{read("photos")}, "read", "photographer/cv.pdf", false},
		{"read-photos-slash-covers-photos-cat", []models.APIKeyScope{read("photos/")}, "read", "photos/cat.jpg", true},
		{"empty-prefix-covers-everything", []models.APIKeyScope{read("")}, "read", "any/path/here", true},
		{"read-does-not-grant-write", []models.APIKeyScope{read("")}, "write", "any/path", false},
		{"write-does-not-grant-read", []models.APIKeyScope{write("photos")}, "read", "photos/cat.jpg", false},
		{"list-satisfied-by-read", []models.APIKeyScope{read("photos")}, "list", "photos", true},
		{"list-not-satisfied-by-write", []models.APIKeyScope{write("photos")}, "list", "photos", false},
		{"exact-key-match", []models.APIKeyScope{read("notes")}, "read", "notes", true},
		{"case-insensitive-key", []models.APIKeyScope{read("photos")}, "read", "PHOTOS/cat.jpg", true},
		{"leading-slash-normalised", []models.APIKeyScope{read("photos")}, "read", "/photos/cat.jpg", true},
	}
	for _, tc := range cases {
		got := svc.Authorize(tc.scopes, tc.op, tc.key)
		if got != tc.want {
			t.Errorf("Authorize(%s): got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestMatchingOperations(t *testing.T) {
	svc := &APIKeyService{}
	scopes := []models.APIKeyScope{
		{Operation: "read", PathPrefix: "photos"},
		{Operation: "write", PathPrefix: "uploads"},
		{Operation: "delete", PathPrefix: ""},
	}
	got := svc.MatchingOperations(scopes, "photos/cat.jpg")
	// read because scope matches photos; delete because empty prefix covers everything.
	if !containsStr(got, "read") || !containsStr(got, "delete") {
		t.Errorf("expected read and delete, got %v", got)
	}
	if containsStr(got, "write") {
		t.Errorf("did not expect write, got %v", got)
	}
}

func TestParseRawKey(t *testing.T) {
	prefix, secret, err := parseRawKey("sfs_abc_xyz")
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if prefix != "abc" || secret != "xyz" {
		t.Fatalf("got prefix=%q secret=%q", prefix, secret)
	}
	for _, bad := range []string{"", "abc", "sfs_abc", "sfs__xyz", "sfs_abc_"} {
		if _, _, err := parseRawKey(bad); err == nil {
			t.Errorf("parseRawKey(%q) succeeded; want error", bad)
		}
	}
}

func TestHash_StableAndIncludesPepper(t *testing.T) {
	svc1 := &APIKeyService{pepper: []byte(strings.Repeat("a", 32))}
	svc2 := &APIKeyService{pepper: []byte(strings.Repeat("b", 32))}
	a := svc1.hash("secret")
	b := svc1.hash("secret")
	if a != b {
		t.Errorf("hash should be stable; got %q vs %q", a, b)
	}
	c := svc2.hash("secret")
	if c == a {
		t.Errorf("hash should differ when pepper changes")
	}
}

func containsStr(xs []string, target string) bool {
	for _, x := range xs {
		if x == target {
			return true
		}
	}
	return false
}
