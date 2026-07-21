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
3. `node-agent` sees the flag in the response and runs the write/read test
   synchronously (delaying that tick's next regular push by however long the
   test takes — a few seconds even on the HDD), then POSTs the results to a
   new `POST /internal/node-benchmark-result` endpoint.

Because of this, a trigger doesn't complete in one HTTP round-trip like the
network speed test does — the admin metrics page polls `GET
/admin/system/drives/benchmark` every few seconds after clicking "Run
benchmark" until fresh results show up (same shape as the "Run tests"
progress polling).

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

Nothing else reads or writes these directories. Each benchmark run writes one
256 MiB test file, times the write (with an explicit `fsync`) and a
subsequent sequential read, then deletes the file immediately.

## Known limitation: read numbers can be cache-inflated

The read pass runs right after the write pass, so the kernel page cache is
warm for those exact pages. There's no portable, unprivileged way to drop
caches from inside a container (no `CAP_SYS_ADMIN`), so on a host with plenty
of free RAM the read throughput can look better than a genuine cold read. The
write number (fsync'd) is the more reliable tier-comparison signal. This is
called out in the blog post's methodology note too.

## Data model

- `nodes.benchmark_requested_at` — pending-trigger flag, see above.
- `node_disk_benchmarks` — latest result per physical disk (upserted on every
  run, no history — this is an on-demand probe, not a continuous sample).
  Tier (`nvme`/`hdd`) is resolved by joining to any `drives` row on the same
  node, since every physical disk on a given node is the same tier by
  construction.
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
