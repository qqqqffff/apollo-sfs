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

// collectDrives enumerates filesystem labels under /dev/disk/by-label, resolves
// each to its mount point, and reports live capacity/used/free plus temperature.
// Drives whose mount can't be found are skipped (the API falls back to stored DB
// capacity). The label is matched to a registered drive on the API side.
func collectDrives(temps []sensors.TemperatureStat) []models.DrivePayload {
	entries, err := os.ReadDir(byLabelDir())
	if err != nil {
		return nil
	}
	partitions, _ := psdisk.Partitions(true)

	var out []models.DrivePayload
	for _, e := range entries {
		label := e.Name()
		dev, err := filepath.EvalSymlinks(filepath.Join(byLabelDir(), label))
		if err != nil {
			continue
		}
		mount := ""
		for _, prt := range partitions {
			if prt.Device == dev {
				mount = prt.Mountpoint
				break
			}
		}
		if mount == "" {
			continue
		}
		usage, err := psdisk.Usage(mount)
		if err != nil {
			continue
		}
		d := models.DrivePayload{
			Label:  label,
			Device: dev,
			// Free = available to non-root; Total = Used+Free so percentages
			// exclude filesystem-reserved blocks (matches the metrics sampler).
			TotalBytes: int64(usage.Used) + int64(usage.Free),
			UsedBytes:  int64(usage.Used),
			FreeBytes:  int64(usage.Free),
		}
		d.TempCelsius = matchDriveTemp(dev, label, temps)
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
