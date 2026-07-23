# Drive Tier Benchmark

Apollo SFS splits storage across two hardware tiers — a pool of NVMe drives on
the fast-tier node (the Pi 5) and a single HDD on the standard-tier node (the
manager). This feature lets an admin run a real on-demand write/read speed
test against both tiers directly on the production hardware, compares the
fast tier's two pooled NVMe drives (averaged) against the standard tier's HDD,
and surfaces the result on the admin metrics page and as a marketing
proof-point: a promo card (linking to a blog post with the numbers) on the
public home page, the post-registration screen, and the Add Storage modal.

This is an **active** probe — it writes and reads real bytes — unlike the
passive drive I/O counters already on the metrics page (continuous
`/proc/diskstats` sampling, diffed between frames; see `MetricsService`).

## Why the trigger works the way it does

`node-agent` has no inbound HTTP listener — it only push-POSTs its regular
hardware sample outward to `node-metrics-ingest` every few seconds
(`NODE_AGENT_INTERVAL_SECONDS`). There is therefore no direct way for the API
to tell a specific node "run a benchmark now."

Instead, the request rides that same push:

1. `POST /admin/system/drives/benchmark` sets `nodes.benchmark_requested_at =
   NOW()` on every active node (409 if a run is already pending).
2. The next time that node's agent pushes its metrics sample,
   `node-metrics-ingest`'s `POST /internal/node-metrics` handler
   atomically checks-and-clears the column for that hostname and replies
   `{"run_benchmark": true}`.
3. `node-agent` sees the flag in the response and runs the sequential +
   random-access test synchronously against every configured disk on that
   node (delaying that tick's next regular push by however long it takes —
   the sequential pass alone is a few seconds even on the HDD, plus up to 2
   seconds per direction for the random pass; see Methodology below), then
   POSTs the results to a new `POST /internal/node-benchmark-result` endpoint.

Because of this, a trigger doesn't complete in one HTTP round-trip like the
network speed test does — the admin metrics page polls `GET
/admin/system/drives/benchmark` every few seconds after clicking "Run
benchmark" until fresh results show up (same shape as the "Run tests"
progress polling). That same response carries `completed_nodes`/`total_nodes`
(`nodes.benchmark_requested_at` cleared vs. every active node), which is the
finest-grained real progress signal the server can offer — a node's whole
disk batch arrives in one atomic push, so progress only ever advances in
per-node steps — and is what drives the progress bar on that card.

## Writable scratch directories (manual host setup required)

`node-agent`'s data mounts are intentionally read-only (`docker-stack.yml`) —
it's a metrics collector, not something that should be able to touch
production data. Rather than reopening those mounts for read-write, the
benchmark gets its own small, dedicated writable subdirectory per physical
disk, bind-mounted separately:

```yaml
# node-agent-standard
NODE_BENCHMARK_MOUNTS: "hdd-01:/bench/hdd-01"
volumes:
  - /srv/minio/hdd-01/.bench:/bench/hdd-01

# node-agent-fast
NODE_BENCHMARK_MOUNTS: "nvme-01:/bench/nvme-01,nvme-02:/bench/nvme-02"
volumes:
  - /home/apollo/apollo-sfs/minio/nvme-01/.bench:/bench/nvme-01
  - /home/apollo/apollo-sfs/minio/nvme-02/.bench:/bench/nvme-02
```

`NODE_BENCHMARK_MOUNTS` uses the same `label:/path` comma-separated format as
the existing `NODE_DISK_MOUNTS`, and the label should match so the API can
attach the result to the right `node_disks` row.

**Before deploying**, create the scratch directories on each real host (Swarm
bind mounts require the source path to already exist):

```bash
# On the manager (standard tier)
mkdir -p /srv/minio/hdd-01/.bench

# On the Pi 5 (fast tier)
mkdir -p /home/apollo/apollo-sfs/minio/nvme-01/.bench
mkdir -p /home/apollo/apollo-sfs/minio/nvme-02/.bench
```

