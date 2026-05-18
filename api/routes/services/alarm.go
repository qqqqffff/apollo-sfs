package services

import (
	"context"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"apollo-sfs.com/api/models"
)

const (
	alarmCheckInterval = 5 * time.Minute
	alarmWindow        = 30 * time.Minute
	alarmCooldown      = 1 * time.Hour

	// Sustained-threshold fractions
	cpuUsageThreshold    = 90.0 // percent
	cpuTempThreshold     = 75.0 // °C
	driveTempThreshold   = 50.0 // °C
	driveLoadThreshold   = 0.90 // fraction of capacity
	networkThreshold     = 0.90 // fraction of last speed test
	apiErrorRateThresh   = 0.05 // 5 %
)

// AlarmQuerier is the subset of *db.Queries used by AlarmService.
type AlarmQuerier interface {
	GetAlarmSettings(ctx context.Context) (*models.AlarmSettings, error)
	GetDriveSummaries(ctx context.Context) ([]models.DriveSummary, error)
	ListSnapshotsWindow(ctx context.Context, window time.Duration) ([]models.ServerMetricSnapshot, error)
}

// SpeedTestProvider returns the most recent speed test capacity in Mbps.
// Returns 0 when no test has run or the last test failed.
type SpeedTestProvider interface {
	LatestSpeedTestMbps() float64
}

// ── API error counter ─────────────────────────────────────────────────────────

// apiMinuteBucket holds per-minute request counts.
type apiMinuteBucket struct {
	total  uint64
	errors uint64
}

// APICounter tracks API request counts in 1-minute buckets over a 30-minute
// sliding window. Call RecordRequest from an HTTP middleware after each
// response so the alarm service can measure the server error rate.
type APICounter struct {
	mu      sync.Mutex
	buckets [30]apiMinuteBucket
	current int       // index of the current-minute bucket
	minute  time.Time // start of the current minute (truncated)
}

// RecordRequest increments the total request count and, when isError is true,
// the error count for the current minute bucket.
func (c *APICounter) RecordRequest(isError bool) {
	now := time.Now().UTC().Truncate(time.Minute)
	c.mu.Lock()
	defer c.mu.Unlock()

	if now.After(c.minute) {
		// Advance to new minute(s), clearing stale buckets.
		steps := int(now.Sub(c.minute).Minutes())
		if steps > len(c.buckets) {
			steps = len(c.buckets)
		}
		for i := 0; i < steps; i++ {
			c.current = (c.current + 1) % len(c.buckets)
			c.buckets[c.current] = apiMinuteBucket{}
		}
		c.minute = now
	}

	atomic.AddUint64(&c.buckets[c.current].total, 1)
	if isError {
		atomic.AddUint64(&c.buckets[c.current].errors, 1)
	}
}

// AdvanceMinutes simulates the passage of n minutes by rewinding the current
// minute marker. Used only in tests to exercise bucket rotation without
// sleeping.
func (c *APICounter) AdvanceMinutes(n int) {
	c.mu.Lock()
	c.minute = c.minute.Add(-time.Duration(n) * time.Minute)
	c.mu.Unlock()
}

// ErrorRate returns the fraction of requests in the sliding window that were
// server errors. Returns 0 if no requests were recorded.
func (c *APICounter) ErrorRate() float64 {
	c.mu.Lock()
	defer c.mu.Unlock()

	var total, errors uint64
	for i := range c.buckets {
		total += c.buckets[i].total
		errors += c.buckets[i].errors
	}
	if total == 0 {
		return 0
	}
	return float64(errors) / float64(total)
}

// ── Alarm service ─────────────────────────────────────────────────────────────

// AlarmService evaluates sustained system-health conditions every 5 minutes
// and sends email notifications when a threshold is crossed. Each alarm type
// has a 1-hour cooldown to prevent notification spam.
type AlarmService struct {
	queries    AlarmQuerier
	email      *EmailService
	speedTest  SpeedTestProvider
	apiCounter *APICounter

	// lastFiredAt tracks the last time each named alarm sent a notification.
	mu          sync.Mutex
	lastFiredAt map[string]time.Time
}

// NewAlarmService constructs an AlarmService.
func NewAlarmService(q AlarmQuerier, emailSvc *EmailService, speedTest SpeedTestProvider) (*AlarmService, *APICounter) {
	counter := &APICounter{minute: time.Now().UTC().Truncate(time.Minute)}
	return &AlarmService{
		queries:     q,
		email:       emailSvc,
		speedTest:   speedTest,
		apiCounter:  counter,
		lastFiredAt: make(map[string]time.Time),
	}, counter
}

