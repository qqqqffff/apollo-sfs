package admin

import (
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	psdisk "github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/sensors"
)

// DriveStat is the live, per-drive view of a mounted storage device: real-time
// capacity/used/free read from the drive's own mount, plus its temperature when
// a matching hardware sensor is found. Online is false when the drive's mount
// could not be discovered from its filesystem label (e.g. the node is offline or
// the mount is not visible to the API container).
type DriveStat struct {
	Label       string   `json:"label"`
	MountPath   string   `json:"mount_path"`
	Device      string   `json:"device"`
	TotalBytes  int64    `json:"total_bytes"`
	UsedBytes   int64    `json:"used_bytes"`
	FreeBytes   int64    `json:"free_bytes"`
	TempCelsius *float64 `json:"temp_celsius"`
	Online      bool     `json:"online"`
}

// GetDriveStats handles GET /api/v1/admin/system/drive-stats.
// For every registered drive it auto-discovers the mount by the drive's
// filesystem label and reports live capacity/used/free plus temperature. The
// drive carrying DISK_STATS_DRIVE_LABEL is resolved to DISK_STATS_PATH (always
// readable by the container); others are discovered via /dev/disk/by-label.
// The response is keyed by drive_id. Drives whose mount can't be found are still
// returned with online=false so the UI can fall back to stored DB capacity.
func (h *Handler) GetDriveStats(c *gin.Context) {
	summaries, err := h.queries.GetDriveSummaries(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not list drives"})
		return
	}

	temps := readDriveSensors()
	stats := make(map[string]DriveStat, len(summaries))

	for _, d := range summaries {
		st := DriveStat{Label: d.DriveLabel}

		mount, device := h.resolveMount(d.DriveLabel)
		if mount != "" {
			if usage, uerr := psdisk.Usage(mount); uerr == nil {
				st.MountPath = mount
				st.Device = device
				// Free = available to non-root; Total = Used+Free so percentages
				// exclude filesystem-reserved blocks (matches the metrics sampler).
				st.FreeBytes = int64(usage.Free)
				st.TotalBytes = int64(usage.Used) + int64(usage.Free)
				st.UsedBytes = int64(usage.Used)
				st.Online = true
			}
		}
		if t := matchDriveTemp(device, d.DriveLabel, temps); t != nil {
			st.TempCelsius = t
		}
		stats[d.DriveID.String()] = st
	}

	c.JSON(http.StatusOK, gin.H{"stats": stats})
}

// resolveMount finds the mount point (and backing device) for a filesystem
// label. The drive that owns the configured DISK_STATS_DRIVE_LABEL maps directly
// to DISK_STATS_PATH — the bind mount the container is guaranteed to see. Any
// other drive is resolved through /dev/disk/by-label/<label> → device → mount.
// Returns ("", "") when nothing matches.
func (h *Handler) resolveMount(label string) (mount, device string) {
	if label == "" {
		return "", ""
	}
	if h.diskStatsLabel != "" && label == h.diskStatsLabel && h.diskStatsPath != "" {
		return h.diskStatsPath, ""
	}

	// /dev/disk/by-label/<label> is a symlink to the backing device. Labels with
	// spaces/slashes are escaped as \x20 etc. in that directory; the common
	// nvme-01 / standard-01 convention needs no escaping.
	dev, err := filepath.EvalSymlinks(filepath.Join("/dev/disk/by-label", label))
	if err != nil {
		return "", ""
	}
	partitions, err := psdisk.Partitions(true)
	if err != nil {
		return "", ""
	}
	for _, p := range partitions {
		if p.Device == dev {
			return p.Mountpoint, dev
		}
	}
	return "", ""
}

// reDevBase extracts the physical-disk token from a partition device path so a
// drive can be matched to a hardware temperature sensor, e.g.
// "/dev/nvme0n1p1" → "nvme0", "/dev/sda1" → "sda".
var reDevBase = regexp.MustCompile(`(nvme\d+|sd[a-z]+|mmcblk\d+)`)

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

// matchDriveTemp does a best-effort mapping of a drive to a temperature reading.
// It prefers a sensor whose key contains the device token (e.g. "nvme0"); if the
// device is unknown it falls back to the lone drive sensor when there is exactly
// one, so single-drive nodes still report a temperature. Returns nil otherwise.
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
