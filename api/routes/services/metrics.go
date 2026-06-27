package services

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
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
	// Matches both iputils-ping ("rtt min/avg/max/mdev = ...") and
	// busybox ping ("round-trip min/avg/max = ..."). Average is the 2nd field.
	reRTTAvg = regexp.MustCompile(`(?:rtt|round-trip) min/avg/max(?:/mdev)? = [\d.]+/([\d.]+)/`)
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
	// -c 4: 4 probes  -W 2: 2 s deadline per probe  -q: quiet (summary only)
	// No -i flag: busybox ping rejects fractional intervals, so we use the
	// default 1-second interval which works on both busybox and iputils-ping.
	out, err := exec.CommandContext(ctx, "ping", "-c", "4", "-W", "2", "-q", pingTarget).Output()
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
	queries         *db.Queries
	hub             *Hub
	diskStatsPath   string
	ping            *pingCollector
	speedTestMu     sync.RWMutex
	speedTestStream SpeedTestStreamProvider

	// nodeState holds the latest hardware frame pushed by each node's agent,
	// keyed by node_id. Merged into every WS broadcast and served to the live
	// drive-stats endpoint. A node drops to Online=false once its last push ages
	// past nodeStaleAfter.
	nodeMu    sync.RWMutex
	nodeState map[uuid.UUID]models.NodeFrame
}

// nodeStaleAfter is how long after a node's last push it is still considered
// online. Agents push every ~5s, so 20s tolerates a few missed samples.
const nodeStaleAfter = 20 * time.Second

