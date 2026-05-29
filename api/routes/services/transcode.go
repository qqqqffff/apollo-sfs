package services

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
)

// LowQualityLabel is the canonical quality identifier for the 480p variant.
const LowQualityLabel = "low"

// TranscodeService wraps FFmpeg for background video transcoding.
// If FFmpeg is not found in PATH, Available() returns false and all
// transcode operations are no-ops (upload still works at original quality).
type TranscodeService struct {
	ffmpegPath string
}

// NewTranscodeService probes PATH for ffmpeg and returns a TranscodeService.
func NewTranscodeService() *TranscodeService {
	path, _ := exec.LookPath("ffmpeg")
	return &TranscodeService{ffmpegPath: path}
}

// Available reports whether FFmpeg was found at construction time.
func (t *TranscodeService) Available() bool {
	return t.ffmpegPath != ""
}

// TranscodeTo480p transcodes the video at inputPath to a 480p H.264/AAC MP4
// at outputPath. -movflags +faststart moves the moov atom to the front so
// browsers can begin playback before the full file is downloaded.
func (t *TranscodeService) TranscodeTo480p(ctx context.Context, inputPath, outputPath string) error {
	if !t.Available() {
		return fmt.Errorf("ffmpeg not found in PATH")
	}
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, t.ffmpegPath,
		"-i", inputPath,
		"-vf", "scale=-2:480",
		"-c:v", "libx264",
		"-crf", "28",
		"-preset", "fast",
		"-c:a", "aac",
		"-b:a", "96k",
		"-movflags", "+faststart",
		"-f", "mp4",
		outputPath,
		"-y",
	)
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg: %w: %s", err, stderr.String())
	}
	return nil
}
