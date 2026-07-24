package main

import (
	"crypto/rand"
	"fmt"
	"io"
	mathrand "math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"apollo-sfs.com/api/models"
)

// benchmarkSeqFileSizeBytes is the size of the temporary test file used for
// the sequential ("same sector" — i.e. contiguous, in-order) pass: one fsync'd
// write followed by a sequential read of the same file. Large enough to move
// past any small write-buffer effects, small enough that even the
// standard-tier HDD finishes in a few seconds. It's an exact multiple of
// benchmarkSeqChunkBytes so O_DIRECT's alignment requirement never needs a
// short final write.
const benchmarkSeqFileSizeBytes = 256 * 1024 * 1024 // 256 MiB

// benchmarkSeqChunkBytes is the I/O buffer size used for the sequential pass.
const benchmarkSeqChunkBytes = 4 * 1024 * 1024 // 4 MiB

// benchmarkRandomBlockBytes is the I/O size for the random-access pass — 4 KiB
// is the de facto industry-standard random block size (fio, CrystalDiskMark,
// etc.), small enough to expose a spinning disk's seek penalty instead of
// hiding it behind large sequential transfers.
const benchmarkRandomBlockBytes = 4 * 1024

// benchmarkRandomDuration time-boxes each random-access pass (write, then
// read) rather than running a fixed operation count: a spinning HDD's random
// 4 KiB IOPS can be two to three orders of magnitude below an NVMe's, so a
// fixed count would make the HDD pass take far longer than the NVMe one.
const benchmarkRandomDuration = 2 * time.Second

// benchmarkDirectIOAlign is the buffer/offset/length alignment O_DIRECT
// requires for every I/O. 4096 is a safe superset of every real drive's
// logical sector size (512 or 4096 bytes).
const benchmarkDirectIOAlign = 4096

// benchmarkFileName is written under each configured mount, then removed
// immediately after the read passes finish.
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
// report, if non-nil, is called with (disk label, step) right before each
// step starts, so the caller can push live progress upstream — see
// cmd/node-agent/main.go's use of models.BenchmarkProgressPayload.
func runBenchmarks(report func(label, step string)) []models.BenchmarkResultPayload {
	mounts := configuredBenchmarkMounts()
	out := make([]models.BenchmarkResultPayload, 0, len(mounts))
	for _, m := range mounts {
		out = append(out, benchmarkDisk(m, report))
	}
	return out
}

// benchmarkDisk runs two passes against m.mount, each write-then-read, mirroring
// the industry-standard split used by tools like fio/CrystalDiskMark:
//
//  1. Sequential ("same sector"): one large fsync'd write, then a sequential
//     read of the same file — the best case for a spinning disk, since there's
//     no seek overhead once the head is positioned.
//  2. Random: fixed 4 KiB reads/writes at random block-aligned offsets within
//     that same file — the worst case for a spinning disk (seek-bound) and the
//     case that best predicts real-world small-file/metadata-heavy workloads.
//
// Every pass opens the file with O_DIRECT so reads/writes bypass the kernel
// page cache — without it, a read run right after a write of the same file is
// served straight from cache and can report throughput many times higher than
// the physical device supports (this is what originally inflated read numbers,
// worst of all on the HDD where a "real" number is much lower than DRAM
// bandwidth, making the cache hit obvious). Not every filesystem supports
// O_DIRECT (notably tmpfs); a failed O_DIRECT open falls back to a regular
// buffered open, and the result's DirectIO flag is cleared so the caller knows
// that particular disk's numbers may still be cache-inflated.
func benchmarkDisk(m diskMount, report func(label, step string)) models.BenchmarkResultPayload {
	result := models.BenchmarkResultPayload{Label: m.label, SizeBytes: benchmarkSeqFileSizeBytes, DirectIO: true}
	path := filepath.Join(m.mount, benchmarkFileName)
	defer os.Remove(path)

	notify := func(step string) {
		if report != nil {
			report(m.label, step)
		}
	}

	seqChunk, err := alignedRandomBuffer(benchmarkSeqChunkBytes)
	if err != nil {
		result.Error = fmt.Sprintf("generate test data: %v", err)
		return result
	}

	notify(models.BenchmarkStepSeqWrite)
	seqWriteMbps, directIO, err := benchmarkSeqWrite(path, seqChunk)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.SeqWriteMbps = &seqWriteMbps
	result.DirectIO = result.DirectIO && directIO

	notify(models.BenchmarkStepSeqRead)
	seqReadMbps, directIO, err := benchmarkSeqRead(path)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.SeqReadMbps = &seqReadMbps
	result.DirectIO = result.DirectIO && directIO

	notify(models.BenchmarkStepRandomWrite)
	randWriteMbps, randWriteIOPS, directIO, err := benchmarkRandomWrite(path)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.RandomWriteMbps = &randWriteMbps
	result.RandomWriteIOPS = &randWriteIOPS
	result.DirectIO = result.DirectIO && directIO

	notify(models.BenchmarkStepRandomRead)
	randReadMbps, randReadIOPS, directIO, err := benchmarkRandomRead(path)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.RandomReadMbps = &randReadMbps
	result.RandomReadIOPS = &randReadIOPS
	result.DirectIO = result.DirectIO && directIO

	return result
}

