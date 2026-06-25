package services

import (
	"testing"

	"github.com/google/uuid"

	"apollo-sfs.com/api/db"
)

func TestPickUploadDrive(t *testing.T) {
	primary := uuid.New()
	emptier := uuid.New()
	fuller := uuid.New()

	drive := func(id uuid.UUID, primaryFlag bool, capacity, used int64, active bool) db.UserDriveInfo {
		return db.UserDriveInfo{
			DriveID:        id,
			CapacityBytes:  capacity,
			DriveUsedBytes: used,
			IsPrimary:      primaryFlag,
			DriveIsActive:  active,
			ServerIsActive: active,
		}
	}

	t.Run("primary wins when it has room", func(t *testing.T) {
		drives := []db.UserDriveInfo{
			drive(primary, true, 100, 90, true), // 90% but still fits a 5-byte file
			drive(emptier, false, 100, 10, true),
		}
		got, ok := pickUploadDrive(drives, 5)
		if !ok || got != primary {
			t.Fatalf("want primary %s, got %s ok=%v", primary, got, ok)
		}
	})

	t.Run("falls back to least-%-used when primary is full", func(t *testing.T) {
		drives := []db.UserDriveInfo{
			drive(primary, true, 100, 100, true), // full
			drive(fuller, false, 100, 80, true),  // 80%
			drive(emptier, false, 100, 20, true), // 20% → winner
		}
		got, ok := pickUploadDrive(drives, 5)
		if !ok || got != emptier {
			t.Fatalf("want emptier %s, got %s ok=%v", emptier, got, ok)
		}
	})

	t.Run("skips inactive drives", func(t *testing.T) {
		drives := []db.UserDriveInfo{
			drive(primary, true, 100, 100, true),    // full
			drive(emptier, false, 100, 0, false),    // inactive, must be skipped
			drive(fuller, false, 100, 50, true),     // only active candidate
		}
		got, ok := pickUploadDrive(drives, 5)
		if !ok || got != fuller {
			t.Fatalf("want fuller %s, got %s ok=%v", fuller, got, ok)
		}
	})

	t.Run("no room anywhere", func(t *testing.T) {
		drives := []db.UserDriveInfo{
			drive(primary, true, 100, 100, true),
			drive(emptier, false, 100, 99, true),
		}
		if _, ok := pickUploadDrive(drives, 5); ok {
			t.Fatal("expected ok=false when nothing has room")
		}
	})
}
