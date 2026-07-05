package dav

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestSplitPath(t *testing.T) {
	cases := []struct {
		in      string
		want    []string
		wantErr bool
	}{
		{"", nil, false},
		{"/", nil, false},
		{"/docs", []string{"docs"}, false},
		{"/docs/reports/q1.pdf", []string{"docs", "reports", "q1.pdf"}, false},
		{"//double//slash/", []string{"double", "slash"}, false},
		{"/name with spaces/ok.txt", []string{"name with spaces", "ok.txt"}, false},
		{"/..", nil, true},
		{"/docs/../secret", nil, true},
		{"/docs/.", nil, true},
		{"/bad\x00name", nil, true},
		{"/" + strings.Repeat("a", 256), nil, true},
	}
	for _, tc := range cases {
		got, err := splitPath(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("splitPath(%q): expected error, got %v", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("splitPath(%q): unexpected error %v", tc.in, err)
			continue
		}
		if len(got) != len(tc.want) {
			t.Errorf("splitPath(%q) = %v, want %v", tc.in, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("splitPath(%q) = %v, want %v", tc.in, got, tc.want)
				break
			}
		}
	}
}

func TestHrefForEscapesSegments(t *testing.T) {
	href := hrefFor("tok", []string{"my docs", "a&b.txt"}, false)
	if href != "/dav/tok/my%20docs/a&b.txt" {
		t.Errorf("unexpected href %q", href)
	}
	dir := hrefFor("tok", nil, true)
	if dir != "/dav/tok/" {
		t.Errorf("unexpected collection href %q", dir)
	}
}

func TestWriteFileResponseEscapesXMLAndForcesOctetStream(t *testing.T) {
	var buf bytes.Buffer
	writeFileResponse(&buf, "/dav/tok/a&b.txt", `evil<name>&"`, 42, time.Unix(0, 0))
	out := buf.String()
	if strings.Contains(out, "<name>") {
		t.Errorf("display name not escaped: %s", out)
	}
	if !strings.Contains(out, "evil&lt;name&gt;&amp;") {
		t.Errorf("expected escaped display name, got: %s", out)
	}
	// The mount must never advertise a previewable/executable content type.
	if !strings.Contains(out, "<D:getcontenttype>application/octet-stream</D:getcontenttype>") {
		t.Errorf("expected octet-stream content type, got: %s", out)
	}
	if !strings.Contains(out, "<D:getcontentlength>42</D:getcontentlength>") {
		t.Errorf("expected content length, got: %s", out)
	}
}
