package services

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Keyframe is one sampled video frame handed to the recognition sidecar.
type Keyframe struct {
	JPEG    []byte
	FrameMs int
}

// ExtractKeyframes samples up to maxFrames evenly spaced frames from the
// video at inputPath as JPEGs (downscaled to <=1280px wide so inference cost
// is bounded). Even sampling is used instead of raw I-frame extraction so
// FrameMs timestamps are exact and long videos get uniform coverage.
// -threads caps FFmpeg so indexing stays inside the recognition resource
// pool instead of grabbing every core.
func (t *TranscodeService) ExtractKeyframes(ctx context.Context, inputPath string, maxFrames int) ([]Keyframe, error) {
	if !t.Available() {
		return nil, fmt.Errorf("ffmpeg not found in PATH")
	}
	if maxFrames <= 0 {
		maxFrames = 1
	}

	durationSec := t.probeDurationSeconds(ctx, inputPath)
	// One frame per stepSec, starting at 0; short videos yield a single frame.
	stepSec := 1.0
	if durationSec > 0 {
		stepSec = durationSec / float64(maxFrames)
		if stepSec < 1.0 {
			stepSec = 1.0
		}
	}

	outDir, err := os.MkdirTemp("", "keyframes-*")
	if err != nil {
		return nil, fmt.Errorf("keyframes: temp dir: %w", err)
	}
	defer os.RemoveAll(outDir)

	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, t.ffmpegPath,
		"-i", inputPath,
		"-vf", fmt.Sprintf("fps=1/%.3f,scale='min(1280,iw)':-2", stepSec),
		"-frames:v", strconv.Itoa(maxFrames),
		"-q:v", "3",
		"-threads", "2",
		"-f", "image2",
		filepath.Join(outDir, "frame_%04d.jpg"),
		"-y",
	)
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("keyframes: ffmpeg: %w: %s", err, stderr.String())
	}

	entries, err := os.ReadDir(outDir)
	if err != nil {
		return nil, fmt.Errorf("keyframes: read dir: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })

	var frames []Keyframe
	for i, e := range entries {
		if !strings.HasSuffix(e.Name(), ".jpg") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(outDir, e.Name()))
		if err != nil {
			continue
		}
		frames = append(frames, Keyframe{JPEG: data, FrameMs: int(float64(i) * stepSec * 1000)})
	}
	if len(frames) == 0 {
		return nil, fmt.Errorf("keyframes: no frames extracted")
	}
	return frames, nil
}

// probeDurationSeconds returns the container duration, or 0 when ffprobe is
// unavailable or the duration cannot be parsed (callers fall back to 1 fps).
func (t *TranscodeService) probeDurationSeconds(ctx context.Context, inputPath string) float64 {
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		return 0
	}
	out, err := exec.CommandContext(ctx, ffprobe,
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		inputPath,
	).Output()
	if err != nil {
		return 0
	}
	dur, err := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	if err != nil || dur < 0 {
		return 0
	}
	return dur
}
