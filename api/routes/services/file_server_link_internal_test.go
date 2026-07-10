package services

import (
	"regexp"
	"strings"
	"testing"
)

func TestSlugifyServerName(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"Attic", "attic"},
		{"Pi 5 (Fast Tier)", "pi-5-fast-tier"},
		{"  leading and trailing  ", "leading-and-trailing"},
		{"日本語サーバー", "server"}, // nothing alphanumeric-ASCII survives
		{"", "server"},
		{strings.Repeat("a", 50), strings.Repeat("a", 32)},
		{"a--b__c..d", "a-b-c-d"},
	}
	for _, tc := range cases {
		got := slugifyServerName(tc.in)
		if got != tc.want {
			t.Errorf("slugifyServerName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

var mountTokenPattern = regexp.MustCompile(`^[a-z0-9-]+-(fast|standard)-[a-z0-9]{8}$`)

func TestGenerateMountTokenFormat(t *testing.T) {
	cases := []struct {
		serverName string
		driveType  string
		wantTier   string
	}{
		{"Attic", "nvme", "fast"},
		{"Basement", "hdd", "standard"},
		{"Weird Name!! 日本語", "nvme", "fast"},
	}
	for _, tc := range cases {
		token, err := generateMountToken(tc.serverName, tc.driveType)
		if err != nil {
			t.Fatalf("generateMountToken(%q, %q): %v", tc.serverName, tc.driveType, err)
		}
		if !mountTokenPattern.MatchString(token) {
			t.Errorf("generateMountToken(%q, %q) = %q, does not match expected shape", tc.serverName, tc.driveType, token)
		}
		if !strings.Contains(token, "-"+tc.wantTier+"-") {
			t.Errorf("generateMountToken(%q, %q) = %q, expected tier %q", tc.serverName, tc.driveType, token, tc.wantTier)
		}
	}
}

func TestGenerateMountTokenIsRandomized(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 100; i++ {
		token, err := generateMountToken("Attic", "nvme")
		if err != nil {
			t.Fatalf("generateMountToken: %v", err)
		}
		if seen[token] {
			t.Fatalf("generateMountToken produced a duplicate token %q within 100 draws", token)
		}
		seen[token] = true
	}
}
