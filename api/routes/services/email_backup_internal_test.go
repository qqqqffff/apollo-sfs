package services

import (
	"strings"
	"testing"
	"time"
)

func TestNormalizeEmailAddress(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"user@example.com", "user@example.com", false},
		{"  User@Example.COM  ", "user@example.com", false},
		{"Jane Doe <jane@example.com>", "jane@example.com", false},
		{"", "", true},
		{"not-an-email", "", true},
		{"a@b@c", "", true},
		{strings.Repeat("a", 250) + "@example.com", "", true},
	}
	for _, tc := range cases {
		got, err := NormalizeEmailAddress(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("NormalizeEmailAddress(%q): expected error, got %q", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("NormalizeEmailAddress(%q): unexpected error %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("NormalizeEmailAddress(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestEmailBackupFileName(t *testing.T) {
	at := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)

	name := emailBackupFileName("Hello world", "msg-123", at)
	if !strings.HasPrefix(name, "2026-07-01 Hello world [") || !strings.HasSuffix(name, "].email.json") {
		t.Errorf("unexpected filename %q", name)
	}

	// Same message id must always produce the same name; different ids must not
	// collide even with identical subject and date.
	if name != emailBackupFileName("Hello world", "msg-123", at) {
		t.Error("filename not deterministic for same message id")
	}
	if name == emailBackupFileName("Hello world", "msg-456", at) {
		t.Error("filenames collide for different message ids")
	}

	// Empty and path-hostile subjects still yield a sane name.
	name = emailBackupFileName("", "msg-123", at)
	if !strings.Contains(name, "(no subject)") {
		t.Errorf("empty subject: got %q", name)
	}
	name = emailBackupFileName("a/b\\c\r\n", "msg-123", at)
	if strings.ContainsAny(name, "/\\\r\n") {
		t.Errorf("unsanitized filename %q", name)
	}

	// Very long subjects stay within the 255-char file name budget.
	name = emailBackupFileName(strings.Repeat("x", 500), "msg-123", at)
	if len(name) > 255 {
		t.Errorf("filename too long: %d chars", len(name))
	}
}

func TestBareEmailAddress(t *testing.T) {
	cases := map[string]string{
		"jane@example.com":                          "jane@example.com",
		"Jane Doe <Jane@Example.com>":               "jane@example.com",
		"Jane <jane@x.com>, Bob <bob@y.com>":        "jane@x.com",
		"":                                          "",
		"completely unparseable":                    "completely unparseable",
		"  \"Support\" <SUPPORT+tag@example.com>  ": "support+tag@example.com",
	}
	for in, want := range cases {
		if got := bareEmailAddress(in); got != want {
			t.Errorf("bareEmailAddress(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTruncateRunes(t *testing.T) {
	if got := truncateRunes("hello", 10); got != "hello" {
		t.Errorf("short string mangled: %q", got)
	}
	if got := truncateRunes("hello", 3); got != "hel" {
		t.Errorf("truncation wrong: %q", got)
	}
	// Multi-byte runes are not split.
	if got := truncateRunes("héllo wörld", 5); got != "héllo" {
		t.Errorf("unicode truncation wrong: %q", got)
	}
}
