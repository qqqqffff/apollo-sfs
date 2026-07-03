package services

import (
	"context"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"apollo-sfs.com/api/models"
)

const (
	alarmCheckInterval = 5 * time.Minute
	alarmWindow        = 30 * time.Minute
	alarmCooldown      = 1 * time.Hour
)

// Default thresholds surfaced to the UI as starting values when a subscriber
// first enables an alarm. They are not enforced server-side — each subscription
// carries its own threshold.
const (
	DefaultCPUUsageThreshold  = 90.0 // percent
	DefaultCPUTempThreshold   = 75.0 // °C
	DefaultMemoryThreshold    = 90.0 // percent
	DefaultDriveTempThreshold = 50.0 // °C
	DefaultDriveLoadThreshold = 90.0 // percent of capacity
	DefaultNetworkThreshold   = 90.0 // percent of last speed test
	DefaultAPIErrorThreshold  = 5.0  // percent
)

// AlarmQuerier is the subset of *db.Queries used by AlarmService.
type AlarmQuerier interface {
	ListAlarmSubscriptions(ctx context.Context) ([]models.AlarmSubscription, error)
	GetDriveSummaries(ctx context.Context) ([]models.DriveSummary, error)
	ListNodeSnapshotsWindow(ctx context.Context, nodeID uuid.UUID, window time.Duration) ([]models.NodeMetricSnapshot, error)
	ListDriveTempsWindow(ctx context.Context, driveID uuid.UUID, window time.Duration) ([]models.DriveTempSnapshot, error)
	RecordAlarmSubscriptionFired(ctx context.Context, id uuid.UUID) error
}

// SpeedTestProvider returns the most recent speed test capacity in Mbps.
type SpeedTestProvider interface {
	LatestSpeedTestMbps() float64
}

// SpeedTestResultSnapshot carries the outcome of the most recent speed test.
type SpeedTestResultSnapshot struct {
	UploadMbps   float64
	DownloadMbps float64
	TestedAt     time.Time
	Error        string
}

// SpeedTestStreamProvider supplies the full latest speed test result for
// inclusion in WS stream broadcasts.
type SpeedTestStreamProvider interface {
	LatestSpeedTestResult() *SpeedTestResultSnapshot
}

// ── API error counter ─────────────────────────────────────────────────────────

type apiMinuteBucket struct {
	total  uint64
	errors uint64
}

// APICounter tracks API request counts in 1-minute buckets over a 30-minute
// sliding window.
type APICounter struct {
	mu      sync.Mutex
	buckets [30]apiMinuteBucket
	current int
	minute  time.Time
}