// benchmarkSeqWrite writes benchmarkSeqFileSizeBytes sequentially in
// benchmarkSeqChunkBytes chunks, fsyncs (so the number reflects data actually
// committed to disk, not just buffered), and times the whole thing.
func benchmarkSeqWrite(path string, chunk []byte) (mbpsOut float64, directIO bool, err error) {
	f, directIO, err := openBenchmarkFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC)
	if err != nil {
		return 0, false, fmt.Errorf("open for write: %w", err)
	}
	defer f.Close()

	start := time.Now()
	var written int64
	for written < benchmarkSeqFileSizeBytes {
		n, err := f.Write(chunk)
		if err != nil {
			return 0, directIO, fmt.Errorf("write: %w", err)
		}
		written += int64(n)
	}
	if err := f.Sync(); err != nil {
		return 0, directIO, fmt.Errorf("fsync: %w", err)
	}
	return mbps(written, time.Since(start)), directIO, nil
}

// benchmarkSeqRead reads the file written by benchmarkSeqWrite back
// sequentially, start to finish, and times it.
func benchmarkSeqRead(path string) (mbpsOut float64, directIO bool, err error) {
	f, directIO, err := openBenchmarkFile(path, os.O_RDONLY)
	if err != nil {
		return 0, false, fmt.Errorf("open for read: %w", err)
	}
	defer f.Close()

	buf, err := alignedBuffer(benchmarkSeqChunkBytes)
	if err != nil {
		return 0, directIO, err
	}

	start := time.Now()
	var read int64
	for {
		n, err := f.Read(buf)
		read += int64(n)
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, directIO, fmt.Errorf("read: %w", err)
		}
	}
	return mbps(read, time.Since(start)), directIO, nil
}

// benchmarkRandomWrite issues fixed benchmarkRandomBlockBytes writes at random
// block-aligned offsets within the file for up to benchmarkRandomDuration,
// fsyncs at the end, and reports both throughput and IOPS.
func benchmarkRandomWrite(path string) (mbpsOut, iops float64, directIO bool, err error) {
	f, directIO, err := openBenchmarkFile(path, os.O_WRONLY)
	if err != nil {
		return 0, 0, false, fmt.Errorf("open for random write: %w", err)
	}
	defer f.Close()

	block, err := alignedRandomBuffer(benchmarkRandomBlockBytes)
	if err != nil {
		return 0, 0, directIO, err
	}

	start := time.Now()
	var ops, written int64
	for time.Since(start) < benchmarkRandomDuration {
		n, err := f.WriteAt(block, randomAlignedOffset())
		if err != nil {
			return 0, 0, directIO, fmt.Errorf("random write: %w", err)
		}
		written += int64(n)
		ops++
	}
	if err := f.Sync(); err != nil {
		return 0, 0, directIO, fmt.Errorf("fsync: %w", err)
	}
	elapsed := time.Since(start)
	return mbps(written, elapsed), opsPerSec(ops, elapsed), directIO, nil
}

