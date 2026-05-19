package services

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	psdisk "github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
	psnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/sensors"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

const (
	metricsSampleInterval = 5 * time.Second
	metricsPruneInterval  = 24 * time.Hour
	metricsRetention      = 7 * 24 * time.Hour
	hubChannelBuffer      = 64
	pingTarget            = "8.8.8.8"
	pingInterval          = 30 * time.Second
)

var (
	rePktLoss = regexp.MustCompile(`(\d+(?:\.\d+)?)% packet loss`)
	reRTTAvg  = regexp.MustCompile(`rtt min/avg/max/mdev = [\d.]+/([\d.]+)/`)
)

// pingResult holds the most recent ISP ping measurement.
type pingResult struct {
	pingMs     *float64
	packetLoss *float64
}

// pingCollector runs periodic ICMP pings to a public DNS address and stores
// the latest average RTT and packet-loss percentage. Results are nil when ping
// is unavailable (missing capability, network unreachable, etc.).
type pingCollector struct {
	mu     sync.RWMutex
	latest pingResult
}

func (p *pingCollector) run(ctx context.Context) {
	p.collect() // populate immediately so the first snapshot has data
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.collect()
		}
	}
}

func (p *pingCollector) collect() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// -c 5: 5 probes  -i 0.2: 200 ms between probes  -W 1: 1 s deadline  -q: quiet (summary only)
	out, err := exec.CommandContext(ctx, "ping", "-c", "5", "-i", "0.2", "-W", "1", "-q", pingTarget).Output()
	if err != nil {
		p.mu.Lock()
		p.latest = pingResult{}
		p.mu.Unlock()
		return
	}
	pingMs, packetLoss := parsePingOutput(string(out))
	p.mu.Lock()
	p.latest = pingResult{pingMs: pingMs, packetLoss: packetLoss}
	p.mu.Unlock()
}

// parsePingOutput extracts the average RTT (ms) and packet-loss percentage from
// Linux ping summary output. Either value is nil when its pattern is absent.
func parsePingOutput(out string) (pingMs, packetLoss *float64) {
	if m := rePktLoss.FindStringSubmatch(out); len(m) == 2 {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			packetLoss = &v
		}
	}
	if m := reRTTAvg.FindStringSubmatch(out); len(m) == 2 {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			pingMs = &v
		}
	}
	return
}

func (p *pingCollector) get() pingResult {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.latest
}

// ── WebSocket hub ─────────────────────────────────────────────────────────────

// Hub manages active WebSocket subscriber channels. The metrics sampler calls
// Broadcast after every snapshot; each connected admin client receives a copy.
type Hub struct {
	mu      sync.Mutex
	clients map[chan []byte]struct{}
}

func newHub() *Hub {
	return &Hub{clients: make(map[chan []byte]struct{})}
}

// Subscribe registers a new client and returns its receive channel.
// The caller must call Unsubscribe when the WebSocket connection closes.
func (h *Hub) Subscribe() chan []byte {
	ch := make(chan []byte, hubChannelBuffer)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

// Unsubscribe removes a client channel and closes it.
func (h *Hub) Unsubscribe(ch chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[ch]; ok {
		delete(h.clients, ch)
		close(ch)
	}
}

// Broadcast sends msg to every registered client. Slow clients are skipped
// rather than blocked — they will miss individual frames but stay connected.
func (h *Hub) Broadcast(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		select {
		case ch <- msg:
		default:
			// client channel full — drop this frame for that client
		}
	}
}

// ClientCount returns the number of currently connected WebSocket clients.
func (h *Hub) ClientCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

// ── Service ───────────────────────────────────────────────────────────────────

// MetricsService samples system and app metrics every 5 seconds, persists each
// snapshot to the DB, and broadcasts it to all active WebSocket clients. A
// separate daily goroutine prunes rows older than 7 days.
type MetricsService struct {
	queries          *db.Queries
	hub              *Hub
	diskStatsPath    string
	ping             *pingCollector
	speedTestMu      sync.RWMutex
	speedTestStream  SpeedTestStreamProvider
}