func (c *APICounter) RecordRequest(isError bool) {
	now := time.Now().UTC().Truncate(time.Minute)
	c.mu.Lock()
	defer c.mu.Unlock()

	if now.After(c.minute) {
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

// AdvanceMinutes rewinds the minute marker by n minutes (tests only).
func (c *APICounter) AdvanceMinutes(n int) {
	c.mu.Lock()
	c.minute = c.minute.Add(-time.Duration(n) * time.Minute)
	c.mu.Unlock()
}

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

type AlarmService struct {
	queries    AlarmQuerier
	email      *EmailService
	speedTest  SpeedTestProvider
	apiCounter *APICounter
}

func NewAlarmService(q AlarmQuerier, emailSvc *EmailService, speedTest SpeedTestProvider) (*AlarmService, *APICounter) {
	counter := &APICounter{minute: time.Now().UTC().Truncate(time.Minute)}
	return &AlarmService{
		queries:    q,
		email:      emailSvc,
		speedTest:  speedTest,
		apiCounter: counter,
	}, counter
}

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

// evaluate walks every subscription, computes the metric for its target, and
// fires a per-subscriber notification when the subscriber's own threshold is
// breached and its cooldown has elapsed. Per-node snapshot windows and per-drive
// temperature windows are fetched once and cached for the pass.
func (s *AlarmService) evaluate(ctx context.Context) {
	subs, err := s.queries.ListAlarmSubscriptions(ctx)
	if err != nil {
		log.Printf("alarm: list subscriptions: %v", err)
		return
	}
	if len(subs) == 0 {
		return
	}

	nodeSnaps := make(map[uuid.UUID][]models.NodeMetricSnapshot)
	driveTemps := make(map[uuid.UUID][]models.DriveTempSnapshot)
	var driveSummaries map[uuid.UUID]models.DriveSummary

	getNodeSnaps := func(id uuid.UUID) []models.NodeMetricSnapshot {
		if v, ok := nodeSnaps[id]; ok {
			return v
		}
		v, err := s.queries.ListNodeSnapshotsWindow(ctx, id, alarmWindow)
		if err != nil {
			log.Printf("alarm: node snapshots %s: %v", id, err)
		}
		nodeSnaps[id] = v
		return v
	}
	getDriveTemps := func(id uuid.UUID) []models.DriveTempSnapshot {
		if v, ok := driveTemps[id]; ok {
			return v
		}
		v, err := s.queries.ListDriveTempsWindow(ctx, id, alarmWindow)
		if err != nil {
			log.Printf("alarm: drive temps %s: %v", id, err)
		}
		driveTemps[id] = v
		return v
	}
	getDriveSummary := func(id uuid.UUID) (models.DriveSummary, bool) {
		if driveSummaries == nil {
			driveSummaries = make(map[uuid.UUID]models.DriveSummary)
			list, err := s.queries.GetDriveSummaries(ctx)
			if err != nil {
				log.Printf("alarm: drive summaries: %v", err)
			}
			for _, d := range list {
				driveSummaries[d.DriveID] = d
			}
		}
		d, ok := driveSummaries[id]
		return d, ok
	}

	for i := range subs {
		sub := subs[i]
		title, detail, fire := s.assess(&sub, getNodeSnaps, getDriveTemps, getDriveSummary)
		if fire {
			s.notify(ctx, &sub, title, detail)
		}
	}
}

// assess computes whether a single subscription is currently breached and
// returns the notification copy. It does not consult the cooldown — that is the
// caller's responsibility in notify.
func (s *AlarmService) assess(
	sub *models.AlarmSubscription,
	getNodeSnaps func(uuid.UUID) []models.NodeMetricSnapshot,
	getDriveTemps func(uuid.UUID) []models.DriveTempSnapshot,
	getDriveSummary func(uuid.UUID) (models.DriveSummary, bool),
) (title, detail string, fire bool) {
	nodeLabel := func() string {
		if sub.NodeRole != "" {
			return fmt.Sprintf("%s node %q", sub.NodeRole, sub.NodeHostname)
		}
		return fmt.Sprintf("node %q", sub.NodeHostname)
	}

	switch sub.AlarmType {
	case models.AlarmCPUUsage:
		if sub.NodeID == nil {
			return "", "", false
		}
		snaps := getNodeSnaps(*sub.NodeID)
		if len(snaps) == 0 {
			return "", "", false
		}
		avg := averageNodeCPU(snaps)
		if avg >= sub.Threshold {
			return "High CPU Usage",
				fmt.Sprintf("Average CPU usage on %s has been %.1f%% over the past 30 minutes (threshold: %.0f%%).",
					nodeLabel(), avg, sub.Threshold), true
		}

	case models.AlarmCPUTemp:
		if sub.NodeID == nil {
			return "", "", false
		}
		avg, ok := averageNodeCPUTemp(getNodeSnaps(*sub.NodeID))
		if ok && avg >= sub.Threshold {
			return "High CPU Temperature",
				fmt.Sprintf("Average CPU temperature on %s has been %.1f°C over the past 30 minutes (threshold: %.0f°C).",
					nodeLabel(), avg, sub.Threshold), true
		}

	case models.AlarmMemory:
		if sub.NodeID == nil {
			return "", "", false
		}
		avg, ok := averageNodeMemoryPct(getNodeSnaps(*sub.NodeID))
		if ok && avg >= sub.Threshold {
			return "High Memory Usage",
				fmt.Sprintf("Average memory usage on %s has been %.1f%% over the past 30 minutes (threshold: %.0f%%).",
					nodeLabel(), avg, sub.Threshold), true
		}

	case models.AlarmNetworkTraffic:
		if sub.NodeID == nil {
			return "", "", false
		}
		snaps := getNodeSnaps(*sub.NodeID)
		capacityMbps := s.speedTest.LatestSpeedTestMbps()
		if len(snaps) < 2 || capacityMbps <= 0 {
			return "", "", false
		}
		avgMbps := averageNodeNetworkMbps(snaps)
		if avgMbps >= capacityMbps*(sub.Threshold/100) {
			return "High Network Traffic",
				fmt.Sprintf("Average network throughput on %s has been %.1f Mbps over the past 30 minutes, %.1f%% of the measured capacity (%.1f Mbps; threshold: %.0f%%).",
					nodeLabel(), avgMbps, (avgMbps/capacityMbps)*100, capacityMbps, sub.Threshold), true
		}

	case models.AlarmDriveTemp:
		if sub.DriveID == nil {
			return "", "", false
		}
		avg, ok := averageDriveTemp(getDriveTemps(*sub.DriveID))
		if ok && avg >= sub.Threshold {
			return "High Drive Temperature",
				fmt.Sprintf("Average temperature of drive %q on server %q has been %.1f°C over the past 30 minutes (threshold: %.0f°C).",
					sub.DriveLabel, sub.ServerName, avg, sub.Threshold), true
		}

	case models.AlarmDriveLoad:
		if sub.DriveID == nil {
			return "", "", false
		}
		d, ok := getDriveSummary(*sub.DriveID)
		if !ok || !d.DriveIsActive || d.CapacityBytes <= 0 {
			return "", "", false
		}
		load := float64(d.AllocatedQuotaBytes) / float64(d.CapacityBytes) * 100
		if load >= sub.Threshold {
			return "High Drive Load",
				fmt.Sprintf("Drive %q on server %q is at %.1f%% allocated capacity (threshold: %.0f%%).",
					d.DriveLabel, d.ServerName, load, sub.Threshold), true
		}

	case models.AlarmAPIErrorRate:
		rate := s.apiCounter.ErrorRate() * 100
		if rate >= sub.Threshold {
			return "Elevated API Error Rate",
				fmt.Sprintf("%.1f%% of API requests in the past 30 minutes returned a server error (threshold: %.0f%%).",
					rate, sub.Threshold), true
		}
	}
	return "", "", false
}

// notify respects the per-subscription cooldown, sends the email to the single
// subscriber, and stamps last_fired_at.
func (s *AlarmService) notify(ctx context.Context, sub *models.AlarmSubscription, title, detail string) {
	if sub.LastFiredAt != nil && time.Since(*sub.LastFiredAt) < alarmCooldown {
		return
	}

	log.Printf("alarm: firing %q for %s — %s", sub.AlarmType, sub.Email, detail)
	if err := s.email.SendAlarmNotification(ctx, []string{sub.Email}, title, detail); err != nil {
		log.Printf("alarm: send notification for %q: %v", sub.AlarmType, err)
	}
	if err := s.queries.RecordAlarmSubscriptionFired(ctx, sub.ID); err != nil {
		log.Printf("alarm: record fired for %s: %v", sub.ID, err)
	}
}

// ── Metric aggregation helpers ────────────────────────────────────────────────

func averageNodeCPU(snaps []models.NodeMetricSnapshot) float64 {
	var sum float64
	for i := range snaps {
		sum += snaps[i].CPUPercent
	}
	return sum / float64(len(snaps))
}

func averageNodeCPUTemp(snaps []models.NodeMetricSnapshot) (float64, bool) {
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

func averageNodeMemoryPct(snaps []models.NodeMetricSnapshot) (float64, bool) {
	var sum float64
	var n int
	for i := range snaps {
		if snaps[i].MemoryTotalBytes > 0 {
			sum += float64(snaps[i].MemoryUsedBytes) / float64(snaps[i].MemoryTotalBytes) * 100
			n++
		}
	}
	if n == 0 {
		return 0, false
	}
	return sum / float64(n), true
}

func averageDriveTemp(snaps []models.DriveTempSnapshot) (float64, bool) {
	if len(snaps) == 0 {
		return 0, false
	}
	var sum float64
	for i := range snaps {
		sum += snaps[i].TempCelsius
	}
	return sum / float64(len(snaps)), true
}

func averageNodeNetworkMbps(snaps []models.NodeMetricSnapshot) float64 {
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
			sentDelta = 0
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
