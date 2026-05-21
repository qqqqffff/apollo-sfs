package services

import (
	"context"
	"testing"
)

func TestIsMediaMime(t *testing.T) {
	cases := map[string]bool{
		"image/jpeg":               true,
		"image/png":                true,
		"video/mp4":                true,
		"video/quicktime":          true,
		"application/pdf":          false,
		"text/plain":               false,
		"application/octet-stream": false,
	}
	for mime, want := range cases {
		if got := isMediaMime(mime); got != want {
			t.Errorf("isMediaMime(%q) = %v, want %v", mime, got, want)
		}
	}
}

func TestExtractImageTakenAt_NonImageReturnsNil(t *testing.T) {
	// Random bytes carry no EXIF — extraction must fail gracefully (nil), never panic.
	if got := ExtractImageTakenAt([]byte("not an image at all")); got != nil {
		t.Errorf("expected nil for non-image bytes, got %v", got)
	}
	if got := ExtractImageTakenAt(nil); got != nil {
		t.Errorf("expected nil for empty input, got %v", got)
	}
}

func TestExtractVideoTakenAt_NoFfprobeReturnsNil(t *testing.T) {
	// With no ffprobe configured, video extraction is a graceful no-op.
	m := &MetadataService{ffprobePath: ""}
	if got := m.ExtractVideoTakenAt(context.Background(), "/nonexistent.mp4"); got != nil {
		t.Errorf("expected nil when ffprobe is unavailable, got %v", got)
	}
}
