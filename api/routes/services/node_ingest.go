package services

import (
	"context"
	"log"
	"time"

	"apollo-sfs.com/api/db"
	"apollo-sfs.com/api/models"
)

// NodeIngestService persists hardware pushes from per-node agents to Postgres.
// It holds no in-memory state — the live per-node WebSocket view is assembled
// by MetricsService reading these rows back from the DB, so this service can
// run standalone (cmd/node-metrics-ingest) isolated from the public API.
type NodeIngestService struct {
	queries *db.Queries
}

// NewNodeIngestService constructs a NodeIngestService.
func NewNodeIngestService(q *db.Queries) *NodeIngestService {
	return &NodeIngestService{queries: q}
}

// UpdateNodeMetrics ingests a hardware push from a node's agent: it resolves the
// reporting hostname to a node and persists the node snapshot and any drive
// temperatures. Pushes from unregistered hostnames are logged and ignored (no
// error) so an unconfigured agent never disrupts the stream.
func (s *NodeIngestService) UpdateNodeMetrics(ctx context.Context, p *models.NodeMetricsPayload) error {
	node, err := s.queries.GetNodeByHostname(ctx, p.Hostname)
	if err != nil {
		return err
	}
	if node == nil {
		log.Printf("node-ingest: push from unknown hostname %q (ignored)", p.Hostname)
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
		log.Printf("node-ingest: insert node snapshot: %v", err)
	}

	// Map reported drive labels to registered drives on this node so temperature
	// history can be attached to the right drive_id. Unregistered labels are skipped.
	summaries, err := s.queries.GetDriveSummaries(ctx)
	if err != nil {
		log.Printf("node-ingest: drive summaries for node push: %v", err)
	}
	byLabel := make(map[string]models.DriveSummary)
	for _, d := range summaries {
		if d.NodeID != nil && *d.NodeID == node.ID {
			byLabel[d.DriveLabel] = d
		}
	}

	for _, dp := range p.Drives {
		// Physical-disk telemetry: persist every reported disk and its temperature,
		// independent of whether it backs a registered drive. This is what lets one
		// disk in a pool be tracked (and run hot/fail) on its own.
		disk, err := s.queries.UpsertNodeDisk(ctx, db.UpsertNodeDiskParams{
			NodeID:        node.ID,
			Label:         dp.Label,
			Device:        dp.Device,
			CapacityBytes: dp.TotalBytes,
			UsedBytes:     dp.UsedBytes,
			FreeBytes:     dp.FreeBytes,
			ReadBytes:     dp.ReadBytes,
			WriteBytes:    dp.WriteBytes,
			TempCelsius:   dp.TempCelsius,
		})
		if err != nil {
			log.Printf("node-ingest: upsert node disk %q: %v", dp.Label, err)
		} else {
			if dp.TempCelsius != nil {
				if err := s.queries.InsertNodeDiskTemp(ctx, disk.ID, *dp.TempCelsius, now); err != nil {
					log.Printf("node-ingest: insert node disk temp: %v", err)
				}
			}
			// Read/write counters are always present (unlike temperature, which is
			// nullable when no sensor is accessible), so this is unconditional.
			if err := s.queries.InsertNodeDiskIO(ctx, disk.ID, dp.ReadBytes, dp.WriteBytes, now); err != nil {
				log.Printf("node-ingest: insert node disk io: %v", err)
			}
		}

		// Logical-drive telemetry: only disks whose label backs a registered
		// drive on this node carry a drive_id for the infrastructure view.
		sum, ok := byLabel[dp.Label]
		if !ok {
			continue
		}
		if dp.TempCelsius != nil {
			if err := s.queries.InsertDriveTemp(ctx, sum.DriveID, *dp.TempCelsius, now); err != nil {
				log.Printf("node-ingest: insert drive temp: %v", err)
			}
		}
		if err := s.queries.InsertDriveIO(ctx, sum.DriveID, dp.ReadBytes, dp.WriteBytes, now); err != nil {
			log.Printf("node-ingest: insert drive io: %v", err)
		}
	}

	return nil
}

// ConsumeBenchmarkRequest atomically checks-and-clears a pending
// admin-triggered benchmark request for the given hostname, returning true if
// one was pending. Called on every metrics push so the response can tell the
// agent to run a benchmark now (see cmd/node-agent's push loop).
func (s *NodeIngestService) ConsumeBenchmarkRequest(ctx context.Context, hostname string) (bool, error) {
	return s.queries.ConsumeBenchmarkRequest(ctx, hostname)
}

// RecordBenchmarkResults persists every disk result in a benchmark batch
// pushed by a node's agent, then clears that node's live progress state (see
// SetBenchmarkProgress) now that the run has actually finished. Pushes from
// unregistered hostnames are logged and ignored, mirroring UpdateNodeMetrics.
func (s *NodeIngestService) RecordBenchmarkResults(ctx context.Context, batch *models.BenchmarkResultBatch) error {
	node, err := s.queries.GetNodeByHostname(ctx, batch.Hostname)
	if err != nil {
		return err
	}
	if node == nil {
		log.Printf("node-ingest: benchmark result from unknown hostname %q (ignored)", batch.Hostname)
		return nil
	}

	for _, r := range batch.Results {
		err := s.queries.UpsertNodeDiskBenchmark(ctx, db.UpsertNodeDiskBenchmarkParams{
			NodeID:          node.ID,
			Label:           r.Label,
			SizeBytes:       r.SizeBytes,
			Error:           r.Error,
			SeqWriteMbps:    r.SeqWriteMbps,
			SeqReadMbps:     r.SeqReadMbps,
			RandomWriteMbps: r.RandomWriteMbps,
			RandomWriteIOPS: r.RandomWriteIOPS,
			RandomReadMbps:  r.RandomReadMbps,
			RandomReadIOPS:  r.RandomReadIOPS,
			DirectIO:        r.DirectIO,
		})
		if err != nil {
			log.Printf("node-ingest: upsert disk benchmark %q: %v", r.Label, err)
		}
	}
	if err := s.queries.ClearBenchmarkProgress(ctx, node.ID); err != nil {
		log.Printf("node-ingest: clear benchmark progress: %v", err)
	}
	return nil
}

// SetBenchmarkProgress records which disk/step a node's agent is currently
// executing, reported right before it starts each step (see
// cmd/node-agent/benchmark.go). Pushes from unregistered hostnames are logged
// and ignored, mirroring UpdateNodeMetrics; a failure here never fails the
// benchmark run itself — it's purely a live-progress display concern.
func (s *NodeIngestService) SetBenchmarkProgress(ctx context.Context, hostname, label, step string) error {
	node, err := s.queries.GetNodeByHostname(ctx, hostname)
	if err != nil {
		return err
	}
	if node == nil {
		log.Printf("node-ingest: benchmark progress from unknown hostname %q (ignored)", hostname)
		return nil
	}
	return s.queries.SetBenchmarkProgress(ctx, node.ID, label, step)
}