Nothing else reads or writes these directories.

## Methodology: sequential + random, both bypassing the page cache

Each benchmark run (`cmd/node-agent/benchmark.go`) writes one 256 MiB test
file and puts it through two passes, mirroring the split industry tools like
fio and CrystalDiskMark use — a drive's sequential and random-access numbers
can differ by orders of magnitude (especially on a spinning disk), so a
single number understates that gap:

1. **Sequential ("same sector")** — one large write (4 MiB chunks, explicit
   `fsync`), then a sequential read of the same file start to finish. This is
   the best case for the HDD: once the head is positioned there's no further
   seek overhead.
2. **Random-access** — fixed 4 KiB reads/writes (the standard random-I/O
   block size) at random block-aligned offsets within that same file,
   time-boxed to 2 seconds per direction rather than a fixed operation count,
   since the HDD's random IOPS can be two to three orders of magnitude below
   the NVMe's. Reports both throughput (MB/s) and IOPS. This is the worst
   case for the HDD (seek-bound) and the number that best predicts real-world
   small-file/metadata-heavy workloads — it's where NVMe's advantage over HDD
   is most dramatic and most representative of actual usage.

The file is deleted immediately after the random-read pass.

### Why read numbers used to be (and no longer are) cache-inflated

Early on, the read pass ran right after the write pass with a plain buffered
`open()`, so the kernel page cache was warm for those exact pages — on a host
with plenty of free RAM, read throughput reflected the page cache (DRAM
speed), not the physical device. It was easiest to spot on the HDD: a real
7200 RPM drive's sequential read tops out somewhere around 150–280 MB/s, so
any HDD read number in the thousands of MB/s (or higher) was almost certainly
a cache round-trip, not the disk.

Every pass now opens the file with `O_DIRECT`, which bypasses the page cache
for that I/O entirely — no `CAP_SYS_ADMIN` or cache-dropping required, it's
a normal `open()` flag, just one that requires the buffer, offset, and length
of every read/write to be aligned (4096 bytes here, a safe superset of every
real drive's logical sector size). Not every filesystem supports it —
notably tmpfs — so if the `O_DIRECT` open fails, node-agent falls back to a
regular buffered open for that pass and clears `direct_io` on the result,
which the admin page surfaces as a warning that the numbers may still be
cache-inflated rather than presenting them as trustworthy.

## Data model

- `nodes.benchmark_requested_at` — pending-trigger flag, see above.
- `node_disk_benchmarks` — latest result per physical disk (upserted on every
  run, no history — this is an on-demand probe, not a continuous sample):
  `seq_write_mbps`/`seq_read_mbps` (sequential pass), `random_write_mbps`/
  `random_write_iops`/`random_read_mbps`/`random_read_iops` (random-access
  pass), and `direct_io` (false if any pass fell back to buffered I/O — see
  above). Tier (`nvme`/`hdd`) is resolved by joining to any `drives` row on
  the same node, since every physical disk on a given node is the same tier
  by construction.
- `user_preferences.hide_benchmark_promo` — hides the promo card in the Add
  Storage modal only; never affects the benchmark itself or the admin page.

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /admin/system/drives/benchmark` | Admin | Trigger a run on every active node |
| `GET /admin/system/drives/benchmark` | Admin | Per-disk results + fast/standard averages, for the metrics page |
| `GET /api/v1/drive-benchmark` | None | Just the two tier averages (or `{"available": false}` before the first run) — powers the home page, registration, and Add Storage modal promo cards |

## Blog post

`frontend/src/routes/blog.drive-speed-benchmark.tsx` reads the public summary
endpoint and shows the real numbers once available, or an explicit "results
coming soon" placeholder — never a fabricated number — alongside a plain-
language explanation of what each tier is good for (fast tier: previews,
active files, snappy browsing; standard tier: capacity, archives, backups).
