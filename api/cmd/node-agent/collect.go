package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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

	p.CPUTempCelsius = collectCPUTemp()
	p.Drives = collectDrives()
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
func collectDrives() []models.DrivePayload {
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
		d.TempCelsius = readTempFile(driveTempPath(dev))
		out = append(out, d)
	}
	return out
}

// sysRoot is the /sys mount point inside the container (bind-mounted read-only
// from the host — see docker-stack.yml). Overridable via NODE_AGENT_SYS_ROOT so
// tests can point it at a fake sysfs tree.
func sysRoot() string {
	if d := os.Getenv("NODE_AGENT_SYS_ROOT"); d != "" {
		return d
	}
	return "/sys"
}

// reNVMeCtrl and reBlockDisk extract, respectively, the NVMe controller name
// ("nvme0") or the whole-disk block device name ("sda", "mmcblk0") from a
// partition/namespace device path such as "/dev/nvme0n1p1" or "/dev/sda1".
var reNVMeCtrl = regexp.MustCompile(`^nvme\d+`)
var reBlockDisk = regexp.MustCompile(`^(sd[a-z]+|mmcblk\d+)`)

// driveTempPath resolves a physical disk's own hwmon temperature file, given its
// device path (e.g. "/dev/nvme0n1p1"). Unlike gopsutil's generic
// sensors.SensorsTemperatures() — whose SensorKey is built purely from the hwmon
// driver name ("nvme") plus its label ("composite"), with no per-controller
// identity — every NVMe drive on a host reports the identical key
// "nvme_composite". That makes drive-to-sensor matching by key text ambiguous the
// moment a node has more than one disk of the same type (e.g. the fast-tier node's
// two pooled NVMes), so it silently resolved to no temperature for either drive.
// Reading directly from the specific controller's/disk's own sysfs subtree
// (/sys/class/nvme/<ctrl>/hwmon*/temp1_input, or for a SATA/USB disk with the
// `drivetemp` kernel module bound, /sys/block/<disk>/device/hwmon*/temp1_input)
// ties each reading to the exact physical device, so N identical drives can never
// collide. Returns "" if no matching sysfs path exists (untracked device type, or
// the kernel/host doesn't expose hwmon for it).
func driveTempPath(device string) string {
	base := filepath.Base(device)

	if ctrl := reNVMeCtrl.FindString(base); ctrl != "" {
		matches, _ := filepath.Glob(filepath.Join(sysRoot(), "class", "nvme", ctrl, "hwmon*", "temp1_input"))
		if len(matches) > 0 {
			return matches[0]
		}
		return ""
	}

	if disk := reBlockDisk.FindString(base); disk != "" {
		// Try both observed drivetemp sysfs layouts (kernel/distro dependent),
		// mirroring gopsutil's own defensive handling of hwmon path variants.
		for _, pattern := range []string{
			filepath.Join(sysRoot(), "block", disk, "device", "hwmon", "hwmon*", "temp1_input"),
			filepath.Join(sysRoot(), "block", disk, "device", "hwmon*", "temp1_input"),
		} {
			matches, _ := filepath.Glob(pattern)
			if len(matches) > 0 {
				return matches[0]
			}
		}
		return ""
	}

	return ""
}

// readTempFile reads a hwmon temp*_input file (millidegrees Celsius) and returns
// the value in degrees, or nil if the path is empty or unreadable.
func readTempFile(path string) *float64 {
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	milliC, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	if err != nil {
		return nil
	}
	t := milliC / 1000.0
	return &t
}