// Start launches the alarm evaluation loop. Returns when ctx is cancelled.
func (s *AlarmService) Start(ctx context.Context) {
	log.Printf("alarm service: started (check every %s, cooldown %s)", alarmCheckInterval, alarmCooldown)
	ticker := time.NewTicker(alarmCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.evaluate(ctx)
		}
	}
}

// evaluate runs one alarm check cycle.
func (s *AlarmService) evaluate(ctx context.Context) {
	settings, err := s.queries.GetAlarmSettings(ctx)
	if err != nil {
		log.Printf("alarm: load settings: %v", err)
		return
	}
	if len(settings.NotifyEmails) == 0 {
		return // nowhere to send — skip all checks
	}

	snaps, err := s.queries.ListSnapshotsWindow(ctx, alarmWindow)
	if err != nil {
		log.Printf("alarm: list snapshots: %v", err)
		return
	}

	drives, err := s.queries.GetDriveSummaries(ctx)
	if err != nil {
		log.Printf("alarm: get drive summaries: %v", err)
	}

	s.checkCPUUsage(ctx, settings, snaps)
	s.checkCPUTemp(ctx, settings, snaps)
	s.checkDriveTemp(ctx, settings, snaps)
	s.checkDriveLoad(ctx, settings, drives)
	s.checkNetworkTraffic(ctx, settings, snaps)
	s.checkAPIErrorRate(ctx, settings)
}

// ── Individual alarm checks ───────────────────────────────────────────────────

func (s *AlarmService) checkCPUUsage(ctx context.Context, cfg *models.AlarmSettings, snaps []models.ServerMetricSnapshot) {
	if !cfg.CPUUsageEnabled || len(snaps) == 0 {
		return
	}
	avg := averageCPU(snaps)
	if avg >= cpuUsageThreshold {
		s.maybeNotify(ctx, "cpu_usage", cfg.NotifyEmails,
			"High CPU Usage",
			fmt.Sprintf("Average CPU usage has been %.1f%% over the past 30 minutes (threshold: %.0f%%).", avg, cpuUsageThreshold),
		)
	}
}

func (s *AlarmService) checkCPUTemp(ctx context.Context, cfg *models.AlarmSettings, snaps []models.ServerMetricSnapshot) {
	if !cfg.CPUTempEnabled || len(snaps) == 0 {
		return
	}
	avg, ok := averageCPUTemp(snaps)
	if !ok {
		return // no temperature data available
	}
	if avg >= cpuTempThreshold {
		s.maybeNotify(ctx, "cpu_temp", cfg.NotifyEmails,
			"High CPU Temperature",
			fmt.Sprintf("Average CPU temperature has been %.1f°C over the past 30 minutes (threshold: %.0f°C).", avg, cpuTempThreshold),
		)
	}
}

func (s *AlarmService) checkDriveTemp(ctx context.Context, cfg *models.AlarmSettings, snaps []models.ServerMetricSnapshot) {
	if !cfg.DriveTempEnabled || len(snaps) == 0 {
		return
	}
	avg, ok := averageDriveTemp(snaps)
	if !ok {
		return
	}
	if avg >= driveTempThreshold {
		s.maybeNotify(ctx, "drive_temp", cfg.NotifyEmails,
			"High Drive Temperature",
			fmt.Sprintf("Average drive temperature has been %.1f°C over the past 30 minutes (threshold: %.0f°C).", avg, driveTempThreshold),
		)
	}
}

func (s *AlarmService) checkDriveLoad(ctx context.Context, cfg *models.AlarmSettings, drives []models.DriveSummary) {
	if !cfg.DriveLoadEnabled || len(drives) == 0 {
		return
	}
	for _, d := range drives {
		if !d.DriveIsActive || d.CapacityBytes <= 0 {
			continue
		}
		load := float64(d.AllocatedQuotaBytes) / float64(d.CapacityBytes)
		if load >= driveLoadThreshold {
			s.maybeNotify(ctx, "drive_load_"+d.DriveID.String(), cfg.NotifyEmails,
				"High Drive Load",
				fmt.Sprintf("Drive \"%s\" on server \"%s\" is at %.1f%% allocated capacity (threshold: %.0f%%).",
					d.DriveLabel, d.ServerName, load*100, driveLoadThreshold*100),
			)
		}
	}
}