// NewMetricsService constructs a MetricsService.
// diskStatsPath is the filesystem path used to report disk capacity — it should
// be the mount point of the storage volume (e.g. "/mnt/data").
func NewMetricsService(q *db.Queries, diskStatsPath string) *MetricsService {
	return &MetricsService{
		queries:       q,
		hub:           newHub(),
		diskStatsPath: diskStatsPath,
		ping:          &pingCollector{},
		nodeState:     make(map[uuid.UUID]models.NodeFrame),
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

// GetNodeHistoryByHours returns ~120 evenly-distributed hardware snapshots for
// one node from the past hours hours, oldest-first. Backs the per-node graphs.
func (s *MetricsService) GetNodeHistoryByHours(ctx context.Context, nodeID uuid.UUID, hours int) ([]models.NodeMetricSnapshot, error) {
	return s.queries.ListNodeSnapshotsByHours(ctx, nodeID, hours, 120)
}

// GetDriveTempHistoryByHours returns ~120 evenly-distributed temperature
// readings for one drive from the past hours hours, oldest-first. Backs the
// drive-temperature carousel graph.
func (s *MetricsService) GetDriveTempHistoryByHours(ctx context.Context, driveID uuid.UUID, hours int) ([]models.DriveTempSnapshot, error) {
	return s.queries.ListDriveTempsByHours(ctx, driveID, hours, 120)
}

// ── Per-node hardware aggregation ──────────────────────────────────────────────

// UpdateNodeMetrics ingests a hardware push from a node's agent: it resolves the
// reporting hostname to a node, persists the node snapshot and any drive
// temperatures, and updates the in-memory frame merged into WS broadcasts.
// Pushes from unregistered hostnames are logged and ignored (no error) so an
// unconfigured agent never disrupts the stream.
func (s *MetricsService) UpdateNodeMetrics(ctx context.Context, p *models.NodeMetricsPayload) error {
	node, err := s.queries.GetNodeByHostname(ctx, p.Hostname)
	if err != nil {
		return err
	}
	if node == nil {
		log.Printf("metrics: node-metrics push from unknown hostname %q (ignored)", p.Hostname)
		return nil
	}

	now := time.Now().UTC()
	snap := &models.NodeMetricSnapshot{
		NodeID:           node.ID,
		CPUPercent:       p.CPUPercent,
		CPUTempCelsius:   p.CPUTempCelsius,
		MemoryUsedBytes:  p.MemoryUsedBytes,
		MemoryTotalBytes: p.MemoryTotalBytes,
		NetworkBytesSent: p.NetworkBytesSent,
		NetworkBytesRecv: p.NetworkBytesRecv,
		SampledAt:        now,
	}
	if err := s.queries.InsertNodeSnapshot(ctx, snap); err != nil {
		log.Printf("metrics: insert node snapshot: %v", err)
	}

	// Map reported drive labels to registered drives on this node so the frame
	// carries each drive's UUID and tier. Unregistered labels are skipped.
	summaries, err := s.queries.GetDriveSummaries(ctx)
	if err != nil {
		log.Printf("metrics: drive summaries for node push: %v", err)
	}
	byLabel := make(map[string]models.DriveSummary)
	for _, d := range summaries {
		if d.NodeID != nil && *d.NodeID == node.ID {
			byLabel[d.DriveLabel] = d
		}
	}

	drives := make([]models.DriveFrame, 0, len(p.Drives))
	for _, dp := range p.Drives {
		sum, ok := byLabel[dp.Label]
		if !ok {
			continue
		}
		drives = append(drives, models.DriveFrame{
			DriveID:     sum.DriveID,
			Label:       sum.DriveLabel,
			DriveType:   sum.DriveType,
			TempCelsius: dp.TempCelsius,
			TotalBytes:  dp.TotalBytes,
			UsedBytes:   dp.UsedBytes,
			FreeBytes:   dp.FreeBytes,
		})
		if dp.TempCelsius != nil {
			if err := s.queries.InsertDriveTemp(ctx, sum.DriveID, *dp.TempCelsius, now); err != nil {
				log.Printf("metrics: insert drive temp: %v", err)
			}
		}
	}

	frame := models.NodeFrame{
		NodeID:           node.ID,
		Hostname:         node.Hostname,
		Role:             node.Role,
		IsActive:         node.IsActive,
		Online:           true,
		CPUPercent:       p.CPUPercent,
		CPUTempCelsius:   p.CPUTempCelsius,
		MemoryUsedBytes:  p.MemoryUsedBytes,
		MemoryTotalBytes: p.MemoryTotalBytes,
		NetworkBytesSent: p.NetworkBytesSent,
		NetworkBytesRecv: p.NetworkBytesRecv,
		SampledAt:        now,
		Drives:           drives,
	}
	s.nodeMu.Lock()
	s.nodeState[node.ID] = frame
	s.nodeMu.Unlock()
	return nil
}

// NodeStates returns a stable, hostname-sorted snapshot of every node that has
// reported at least once. Online is recomputed from each frame's age so a node
// whose agent has gone silent still appears (with Online=false) for the UI.
func (s *MetricsService) NodeStates() []models.NodeFrame {
	s.nodeMu.RLock()
	defer s.nodeMu.RUnlock()
	now := time.Now().UTC()
	out := make([]models.NodeFrame, 0, len(s.nodeState))
	for _, f := range s.nodeState {
		f.Online = now.Sub(f.SampledAt) < nodeStaleAfter
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Hostname < out[j].Hostname })
	return out
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
			// Populate the latest speed test result before inserting so it is
			// persisted to the DB and available in historical graph queries.
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
			if err := s.queries.InsertSnapshot(ctx, snap); err != nil {
				log.Printf("metrics: insert: %v", err)
				continue
			}
			// Broadcast the combined frame: cluster snapshot + the latest per-node
			// hardware pushed by each node's agent.
			if s.hub.ClientCount() > 0 {
				frame := models.MetricsFrame{Cluster: snap, Nodes: s.NodeStates()}
				if msg, err := json.Marshal(frame); err == nil {
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
			if err := s.queries.PruneOldNodeSnapshots(ctx, cutoff); err != nil {
				log.Printf("metrics: prune node snapshots: %v", err)
			}
			if err := s.queries.PruneOldDriveTemps(ctx, cutoff); err != nil {
				log.Printf("metrics: prune drive temps: %v", err)
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
		// Free = Bavail (available to non-root, excludes the 5% root-reserved blocks).
		// Use Used+Free as the total so percentages exclude system-reserved space.
		diskFree = int64(usage.Free)
		diskTotal = int64(usage.Used) + int64(usage.Free)
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
