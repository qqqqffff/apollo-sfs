package admin

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/shirou/gopsutil/v4/sensors"
)

// DriveTemp is one sensor reading for a storage device.
type DriveTemp struct {
	Name        string  `json:"name"`
	TempCelsius float64 `json:"temp_celsius"`
}

// GetDriveTemps handles GET /admin/system/drive-temps.
// Returns live temperature readings for all storage devices (NVMe, SATA, etc.)
// found in the host's hardware sensors. Returns an empty array when no drive
// sensors are accessible.
func (h *Handler) GetDriveTemps(c *gin.Context) {
	readings, err := sensors.SensorsTemperatures()
	if err != nil {
		c.JSON(http.StatusOK, []DriveTemp{})
		return
	}

	temps := []DriveTemp{}
	for _, s := range readings {
		if s.Temperature <= 0 {
			continue
		}
		key := strings.ToLower(s.SensorKey)
		if strings.Contains(key, "nvme") ||
			strings.Contains(key, "drivetemp") ||
			strings.Contains(key, "sda") ||
			strings.Contains(key, "sdb") ||
			strings.Contains(key, "sdc") ||
			strings.Contains(key, "sdd") {
			temps = append(temps, DriveTemp{
				Name:        s.SensorKey,
				TempCelsius: s.Temperature,
			})
		}
	}

	c.JSON(http.StatusOK, temps)
}