// NewMetricsService constructs a MetricsService.
// diskStatsPath is the filesystem path used to report disk capacity — it should
// be the mount point of the storage volume (e.g. "/mnt/data").
func NewMetricsService(q *db.Queries, diskStatsPath string) *MetricsService {
	return &MetricsService{
		queries:       q,
		hub:           newHub(),
		diskStatsPath: diskStatsPath,
		ping:          &pingCollector{},
	}
}

// Hub returns the WebSocket hub so the route handler can register clients.
func (s *MetricsService) Hub() *Hub {
	return s.hub
}

// SetSpeedTestProvider wires in the speed test source so each WS broadcast
// includes the latest result.
func (s *MetricsService) SetSpeedTestProvider(p SpeedTestStreamProvider) {
	s.speedTestMu.Lock()
	s.speedTestStream = p
	s.speedTestMu.Unlock()
}

// Start launches the sampling and pruning goroutines. Returns when ctx is cancelled.
func (s *MetricsService) Start(ctx context.Context) {
	log.Printf("metrics: started (sample every %s, retain %s)",
		metricsSampleInterval, metricsRetention)

	go s.runSampler(ctx)
	go s.runPruner(ctx)
	go s.ping.run(ctx)
}

// ── Query helpers (used by admin REST handlers) ───────────────────────────────

// GetLatest returns the most recently persisted snapshot.
func (s *MetricsService) GetLatest(ctx context.Context) (*models.ServerMetricSnapshot, error) {
	return s.queries.GetLatestSnapshot(ctx)
}

// GetHistory returns a cursor-paginated list of snapshots, newest first.
func (s *MetricsService) GetHistory(ctx context.Context, page db.PageInput) (*db.PageResult[models.ServerMetricSnapshot], error) {
	return s.queries.ListSnapshots(ctx, page)
}

// GetHistoryByHours returns ~120 evenly-distributed snapshots from the past
// hours hours, ordered oldest-first. Used by the admin line graph.
func (s *MetricsService) GetHistoryByHours(ctx context.Context, hours int) ([]models.ServerMetricSnapshot, error) {
	return s.queries.ListSnapshotsByHours(ctx, hours, 120)
}

// GetHistoryByDate returns snapshots for a specific day in mm-dd-yyyy format.
func (s *MetricsService) GetHistoryByDate(ctx context.Context, date string, page db.PageInput) (*db.PageResult[models.ServerMetricSnapshot], error) {
	return s.queries.ListSnapshotsByDate(ctx, date, page)
}

// ── Goroutines ────────────────────────────────────────────────────────────────

func (s *MetricsService) runSampler(ctx context.Context) {
	ticker := time.NewTicker(metricsSampleInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			snap, err := s.collectSnapshot(ctx)
			if err != nil {
				log.Printf("metrics: collect: %v", err)
				continue
			}
			if err := s.queries.InsertSnapshot(ctx, snap); err != nil {
				log.Printf("metrics: insert: %v", err)
				continue
			}
			if s.hub.ClientCount() > 0 {
				s.speedTestMu.RLock()
				st := s.speedTestStream
				s.speedTestMu.RUnlock()
				if st != nil {
					if result := st.LatestSpeedTestResult(); result != nil {
						snap.SpeedTestUploadMbps = &result.UploadMbps
						snap.SpeedTestDownloadMbps = &result.DownloadMbps
						snap.SpeedTestTestedAt = &result.TestedAt
						snap.SpeedTestError = result.Error
					}
				}
				if msg, err := json.Marshal(snap); err == nil {
					s.hub.Broadcast(msg)
				}
			}
		}
	}
}

func (s *MetricsService) runPruner(ctx context.Context) {
	ticker := time.NewTicker(metricsPruneInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cutoff := time.Now().UTC().Add(-metricsRetention)
			if err := s.queries.PruneOldSnapshots(ctx, cutoff); err != nil {
				log.Printf("metrics: prune: %v", err)
			}
		}
	}
}

// ── Snapshot collection ───────────────────────────────────────────────────────