// benchmarkRandomRead issues fixed benchmarkRandomBlockBytes reads at random
// block-aligned offsets within the file for up to benchmarkRandomDuration and
// reports both throughput and IOPS.
func benchmarkRandomRead(path string) (mbpsOut, iops float64, directIO bool, err error) {
	f, directIO, err := openBenchmarkFile(path, os.O_RDONLY)
	if err != nil {
		return 0, 0, false, fmt.Errorf("open for random read: %w", err)
	}
	defer f.Close()

	block, err := alignedBuffer(benchmarkRandomBlockBytes)
	if err != nil {
		return 0, 0, directIO, err
	}

	start := time.Now()
	var ops, read int64
	for time.Since(start) < benchmarkRandomDuration {
		n, err := f.ReadAt(block, randomAlignedOffset())
		if err != nil && err != io.EOF {
			return 0, 0, directIO, fmt.Errorf("random read: %w", err)
		}
		read += int64(n)
		ops++
	}
	elapsed := time.Since(start)
	return mbps(read, elapsed), opsPerSec(ops, elapsed), directIO, nil
}

// randomAlignedOffset picks a random offset within the benchmark file that is
// a multiple of benchmarkRandomBlockBytes, as O_DIRECT requires.
func randomAlignedOffset() int64 {
	numBlocks := int64(benchmarkSeqFileSizeBytes / benchmarkRandomBlockBytes)
	return mathrand.Int64N(numBlocks) * benchmarkRandomBlockBytes
}

// openBenchmarkFile opens path for the benchmark with O_DIRECT so the kernel
// page cache is bypassed. If the underlying filesystem doesn't support
// O_DIRECT (open fails, typically EINVAL), it falls back to a regular
// buffered open and reports ok=false so the caller can flag that pass's
// numbers as possibly cache-inflated instead of presenting them as trustworthy.
func openBenchmarkFile(path string, flag int) (f *os.File, ok bool, err error) {
	f, err = os.OpenFile(path, flag|syscall.O_DIRECT, 0o600)
	if err == nil {
		return f, true, nil
	}
	f, err = os.OpenFile(path, flag, 0o600)
	return f, false, err
}

// alignedBuffer returns a zero-filled byte slice of length n whose starting
// address is aligned to benchmarkDirectIOAlign, as O_DIRECT requires of every
// buffer it's handed.
func alignedBuffer(n int) ([]byte, error) {
	raw := make([]byte, n+benchmarkDirectIOAlign)
	offset := 0
	if rem := int(uintptr(unsafe.Pointer(&raw[0])) % benchmarkDirectIOAlign); rem != 0 {
		offset = benchmarkDirectIOAlign - rem
	}
	return raw[offset : offset+n : offset+n], nil
}

// alignedRandomBuffer is an aligned buffer filled with random bytes, used as
// synthetic file content — incompressible, so transparent filesystem
// compression (if any) can't skew the result.
func alignedRandomBuffer(n int) ([]byte, error) {
	buf, err := alignedBuffer(n)
	if err != nil {
		return nil, err
	}
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// mbps converts bytes transferred over elapsed into megabytes/second.
func mbps(bytesTransferred int64, elapsed time.Duration) float64 {
	if elapsed <= 0 {
		return 0
	}
	return (float64(bytesTransferred) / (1024 * 1024)) / elapsed.Seconds()
}

// opsPerSec converts an operation count over elapsed into operations/second (IOPS).
func opsPerSec(ops int64, elapsed time.Duration) float64 {
	if elapsed <= 0 {
		return 0
	}
	return float64(ops) / elapsed.Seconds()
}
