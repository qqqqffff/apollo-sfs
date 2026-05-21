package services

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/rwcarlsen/goexif/exif"
)

// MetadataService extracts capture dates from media. Images are parsed in-process
// via EXIF; videos are probed with ffprobe (part of the FFmpeg suite). If ffprobe
// is not found, video extraction is a no-op and callers fall back to upload date.
type MetadataService struct {
	ffprobePath string
}

// NewMetadataService probes PATH for ffprobe.
func NewMetadataService() *MetadataService {
	path, _ := exec.LookPath("ffprobe")
	return &MetadataService{ffprobePath: path}
}

// ExtractImageTakenAt returns the EXIF DateTimeOriginal of an image, or nil when
// absent or unparseable (e.g. PNG, HEIC, stripped metadata).
func ExtractImageTakenAt(data []byte) *time.Time {
	x, err := exif.Decode(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	t, err := x.DateTime()
	if err != nil {
		return nil
	}
	return &t
}

// ExtractVideoTakenAt returns the container creation_time tag of the video at
// path, or nil when ffprobe is unavailable or the tag is missing/unparseable.
func (m *MetadataService) ExtractVideoTakenAt(ctx context.Context, path string) *time.Time {
	if m.ffprobePath == "" {
		return nil
	}
	cmd := exec.CommandContext(ctx, m.ffprobePath,
		"-v", "quiet",
		"-print_format", "json",
		"-show_entries", "format_tags=creation_time",
		path,
	)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var probe struct {
		Format struct {
			Tags struct {
				CreationTime string `json:"creation_time"`
			} `json:"tags"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &probe); err != nil {
		return nil
	}
	raw := strings.TrimSpace(probe.Format.Tags.CreationTime)
	if raw == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, raw); err == nil {
			return &t
		}
	}
	return nil
}

// extractToTempFile writes plaintext to a temp file so ffprobe can read it,
// returning the path and a cleanup func. The caller must call cleanup.
func extractToTempFile(plaintext []byte, ext string) (string, func(), error) {
	f, err := os.CreateTemp("", "probe-*."+ext)
	if err != nil {
		return "", func() {}, err
	}
	if _, err := f.Write(plaintext); err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", func() {}, err
	}
	f.Close()
	return f.Name(), func() { os.Remove(f.Name()) }, nil
}
