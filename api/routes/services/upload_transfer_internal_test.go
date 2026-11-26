package services

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

// Parallel chunks count once; gaps between them (a paused upload) don't count.
func TestUploadSessionTransferClock(t *testing.T) {
	store := &UploadSessionStore{}
	sess, _ := store.Create(uuid.New(), "zoe", "v.mp4", nil, 3, 3)

	endA := sess.BeginTransfer()
	endB := sess.BeginTransfer() // overlaps A
	time.Sleep(30 * time.Millisecond)
	endA()
	endB()
	endB()                            // idempotent
	time.Sleep(60 * time.Millisecond) // paused
	endC := sess.BeginTransfer()
	time.Sleep(30 * time.Millisecond)
	endC()

	got := sess.TransferDuration()
	if got < 55*time.Millisecond || got > 85*time.Millisecond {
		t.Fatalf("transfer = %v, want ≈60ms (two 30ms bursts, overlap and pause excluded)", got)
	}
}
