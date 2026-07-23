package main

import (
	"crypto/rand"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"apollo-sfs.com/api/models"
)

// benchmarkFileSizeBytes is the size of the temporary test file written to
// (and read back from) each disk. Large enough to move past any small
// write-buffer effects, small enough that even the standard-tier HDD finishes
// in a few seconds.
const benchmarkFileSizeBytes = 256 * 1024 * 1024 // 256 MiB

// benchmarkChunkBytes is the I/O buffer size used for both the write and
// read passes.
const benchmarkChunkBytes = 4 * 1024 * 1024 // 4 MiB

// benchmarkFileName is written under each configured mount, then removed
// immediately after the read pass.
const benchmarkFileName = ".apollo-sfs-benchmark.tmp"

// configuredBenchmarkMounts parses NODE_BENCHMARK_MOUNTS — a comma-separated
// list of "label:/writable/scratch/path" entries, same format as
// NODE_DISK_MOUNTS (collect.go) but pointing at a small writable subdirectory
// of each physical disk rather than the read-only data mount, since the data
// mounts are intentionally :ro (see docs/drive_benchmark_setup.md). A label
// here is expected to match the corresponding NODE_DISK_MOUNTS label so the
// API can attach the result to the right node_disks row.
func configuredBenchmarkMounts() []diskMount {
	raw := os.Getenv("NODE_BENCHMARK_MOUNTS")
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

// runBenchmarks executes the write/read test against every configured
// benchmark mount and returns one result per disk. A disk whose scratch
// directory isn't writable (e.g. NODE_BENCHMARK_MOUNTS misconfigured, or the
// host directory wasn't created — see docs/drive_benchmark_setup.md) reports
// an error for that disk only; the others still run.
func runBenchmarks() []models.BenchmarkResultPayload {
	mounts := configuredBenchmarkMounts()
	out := make([]models.BenchmarkResultPayload, 0, len(mounts))
	for _, m := range mounts {
		out = append(out, benchmarkDisk(m))
	}
	return out
}

// benchmarkDisk writes a fixed-size test file to m.mount with an explicit
// fsync (so the write number reflects data actually committed to the disk,
// not just buffered in the page cache), times it, then reads the same file
// back sequentially and times that too.
//
// Caveat: the read pass runs immediately after the write, so the kernel page
// cache is warm for these exact pages — on a host with enough free RAM the
// read number can be inflated versus a genuine cold read. There is no
// portable, unprivileged way to drop caches from inside a container, so this
// is a known limitation rather than something worth fixing here; the write
// number (fsync'd) is the more reliable tier-comparison signal.
func benchmarkDisk(m diskMount) models.BenchmarkResultPayload {
	result := models.BenchmarkResultPayload{Label: m.label, SizeBytes: benchmarkFileSizeBytes}
	path := filepath.Join(m.mount, benchmarkFileName)
	defer os.Remove(path)

	chunk := make([]byte, benchmarkChunkBytes)
	if _, err := rand.Read(chunk); err != nil {
		result.Error = fmt.Sprintf("generate test data: %v", err)
		return result
	}

	writeMbps, err := benchmarkWrite(path, chunk)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.WriteMbps = &writeMbps

	readMbps, err := benchmarkRead(path)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.ReadMbps = &readMbps

	return result
}

func benchmarkWrite(path string, chunk []byte) (float64, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, fmt.Errorf("open for write: %w", err)
	}
	defer f.Close()

	start := time.Now()
	var written int64
	for written < benchmarkFileSizeBytes {
		n, err := f.Write(chunk)
		if err != nil {
			return 0, fmt.Errorf("write: %w", err)
		}
		written += int64(n)
	}
	if err := f.Sync(); err != nil {
		return 0, fmt.Errorf("fsync: %w", err)
	}
	return mbps(written, time.Since(start)), nil
}

func benchmarkRead(path string) (float64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, fmt.Errorf("open for read: %w", err)
	}
	defer f.Close()

	buf := make([]byte, benchmarkChunkBytes)
	start := time.Now()
	var read int64
	for {
		n, err := f.Read(buf)
		read += int64(n)
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, fmt.Errorf("read: %w", err)
		}
	}
	return mbps(read, time.Since(start)), nil
}

// mbps converts bytes transferred over elapsed into megabytes/second.
func mbps(bytesTransferred int64, elapsed time.Duration) float64 {
	if elapsed <= 0 {
		return 0
	}
	return (float64(bytesTransferred) / (1024 * 1024)) / elapsed.Seconds()
}
