package main

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// writeTempFile creates a fake hwmon temp1_input file at root/rel with the given
// millidegree-C content.
func writeTempFile(t *testing.T, root, rel string, milliC int) {
	t.Helper()
	path := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strconv.Itoa(milliC)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Two identical NVMe drives previously collided: gopsutil reports both under the
// same generic "nvme_composite" sensor key with no per-controller identity, so
// the old text-matching heuristic could never tell nvme0 and nvme1 apart. This
// proves the sysfs-path-based lookup resolves each to its own distinct reading.
func TestDriveTempPath_DistinguishesMultipleNVMeControllers(t *testing.T) {
	root := t.TempDir()
	t.Setenv("NODE_AGENT_SYS_ROOT", root)

	writeTempFile(t, root, "class/nvme/nvme0/hwmon3/temp1_input", 38500)
	writeTempFile(t, root, "class/nvme/nvme1/hwmon4/temp1_input", 52000)

	got0 := readTempFile(driveTempPath("/dev/nvme0n1p1"))
	got1 := readTempFile(driveTempPath("/dev/nvme1n1"))

	if got0 == nil || *got0 != 38.5 {
		t.Fatalf("nvme0 temp = %v, want 38.5", got0)
	}
	if got1 == nil || *got1 != 52.0 {
		t.Fatalf("nvme1 temp = %v, want 52.0", got1)
	}
}

func TestDriveTempPath_SATADriveViaDrivetemp(t *testing.T) {
	root := t.TempDir()
	t.Setenv("NODE_AGENT_SYS_ROOT", root)

	writeTempFile(t, root, "block/sda/device/hwmon/hwmon2/temp1_input", 41200)

	got := readTempFile(driveTempPath("/dev/sda1"))
	if got == nil || *got != 41.2 {
		t.Fatalf("sda temp = %v, want 41.2", got)
	}
}

func TestDriveTempPath_SATADriveAltLayout(t *testing.T) {
	root := t.TempDir()
	t.Setenv("NODE_AGENT_SYS_ROOT", root)

	// Some kernels/distros expose hwmonN directly under device/, without the
	// intermediate "hwmon" directory — both layouts must resolve.
	writeTempFile(t, root, "block/sda/device/hwmon7/temp1_input", 33000)

	got := readTempFile(driveTempPath("/dev/sda"))
	if got == nil || *got != 33.0 {
		t.Fatalf("sda (alt layout) temp = %v, want 33.0", got)
	}
}

func TestDriveTempPath_NoSensorReturnsEmpty(t *testing.T) {
	root := t.TempDir()
	t.Setenv("NODE_AGENT_SYS_ROOT", root)

	if got := driveTempPath("/dev/nvme0n1p1"); got != "" {
		t.Fatalf("expected no path, got %q", got)
	}
	if got := readTempFile(""); got != nil {
		t.Fatalf("expected nil temp, got %v", got)
	}
}

func TestDriveTempPath_UnrecognisedDeviceReturnsEmpty(t *testing.T) {
	if got := driveTempPath("/dev/mapper/vg0-lv0"); got != "" {
		t.Fatalf("expected no path for unrecognised device, got %q", got)
	}
	if got := driveTempPath(""); got != "" {
		t.Fatalf("expected no path for empty device, got %q", got)
	}
}
