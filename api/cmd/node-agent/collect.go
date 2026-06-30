package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/shirou/gopsutil/v4/cpu"
	psdisk "github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
	psnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/sensors"

	"apollo-sfs.com/api/models"
)

// byLabelDir is the directory of filesystem-label → device symlinks. Overridable
// via DEV_DISK_BY_LABEL for testing or non-standard layouts.
func byLabelDir() string {
	if d := os.Getenv("DEV_DISK_BY_LABEL"); d != "" {
		return d
	}
	return "/dev/disk/by-label"
}

// collectPayload reads this node's live hardware metrics into a push payload.
// CPU percent is utilisation since the previous call (the sampler calls this on a
// fixed interval, so successive readings are meaningful; the first is ~0).
func collectPayload(hostname string) models.NodeMetricsPayload {
	p := models.NodeMetricsPayload{Hostname: hostname}

	if pcts, err := cpu.Percent(0, false); err == nil && len(pcts) > 0 {
		p.CPUPercent = pcts[0]
	}
	if vmem, err := mem.VirtualMemory(); err == nil {
		p.MemoryUsedBytes = int64(vmem.Used)
		p.MemoryTotalBytes = int64(vmem.Total)
	}
	if iocs, err := psnet.IOCounters(false); err == nil && len(iocs) > 0 {
		p.NetworkBytesSent = int64(iocs[0].BytesSent)
		p.NetworkBytesRecv = int64(iocs[0].BytesRecv)
	}

	temps := readDriveSensors()
	p.CPUTempCelsius = collectCPUTemp()
	p.Drives = collectDrives(temps)
	return p
}

// collectCPUTemp returns the best-available CPU temperature, or nil when no CPU
// sensor is accessible. Mirrors the manager-side sensor matching in services.
func collectCPUTemp() *float64 {
	readings, err := sensors.SensorsTemperatures()
	if err != nil {
		return nil
	}
	for i := range readings {
		s := &readings[i]
		if s.Temperature <= 0 {
			continue
		}
		key := strings.ToLower(s.SensorKey)
		if strings.Contains(key, "coretemp") ||
			strings.Contains(key, "k10temp") ||
			strings.Contains(key, "package id") ||
			strings.Contains(key, "tctl") ||
			strings.Contains(key, "cpu") {
			t := s.Temperature
			return &t
		}
	}
	return nil
}

// diskMount is one physical disk the agent reports, identified by a display label
// and the mount point whose capacity/usage is read.
type diskMount struct {
	label string
	mount string
}

// configuredDiskMounts parses NODE_DISK_MOUNTS — a comma-separated list of
// "label:/mount/point" entries (a bare "/mount/point" is labelled by its
// basename). This is the reliable source inside a container: the data mounts are
// bind-mounted into the agent, whereas the /dev/disk/by-label symlinks point at
// block devices under /dev that are not, so resolving them fails.
func configuredDiskMounts() []diskMount {
	raw := os.Getenv("NODE_DISK_MOUNTS")
	if raw == "" {
		return nil
	}
	var out []diskMount
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		label, mount := "", part
		if i := strings.Index(part, ":"); i > 0 {
			label, mount = strings.TrimSpace(part[:i]), strings.TrimSpace(part[i+1:])
		}
		if label == "" {
			label = filepath.Base(mount)
		}
		out = append(out, diskMount{label: label, mount: mount})
	}
	return out
}

// labelMounts discovers labelled filesystems from /dev/disk/by-label. It reads
// each symlink's text with os.Readlink (not filepath.EvalSymlinks) so it works
// inside a container where the symlink targets under /dev are absent; the device
// basename is then matched to a currently-visible mount.
func labelMounts(partitions []psdisk.PartitionStat) []diskMount {
	entries, err := os.ReadDir(byLabelDir())
	if err != nil {
		return nil
	}
	var out []diskMount
	for _, e := range entries {
		label := e.Name()
		target, err := os.Readlink(filepath.Join(byLabelDir(), label))
		if err != nil {
			continue
		}
		devBase := filepath.Base(target) // e.g. "nvme0n1p1"
		for _, prt := range partitions {
			if filepath.Base(prt.Device) == devBase {
				out = append(out, diskMount{label: label, mount: prt.Mountpoint})
				break
			}
		}
	}
	return out
}

// collectDrives reports live capacity/used/free plus temperature for each physical
// disk. Disks come from NODE_DISK_MOUNTS when set (deterministic, label-free),
// otherwise from /dev/disk/by-label. Mounts that can't be read are skipped (the
// API falls back to stored DB capacity). The label is matched to a registered
// drive on the API side.
func collectDrives(temps []sensors.TemperatureStat) []models.DrivePayload {
	partitions, _ := psdisk.Partitions(true)

	mounts := configuredDiskMounts()
	if len(mounts) == 0 {
		mounts = labelMounts(partitions)
	}

	// Resolve a mount's backing device so temperatures can be matched to it.
	deviceFor := func(mount string) string {
		for _, prt := range partitions {
			if prt.Mountpoint == mount {
				return prt.Device
			}
		}
		return ""
	}

	var out []models.DrivePayload
	for _, m := range mounts {
		usage, err := psdisk.Usage(m.mount)
		if err != nil {
			continue
		}
		dev := deviceFor(m.mount)
		d := models.DrivePayload{
			Label:  m.label,
			Device: dev,
			// Free = available to non-root; Total = Used+Free so percentages
			// exclude filesystem-reserved blocks (matches the metrics sampler).
			TotalBytes: int64(usage.Used) + int64(usage.Free),
			UsedBytes:  int64(usage.Used),
			FreeBytes:  int64(usage.Free),
		}
		d.TempCelsius = matchDriveTemp(dev, m.label, temps)
		out = append(out, d)
	}
	return out
}

// reDevBase extracts the physical-disk token from a device path for matching a
// drive to a hardware temperature sensor, e.g. "/dev/nvme0n1p1" → "nvme0".
var reDevBase = regexp.MustCompile(`(nvme\d+|sd[a-z]+|mmcblk\d+)`)

// readDriveSensors returns temperature readings that look like storage devices.
func readDriveSensors() []sensors.TemperatureStat {
	readings, err := sensors.SensorsTemperatures()
	if err != nil {
		return nil
	}
	out := make([]sensors.TemperatureStat, 0, len(readings))
	for _, s := range readings {
		if s.Temperature <= 0 {
			continue
		}
		key := strings.ToLower(s.SensorKey)
		if strings.Contains(key, "nvme") || strings.Contains(key, "drivetemp") ||
			reDevBase.MatchString(key) {
			out = append(out, s)
		}
	}
	return out
}

// matchDriveTemp maps a drive to a temperature reading, preferring a sensor whose
// key contains the device token; falls back to the lone drive sensor when there is
// exactly one. Returns nil otherwise.
func matchDriveTemp(device, label string, temps []sensors.TemperatureStat) *float64 {
	if len(temps) == 0 {
		return nil
	}
	token := ""
	if m := reDevBase.FindString(device); m != "" {
		token = m
	} else if m := reDevBase.FindString(label); m != "" {
		token = m
	}
	if token != "" {
		for i := range temps {
			if strings.Contains(strings.ToLower(temps[i].SensorKey), token) {
				t := temps[i].Temperature
				return &t
			}
		}
	}
	if len(temps) == 1 {
		t := temps[0].Temperature
		return &t
	}
	return nil
}