func (s *AlarmService) checkNetworkTraffic(ctx context.Context, cfg *models.AlarmSettings, snaps []models.ServerMetricSnapshot) {
	if !cfg.NetworkTrafficEnabled || len(snaps) < 2 {
		return
	}
	capacityMbps := s.speedTest.LatestSpeedTestMbps()
	if capacityMbps <= 0 {
		return // no speed test baseline
	}
	avgMbps := averageNetworkMbps(snaps)
	if avgMbps >= capacityMbps*networkThreshold {
		s.maybeNotify(ctx, "network_traffic", cfg.NotifyEmails,
			"High Network Traffic",
			fmt.Sprintf("Average network throughput has been %.1f Mbps over the past 30 minutes, which is %.1f%% of the measured capacity (%.1f Mbps).",
				avgMbps, (avgMbps/capacityMbps)*100, capacityMbps),
		)
	}
}

func (s *AlarmService) checkAPIErrorRate(ctx context.Context, cfg *models.AlarmSettings) {
	if !cfg.APIErrorRateEnabled {
		return
	}
	rate := s.apiCounter.ErrorRate()
	if rate >= apiErrorRateThresh {
		s.maybeNotify(ctx, "api_error_rate", cfg.NotifyEmails,
			"Elevated API Error Rate",
			fmt.Sprintf("%.1f%% of API requests in the past 30 minutes returned a server error (threshold: %.0f%%).",
				rate*100, apiErrorRateThresh*100),
		)
	}
}

// ── Notification helper ───────────────────────────────────────────────────────

// maybeNotify sends an alarm email only if the cooldown has expired for key.
func (s *AlarmService) maybeNotify(ctx context.Context, key string, emails []string, title, detail string) {
	s.mu.Lock()
	last := s.lastFiredAt[key]
	if time.Since(last) < alarmCooldown {
		s.mu.Unlock()
		return
	}
	s.lastFiredAt[key] = time.Now()
	s.mu.Unlock()

	log.Printf("alarm: firing %q — %s", key, detail)
	if err := s.email.SendAlarmNotification(ctx, emails, title, detail); err != nil {
		log.Printf("alarm: send notification for %q: %v", key, err)
	}
}

// ── Metric aggregation helpers ────────────────────────────────────────────────

func averageCPU(snaps []models.ServerMetricSnapshot) float64 {
	var sum float64
	for i := range snaps {
		sum += snaps[i].CPUPercent
	}
	return sum / float64(len(snaps))
}

func averageCPUTemp(snaps []models.ServerMetricSnapshot) (float64, bool) {
	var sum float64
	var n int
	for i := range snaps {
		if snaps[i].CPUTempCelsius != nil {
			sum += *snaps[i].CPUTempCelsius
			n++
		}
	}
	if n == 0 {
		return 0, false
	}
	return sum / float64(n), true
}

func averageDriveTemp(snaps []models.ServerMetricSnapshot) (float64, bool) {
	var sum float64
	var n int
	for i := range snaps {
		if snaps[i].DriveTempCelsius != nil {
			sum += *snaps[i].DriveTempCelsius
			n++
		}
	}
	if n == 0 {
		return 0, false
	}
	return sum / float64(n), true
}

// averageNetworkMbps computes the mean throughput (max of sent/recv per interval)
// across all consecutive snapshot pairs in the window.
func averageNetworkMbps(snaps []models.ServerMetricSnapshot) float64 {
	if len(snaps) < 2 {
		return 0
	}
	var sum float64
	var n int
	for i := 1; i < len(snaps); i++ {
		dt := snaps[i].SampledAt.Sub(snaps[i-1].SampledAt).Seconds()
		if dt <= 0 {
			continue
		}
		sentDelta := snaps[i].NetworkBytesSent - snaps[i-1].NetworkBytesSent
		recvDelta := snaps[i].NetworkBytesRecv - snaps[i-1].NetworkBytesRecv
		if sentDelta < 0 {
			sentDelta = 0 // counter reset (reboot)
		}
		if recvDelta < 0 {
			recvDelta = 0
		}
		sentMbps := float64(sentDelta) / dt * 8 / (1024 * 1024)
		recvMbps := float64(recvDelta) / dt * 8 / (1024 * 1024)
		mbps := sentMbps
		if recvMbps > mbps {
			mbps = recvMbps
		}
		sum += mbps
		n++
	}
	if n == 0 {
		return 0
	}
	return sum / float64(n)
}
