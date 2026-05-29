package sfs

import (
	"testing"
)

func TestParseObjectKey_Valid(t *testing.T) {
	cases := []struct {
		raw         string
		wantLeaf    string
		wantSegLen  int
		wantExt     string
		wantFull    string
	}{
		{"cat.jpg", "cat.jpg", 0, "jpg", "cat.jpg"},
		{"photos/2024/cat.jpg", "cat.jpg", 2, "jpg", "photos/2024/cat.jpg"},
		{"notes", "notes", 0, "", "notes"},
		{"a/b/c/d.tar.gz", "d.tar.gz", 3, "gz", "a/b/c/d.tar.gz"},
	}
	for _, tc := range cases {
		got, err := ParseObjectKey(tc.raw)
		if err != nil {
			t.Fatalf("ParseObjectKey(%q): unexpected error %v", tc.raw, err)
		}
		if got.Leaf != tc.wantLeaf {
			t.Errorf("ParseObjectKey(%q).Leaf = %q; want %q", tc.raw, got.Leaf, tc.wantLeaf)
		}
		if len(got.Segments) != tc.wantSegLen {
			t.Errorf("ParseObjectKey(%q).Segments len = %d; want %d", tc.raw, len(got.Segments), tc.wantSegLen)
		}
		if got.Extension != tc.wantExt {
			t.Errorf("ParseObjectKey(%q).Extension = %q; want %q", tc.raw, got.Extension, tc.wantExt)
		}
		if got.FullPath != tc.wantFull {
			t.Errorf("ParseObjectKey(%q).FullPath = %q; want %q", tc.raw, got.FullPath, tc.wantFull)
		}
	}
}

func TestParseObjectKey_Invalid(t *testing.T) {
	bad := []string{
		"",
		"/photos/cat.jpg",
		"photos//cat.jpg",
		"photos/./cat.jpg",
		"photos/../cat.jpg",
		"photos/\x00/cat.jpg",
	}
	for _, raw := range bad {
		if _, err := ParseObjectKey(raw); err == nil {
			t.Errorf("ParseObjectKey(%q) succeeded; want error", raw)
		}
	}
}

func TestParsePrefix(t *testing.T) {
	cases := []struct {
		in       string
		wantLen  int
		wantFull string
	}{
		{"", 0, ""},
		{"photos", 1, "photos"},
		{"photos/", 1, "photos"},
		{"photos/2024", 2, "photos/2024"},
	}
	for _, tc := range cases {
		got, err := ParsePrefix(tc.in)
		if err != nil {
			t.Fatalf("ParsePrefix(%q): %v", tc.in, err)
		}
		if len(got.Segments) != tc.wantLen {
			t.Errorf("ParsePrefix(%q): segments=%d want %d", tc.in, len(got.Segments), tc.wantLen)
		}
		if got.FullPath != tc.wantFull {
			t.Errorf("ParsePrefix(%q): full=%q want %q", tc.in, got.FullPath, tc.wantFull)
		}
	}
}