// collectTemperatures reads hardware sensor data and returns the best available
// CPU and drive temperatures. Either value may be nil if no suitable sensor is
// found or the OS does not expose temperature data.
func collectTemperatures() (cpuTemp, driveTemp *float64) {
	readings, err := sensors.SensorsTemperatures()
	if err != nil {
		return nil, nil
	}
	for i := range readings {
		s := &readings[i]
		if s.Temperature <= 0 {
			continue
		}
		key := strings.ToLower(s.SensorKey)
		if cpuTemp == nil && (strings.Contains(key, "coretemp") ||
			strings.Contains(key, "k10temp") ||
			strings.Contains(key, "package id") ||
			strings.Contains(key, "tctl") ||
			strings.Contains(key, "cpu")) {
			t := s.Temperature
			cpuTemp = &t
		}
		if driveTemp == nil && (strings.Contains(key, "drivetemp") ||
			strings.Contains(key, "nvme") ||
			strings.Contains(key, "sda") ||
			strings.Contains(key, "sdb")) {
			t := s.Temperature
			driveTemp = &t
		}
		if cpuTemp != nil && driveTemp != nil {
			break
		}
	}
	return cpuTemp, driveTemp
}

func (s *MetricsService) collectSnapshot(ctx context.Context) (*models.ServerMetricSnapshot, error) {
	sys, err := collectSystem()
	if err != nil {
		return nil, err
	}

	app, err := s.queries.GetUserStats(ctx)
	if err != nil {
		return nil, err
	}

	var diskTotal, diskFree int64
	if usage, err := psdisk.Usage(s.diskStatsPath); err == nil {
		diskTotal = int64(usage.Total)
		diskFree = int64(usage.Free)
	} else {
		log.Printf("metrics: disk stats for %q: %v", s.diskStatsPath, err)
	}

	cpuTemp, driveTemp := collectTemperatures()
	pingData := s.ping.get()

	return &models.ServerMetricSnapshot{
		CPUPercent:                 sys.cpuPercent,
		MemoryUsedBytes:            sys.memUsed,
		MemoryTotalBytes:           sys.memTotal,
		NetworkBytesSent:           sys.netSent,
		NetworkBytesRecv:           sys.netRecv,
		StorageTotalUsedBytes:      minioStorageBytes("../minio"),
		StorageTotalQuotaBytes:     app.StorageQuotaBytes,
		DiskTotalBytes:             diskTotal,
		DiskFreeBytes:              diskFree,
		ActiveUserCount:            app.ActiveUsersLast5m,
		TotalUserCount:             app.TotalUsers,
		SampledAt:                  time.Now().UTC(),
		CPUTempCelsius:             cpuTemp,
		DriveTempCelsius:           driveTemp,
		ServerISPPingMs:            pingData.pingMs,
		ServerISPPacketLossPercent: pingData.packetLoss,
	}, nil
}

// minioStorageBytes walks dir and sums the sizes of all regular files.
// Unreadable entries are skipped so a permission error never fails a metric sample.
func minioStorageBytes(dir string) int64 {
	var total int64
	_ = filepath.Walk(dir, func(_ string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		total += info.Size()
		return nil
	})
	return total
}

// sysMetrics holds the raw gopsutil readings for one sample.
type sysMetrics struct {
	cpuPercent float64
	memUsed    int64
	memTotal   int64
	netSent    int64
	netRecv    int64
}

// collectSystem reads CPU, memory, and network counters from the OS.
// CPU percent is computed since the previous call (non-blocking, interval=0).
func collectSystem() (*sysMetrics, error) {
	// CPU — percent utilisation since last call; returns one value for all CPUs combined.
	cpuPcts, err := cpu.Percent(0, false)
	if err != nil {
		return nil, err
	}
	var cpuPct float64
	if len(cpuPcts) > 0 {
		cpuPct = cpuPcts[0]
	}

	// Memory.
	vmem, err := mem.VirtualMemory()
	if err != nil {
		return nil, err
	}

	// Network I/O counters — false = aggregate all interfaces into one entry.
	iocs, err := psnet.IOCounters(false)
	if err != nil {
		return nil, err
	}
	var netSent, netRecv uint64
	if len(iocs) > 0 {
		netSent = iocs[0].BytesSent
		netRecv = iocs[0].BytesRecv
	}

	return &sysMetrics{
		cpuPercent: cpuPct,
		memUsed:    int64(vmem.Used),
		memTotal:   int64(vmem.Total),
		netSent:    int64(netSent),
		netRecv:    int64(netRecv),
	}, nil
}
