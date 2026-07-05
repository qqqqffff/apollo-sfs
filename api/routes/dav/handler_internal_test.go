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

func TestParseDestination(t *testing.T) {
	const token = "tok123"
	cases := []struct {
		dest    string
		want    []string
		wantErr bool
	}{
		{"https://host/dav/tok123/docs/new.txt", []string{"docs", "new.txt"}, false},
		{"/dav/tok123/renamed.txt", []string{"renamed.txt"}, false},
		{"https://host/dav/tok123/my%20docs/a.txt", []string{"my docs", "a.txt"}, false},
		{"", nil, true}, // missing header
		{"https://host/dav/othertoken/x.txt", nil, true},     // different mount
		{"https://host/api/v1/files", nil, true},             // outside /dav
		{"https://host/dav/tok123", nil, true},               // mount root
		{"https://host/dav/tok123/", nil, true},              // mount root
		{"https://host/dav/tok123extra/x.txt", nil, true},    // token prefix trick
		{"https://host/dav/tok123/../escape.txt", nil, true}, // dot-dot
	}
	for _, tc := range cases {
		got, err := parseDestination(tc.dest, token)
		if tc.wantErr {
			if err == nil {
				t.Errorf("parseDestination(%q): expected error, got %v", tc.dest, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("parseDestination(%q): unexpected error %v", tc.dest, err)
			continue
		}
		if len(got) != len(tc.want) {
			t.Errorf("parseDestination(%q) = %v, want %v", tc.dest, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("parseDestination(%q) = %v, want %v", tc.dest, got, tc.want)
				break
			}
		}
	}
}

func TestParseProppatchPropsRejectsUnsafeNames(t *testing.T) {
	body := strings.NewReader(`<?xml version="1.0"?>
		<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:example">
			<D:set><D:prop>
				<Z:Win32LastModifiedTime>x</Z:Win32LastModifiedTime>
				<Z:nested><Z:inner/></Z:nested>
			</D:prop></D:set>
		</D:propertyupdate>`)
	props := parseProppatchProps(body)
	if len(props) != 2 {
		t.Fatalf("expected 2 top-level props, got %v", props)
	}
	if props[0].local != "Win32LastModifiedTime" || props[0].space != "urn:example" {
		t.Errorf("unexpected first prop: %+v", props[0])
	}
	if props[1].local != "nested" {
		t.Errorf("unexpected second prop: %+v", props[1])
	}
	for _, p := range props {
		if !isSimpleXMLName(p.local) {
			t.Errorf("unsafe prop name passed filter: %q", p.local)
		}
	}
}

func TestIsSimpleXMLName(t *testing.T) {
	for _, ok := range []string{"displayname", "Win32FileAttributes", "a-b_c.d"} {
		if !isSimpleXMLName(ok) {
			t.Errorf("expected %q to be accepted", ok)
		}
	}
	for _, bad := range []string{"", "1abc", "-abc", "a<b", "a b", strings.Repeat("x", 129)} {
		if isSimpleXMLName(bad) {
			t.Errorf("expected %q to be rejected", bad)
		}
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
