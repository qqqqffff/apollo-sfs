package main

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func mkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

// writeTempFile creates a fake hwmon temp*_input file inside dir with the given
// millidegree-C content.
func writeTempFile(t *testing.T, dir, filename string, milliC int) {
	t.Helper()
	mkdirAll(t, dir)
	path := filepath.Join(dir, filename)
	if err := os.WriteFile(path, []byte(strconv.Itoa(milliC)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Two identical NVMe drives previously collided: gopsutil reports both under the
// same generic "nvme_composite" sensor key with no per-controller identity, so
// the old text-matching heuristic could never tell nvme0 and nvme1 apart. This
// proves the hwmon device-symlink resolution ties each to its own distinct
// reading, regardless of which hwmonN index the kernel happened to assign.
func TestDriveTempPath_DistinguishesMultipleNVMeControllers(t *testing.T) {
	root := t.TempDir()
	t.Setenv("NODE_AGENT_SYS_ROOT", root)

	nvme0 := filepath.Join(root, "class", "nvme", "nvme0")
	nvme1 := filepath.Join(root, "class", "nvme", "nvme1")
	mkdirAll(t, nvme0)
	mkdirAll(t, nvme1)

	hwmon3 := filepath.Join(root, "class", "hwmon", "hwmon3")
	hwmon4 := filepath.Join(root, "class", "hwmon", "hwmon4")
	symlink(t, nvme0, filepath.Join(hwmon3, "device"))
	symlink(t, nvme1, filepath.Join(hwmon4, "device"))
	writeTempFile(t, hwmon3, "temp1_input", 38500)
	writeTempFile(t, hwmon4, "temp1_input", 52000)

	got0 := readTempFile(driveTempPath("/dev/nvme0n1p1"))
	got1 := readTempFile(driveTempPath("/dev/nvme1n1"))

	if got0 == nil || *got0 != 38.5 {
		t.Fatalf("nvme0 temp = %v, want 38.5", got0)
	}
	if got1 == nil || *got1 != 52.0 {
		t.Fatalf("nvme1 temp = %v, want 52.0", got1)
	}
}

// The standard-tier HDD's drivetemp hwmon device can sit at a directory depth
// this package never hard-codes (that's exactly what broke it previously) — only
// the device-symlink match matters, not the path shape.
func TestDriveTempPath_SATADriveViaDrivetemp(t *testing.T) {
	root := t.TempDir()
	t.Setenv("NODE_AGENT_SYS_ROOT", root)

	sdaDevice := filepath.Join(root, "class", "block", "sda", "device")
	mkdirAll(t, sdaDevice)

	hwmon2 := filepath.Join(root, "class", "hwmon", "hwmon2")
	symlink(t, sdaDevice, filepath.Join(hwmon2, "device"))
	writeTempFile(t, hwmon2, "temp1_input", 41200)

	got := readTempFile(driveTempPath("/dev/sda1"))
	if got == nil || *got != 41.2 {
		t.Fatalf("sda temp = %v, want 41.2", got)
	}
}

// A hwmon device that belongs to some other piece of hardware (e.g. the CPU's
// coretemp sensor) must never be mistaken for the disk's — only an exact device
// symlink match counts.
func TestDriveTempPath_SkipsUnrelatedHwmonDevices(t *testing.T) {
	root := t.TempDir()
	t.Setenv("NODE_AGENT_SYS_ROOT", root)

	mkdirAll(t, filepath.Join(root, "class", "nvme", "nvme0")) // no hwmon device registered yet

	cpuDevice := filepath.Join(root, "devices", "platform", "coretemp.0")
	mkdirAll(t, cpuDevice)
	hwmon0 := filepath.Join(root, "class", "hwmon", "hwmon0")
	symlink(t, cpuDevice, filepath.Join(hwmon0, "device"))
	writeTempFile(t, hwmon0, "temp1_input", 45000)

	if got := driveTempPath("/dev/nvme0n1p1"); got != "" {
		t.Fatalf("expected no path (only an unrelated hwmon device exists), got %q", got)
	}
}

func TestDriveTempPath_NoSensorReturnsEmpty(t *testing.T) {
	root := t.TempDir()
	t.Setenv("NODE_AGENT_SYS_ROOT", root)
	mkdirAll(t, filepath.Join(root, "class", "nvme", "nvme0"))

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
