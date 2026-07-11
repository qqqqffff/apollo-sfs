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

	// driveQ sets this user's own per-drive quota and usage explicitly.
	driveQ := func(id uuid.UUID, primaryFlag bool, capacity, driveUsed, quota, userUsed int64, active bool) db.UserDriveInfo {
		return db.UserDriveInfo{
			DriveID:        id,
			CapacityBytes:  capacity,
			DriveUsedBytes: driveUsed,
			QuotaBytes:     quota,
			UserUsedBytes:  userUsed,
			IsPrimary:      primaryFlag,
			DriveIsActive:  active,
			ServerIsActive: active,
		}
	}

	// drive gives the allocation an "unlimited" per-user quota (quota == capacity,
	// no usage) so pre-existing cases exercise only the physical-capacity check;
	// quota-specific behavior is covered by driveQ above.
	drive := func(id uuid.UUID, primaryFlag bool, capacity, used int64, active bool) db.UserDriveInfo {
		return driveQ(id, primaryFlag, capacity, used, capacity, 0, active)
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
			drive(primary, true, 100, 100, true), // full
			drive(emptier, false, 100, 0, false), // inactive, must be skipped
			drive(fuller, false, 100, 50, true),  // only active candidate
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

	t.Run("skips a drive with physical room but no per-user quota headroom", func(t *testing.T) {
		drives := []db.UserDriveInfo{
			// Plenty of physical room, but this user's own quota on the drive is
			// exhausted — must not be picked despite being primary.
			driveQ(primary, true, 1000, 10, 50, 50, true),
			driveQ(emptier, false, 1000, 10, 100, 0, true),
		}
		got, ok := pickUploadDrive(drives, 5)
		if !ok || got != emptier {
			t.Fatalf("want emptier %s (only one with quota headroom), got %s ok=%v", emptier, got, ok)
		}
	})

	t.Run("primary with quota room wins even when a non-primary has more physical room", func(t *testing.T) {
		drives := []db.UserDriveInfo{
			driveQ(primary, true, 100, 90, 100, 90, true),   // 10 bytes of both physical and quota room
			driveQ(fuller, false, 1000, 10, 1000, 10, true), // huge physical+quota headroom, but not primary
		}
		got, ok := pickUploadDrive(drives, 5)
		if !ok || got != primary {
			t.Fatalf("want primary %s, got %s ok=%v", primary, got, ok)
		}
	})

	t.Run("no room anywhere due to quota exhaustion despite physical space", func(t *testing.T) {
		drives := []db.UserDriveInfo{
			driveQ(primary, true, 1000, 10, 50, 50, true),
			driveQ(emptier, false, 1000, 10, 50, 50, true),
		}
		if _, ok := pickUploadDrive(drives, 5); ok {
			t.Fatal("expected ok=false when every drive's per-user quota is exhausted")
		}
	})
}

func TestPinnedDriveIfValid(t *testing.T) {
	pinned := uuid.New()
	other := uuid.New()

	driveQ := func(id uuid.UUID, capacity, driveUsed, quota, userUsed int64, active bool) db.UserDriveInfo {
		return db.UserDriveInfo{
			DriveID:        id,
			CapacityBytes:  capacity,
			DriveUsedBytes: driveUsed,
			QuotaBytes:     quota,
			UserUsedBytes:  userUsed,
			DriveIsActive:  active,
			ServerIsActive: active,
		}
	}

	// drive gives the allocation an "unlimited" per-user quota (quota ==
	// capacity, no usage) so pre-existing cases exercise only the
	// physical-capacity check.
	drive := func(id uuid.UUID, capacity, used int64, active bool) db.UserDriveInfo {
		return driveQ(id, capacity, used, capacity, 0, active)
	}

	t.Run("nil folderDriveID falls through", func(t *testing.T) {
		drives := []db.UserDriveInfo{drive(pinned, 100, 10, true)}
		if _, ok := pinnedDriveIfValid(drives, nil, 5); ok {
			t.Fatal("expected ok=false when folderDriveID is nil")
		}
	})

	t.Run("pinned drive wins when active and has room", func(t *testing.T) {
		drives := []db.UserDriveInfo{
			drive(pinned, 100, 10, true),
			drive(other, 100, 0, true),
		}
		got, ok := pinnedDriveIfValid(drives, &pinned, 5)
		if !ok || got != pinned {
			t.Fatalf("want pinned %s, got %s ok=%v", pinned, got, ok)
		}
	})

	t.Run("falls through when pinned drive has no room", func(t *testing.T) {
		drives := []db.UserDriveInfo{
			drive(pinned, 100, 98, true), // 2 bytes free, file is 5 bytes
			drive(other, 100, 0, true),
		}
		if _, ok := pinnedDriveIfValid(drives, &pinned, 5); ok {
			t.Fatal("expected ok=false when pinned drive lacks room")
		}
	})

	t.Run("falls through when pinned drive is inactive", func(t *testing.T) {
		drives := []db.UserDriveInfo{
			drive(pinned, 100, 10, false), // inactive
			drive(other, 100, 0, true),
		}
		if _, ok := pinnedDriveIfValid(drives, &pinned, 5); ok {
			t.Fatal("expected ok=false when pinned drive is inactive")
		}
	})

	t.Run("falls through when pinned drive is no longer in the user's allocations", func(t *testing.T) {
		// Simulates a revoked allocation (e.g. a premium downgrade) after the
		// folder was created with this drive pinned.
		drives := []db.UserDriveInfo{drive(other, 100, 0, true)}
		if _, ok := pinnedDriveIfValid(drives, &pinned, 5); ok {
			t.Fatal("expected ok=false when pinned drive is not in the user's drives")
		}
	})

	t.Run("falls through when the pinned drive is per-user quota-exhausted despite physical room", func(t *testing.T) {
		drives := []db.UserDriveInfo{
			driveQ(pinned, 1000, 10, 50, 50, true), // huge physical room, but quota exhausted
			driveQ(other, 100, 0, 100, 0, true),
		}
		if _, ok := pinnedDriveIfValid(drives, &pinned, 5); ok {
			t.Fatal("expected ok=false when the pinned drive's per-user quota is exhausted")
		}
	})
}

func TestHasRoomForUpload(t *testing.T) {
	base := db.UserDriveInfo{CapacityBytes: 100, DriveUsedBytes: 90, QuotaBytes: 100, UserUsedBytes: 90}

	t.Run("both physical and quota room", func(t *testing.T) {
		if !hasRoomForUpload(base, 5) {
			t.Fatal("expected room: 10 bytes free both physically and on quota")
		}
	})

	t.Run("physically full", func(t *testing.T) {
		d := base
		d.DriveUsedBytes = 100
		if hasRoomForUpload(d, 5) {
			t.Fatal("expected no room: drive physically full")
		}
	})

	t.Run("quota exhausted despite physical room", func(t *testing.T) {
		d := base
		d.DriveUsedBytes = 10
		d.QuotaBytes = 50
		d.UserUsedBytes = 50
		if hasRoomForUpload(d, 5) {
			t.Fatal("expected no room: this user's quota on the drive is exhausted")
		}
	})

	t.Run("both exhausted", func(t *testing.T) {
		d := base
		d.DriveUsedBytes = 100
		d.QuotaBytes = 50
		d.UserUsedBytes = 50
		if hasRoomForUpload(d, 5) {
			t.Fatal("expected no room")
		}
	})
}
