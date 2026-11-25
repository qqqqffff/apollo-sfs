# Node provisioning — `deploy.sh deploy | restart | update | release`

`deploy.sh` provisions and maintains **one node** of the Apollo SFS Docker Swarm
cluster. Run it on each node (manager first). This document is both the operator
guide and the **contract** the `scripts/deploy/` libraries are written against.

> The contract sections (schemas, state keys, `_remote` protocol, fixtures)
> are authoritative for anyone changing `scripts/deploy/`.

## First run on today's cluster (adoption)

Nothing is wiped or restarted without a confirmation. Run the manager first, then the Pi:

1. On the manager (`apollo-sfs-1`): `git pull`, then `sudo ./deploy.sh --test deploy` to read
   the plan, then `sudo ./deploy.sh deploy`.
   * Keeps the name, the swarm and every running service; asks for the **server name**
     (default `apollo-sfs`) and labels the node `apollo-manager=true`, `apollo-server=…`.
   * Installs `apollo-node-status` (writes `node.json` every 5 s) and validates it.
   * Manager infrastructure: reports `.env` gaps/duplicates (never rewrites existing lines),
     renders nginx (only reloads after `nginx -t`), checks fail2ban/registry/binfmt.
   * Drives: adopts `hdd-01` as it is (no pool conversion), adds `nofail` if missing.
   * Services: seeds `cluster/nodes/*.json` from today's per-node services, so the generated
     `cluster/docker-stack.nodes.yml` is identical to what runs. It then offers the **one-time
     constraint migration** (10 manager-level services move to `node.labels.apollo-manager`;
     each restarts once) — answer "no" to postpone it to a quieter moment (`update`/`release`
     offer it again).
2. On the Pi (`apollo-sfs`): `sudo ./deploy.sh deploy`. It keeps its worker membership, sets up
   key-based ssh to the manager, adopts `nvme-01`/`nvme-02` and the existing pool (adding the
   missing `nofail` to the pool's fstab line), registers with the manager and runs the heartbeat.
3. From then on `restart` and `update` are available on both nodes.

## Files on every node

| Path | What |
|---|---|
| `node.json` (repo root) | deployment record + live metrics, rewritten every 5 s |
| `/opt/apollo-sfs/node-status/` | the installed collector (copied from `scripts/node-status/`) |
| `/etc/systemd/system/apollo-node-status.service` | the service (`journalctl -u apollo-node-status`) |
| `/etc/tmpfiles.d/apollo-sfs.conf` → `/run/apollo-sfs` | locks shared with `_remote` ops |
| `/etc/avahi/services/apollo-sfs.service` | the discovery advertisement |
| `/var/backups/apollo-sfs/<run-id>/` | every file deploy.sh replaced, as it was before |
| `/var/log/apollo-sfs/deploy-<run-id>.log` | the run log (secrets masked) |

## Commands

| Command | Who | What |
|---|---|---|
| `./deploy.sh deploy` | any node (root) | Provision or adopt this node: name → cluster discovery/membership → background status service → manager infrastructure (manager only) → drives → roles & storage allocation → services → health check + heartbeat. |
| `./deploy.sh restart` | any node (root) | Restart every Docker service running on this node, health-check services + drives, heartbeat the manager (workers). Requires a valid `node.json`. |
| `./deploy.sh update` | any node (root) | Drift report, then walk the deploy steps with current values as defaults (keep / change / repair). Requires a valid `node.json`. |
| `./deploy.sh release` | manager | The original deploy.sh: build + push images, redeploy the stack. Old flags (`--services`, `--deploy-only`, `--migrate`, `--registry`, `--tag`, `-y`) still work without the word `release`. |
| `./deploy.sh` | | Interactive menu. |

Global flags: `--test` (aliases `--dry-run`, `-n`), `--keep-sandbox`,
`--node-json PATH` and `--fixtures DIR` (test only), `--ack=ID[,ID]|all`,
`--non-interactive`.

### `--test`

Nothing is committed to the device:

* mutating commands go through `run` and are printed as `[test] would run: …`;
* file writes go through `write_file` / `fstab_upsert`, are rendered into a
  temporary sandbox (`$TEST_SANDBOX/fs/<absolute path>`) and shown as a diff
  (secrets masked);
* `node.json` is a sandbox copy;
* `_remote` calls carry `--test`, so the manager only reports what it would do;
* read-only detection (`probe`) still runs for real, so the walkthrough reflects
  the actual machine.

Real mode refuses to run on WSL and requires systemd as PID 1.

---

## Library layout and ownership

| File | Workstream | Responsibility |
|---|---|---|
| `deploy.sh` | WS0 | dispatcher, menu, global flags |
| `scripts/deploy/lib/core.sh` | WS0 | globals, logging, `probe`/`run`/`write_file`/`fstab_upsert`, locks, run-state, node.json access, alerts, step framework |
| `scripts/deploy/lib/ui.sh` | WS0 | prompts (fd 3), menus, checklist, `ask_percent`, `fmt_bytes` |
| `scripts/deploy/lib/remote.sh` | WS0 | `mgr` client + `_remote` dispatcher/envelope |
| `scripts/deploy/flows/*.sh` | WS0 | step order for deploy / restart / update |
| `scripts/deploy/lib/system.sh` | WS1 | preflight/deps, hostname, daemon.json, avahi advert, drivetemp, tmpfiles |
| `scripts/deploy/lib/nodestatus.sh` | WS1 | background service install/validate/restart |
| `scripts/node-status/apollo_metrics.py` | WS1 | the 5s collector (`daemon`, `collect`) |
| `scripts/deploy/lib/drives.sh` | WS2 | drive classification, format, mount, pools, quotas |
| `scripts/deploy/lib/roles.sh` | WS2 | role checklist, allocation, enforcement |
| `scripts/node-status/apollo_disks.py` | WS2 | `disks` (lsblk tree → classified drive list) |
| `scripts/deploy/lib/cluster.sh` | WS3 | discovery, ssh setup, swarm membership, `info`/`join-token`/`reserve-labels`/`scale`/`promote` ops |
| `scripts/deploy/lib/stack.sh` | WS3 | node registry, generated stack file, preflight, deploy, DB registration, `register-node`/`restart-node-services` ops |
| `scripts/deploy/lib/health.sh` | WS3 | health checks, heartbeat client + `heartbeat` op |
| `scripts/node-status/apollo_stack.py` | WS3 | renders `cluster/docker-stack.nodes.yml` |
| `scripts/deploy/lib/manager.sh` | WS4 | env catalog, nginx, fail2ban, GeoIP, TLS, registry, binfmt, Keycloak, migrations |
| `scripts/deploy/lib/release.sh` | WS4 | the original build/push/deploy flow |
| `scripts/deploy/lib/handover.sh` | WS5 | manager takeover (data migration) + `handover-*` ops |

### Rules every library follows

1. Human output → **stderr** (`log_*`, `ui_*`). **stdout** is only for data
   returned to a caller via `$(…)`.
2. Step functions return `0` ok · `1` failed (the framework raises a retry/ack
   alert; set `STEP_FAIL_REASON`) · `2` not applicable · `3` deferred.
   `set -e` is **off** inside them — check every return code.
3. Never read user input from stdin; use `ask`, `ask_yn`, `confirm_typed`,
   `select_one`, `checklist`, `ask_percent` (fd 3).
4. Every mutation goes through `run` / `run_as_owner` / `write_file` /
   `fstab_upsert` / `ensure_dir` / `node_json_merge` / `node_json_set`.
   Read-only commands go through `probe KEY -- cmd…` so tests can replay them.
5. Never `mount -a`, never `sudo` (deploy/restart/update already run as root;
   `_remote` ops run as the ssh user, who is in the `docker` group).
6. Secrets: `redact_add VALUE` before they can appear in any output.
7. Things that need acknowledgement use `alert_ack LEVEL ID TITLE BODY [--retry]`.
8. Mutating `_remote` ops honour `TEST_MODE` like local code (the client passes `--test`).

---

## Run-state keys (`state_set` / `state_get`)

Values written by earlier steps for later ones (in `--test` they hold the
*planned* values).

| Key | Set by | Meaning |
|---|---|---|
| `role` | membership (restart/update: from node.json) | `manager` \| `worker` |
| `node_name` | identity | chosen hostname |
| `previous_names` | identity | JSON array of old hostnames (rename) |
| `lan_iface`, `lan_ip`, `lan_cidr` | preflight | default-route interface, its IPv4, its network |
| `server_name` | membership | the cluster ("server") name |
| `swarm_node_id`, `swarm_id` | membership | this node's swarm IDs |
| `manager_hostname`, `manager_host` | membership | manager's hostname / LAN IP (also `MGR_HOST`) |
| `fresh_cluster` | membership | `1` when this run ran `docker swarm init` |
| `handover` | membership | `1` when this run is taking over as manager |
| `stack_running` | membership/stack | `1` when the apollo-sfs stack is deployed and reachable |
| `storage_tier` | drives | `fast` \| `standard` \| `` (this node's blob tier) |
| `storage_base_bytes` | drives | usable bytes of the node's Apollo drives (allocation base) |
| `drives_changed` | drives | `1` when this run formatted/added/removed drives |

---

## `node.json` — schema v1

Location: repo root (`/home/apollo/apollo-sfs/node.json`), gitignored, mode
0644, **no secrets**. Two writers, each preserving the other's keys, both under
`flock /run/apollo-sfs/node.lock` with atomic replace:

* **deploy.sh** owns `deployment` (and creates `schema_version`);
* the **apollo-node-status** service owns `last_updated`,
  `last_updated_epoch`, `collector`, `metrics`, `status`, `cluster_view`.

```jsonc
{
  "schema_version": 1,
  "last_updated": "2026-11-17T14:00:05Z",      // service, every 5 s
  "last_updated_epoch": 1763388005,
  "collector": { "name": "apollo-node-status", "version": "1.0.0", "interval_seconds": 5, "pid": 812, "started_at": "…" },

  "deployment": {                                // deploy.sh
    "script_version": "2.0.0", "git_commit": "e06ff8b",
    "last_success": { "revision": 3, "at": "…", "op": "deploy|update|restart", "run_id": "…", "outcome": "succeeded", "steps": { "drives": "ok", … } },
    "run": { "op": "update", "state": "in_progress|succeeded|failed", "run_id": "…", "started_at": "…", "finished_at": "…", "failed_step": null, "test_mode": false },
    "node": { "name": "apollo-sfs-1", "previous_names": [], "arch": "x86_64", "os": "Debian GNU/Linux 13", "kernel": "…", "ip": "192.168.68.57", "cidr": "192.168.68.0/22", "iface": "enp5s0" },
    "cluster": {
      "server_name": "apollo-sfs", "role": "manager|worker",
      "swarm_node_id": "…", "swarm_id": "…",
      "manager": { "hostname": "apollo-sfs-1", "addr": "192.168.68.57:2377" },
      "ssh_user": "apollo", "repo_path": "/home/apollo/apollo-sfs",
      "registry": "192.168.68.57:5000"
    },
    "storage": { "tier": "standard", "base_bytes": 8001563222016 },
    "drives": [ {
      "label": "hdd-01", "class": "nvme|ssd|hdd", "tier": "fast|standard",
      "uuid": "…", "partuuid": "…", "by_id": "/dev/disk/by-id/ata-…", "serial": "…", "model": "…",
      "size_bytes": 8001563222016, "fs": "xfs|ext4",
      "mountpoint": "/srv/minio/hdd-01", "data_dir": "/srv/minio/hdd-01/data", "bench_dir": "/srv/minio/hdd-01/.bench",
      "adopted": true, "prjquota": false, "quota_bytes": null, "pool": null
    } ],
    "pools": [ { "tier": "fast", "path": "/home/apollo/apollo-sfs/minio/pool", "branches": ["…/nvme-01/data", "…/nvme-02/data"], "unit": "home-apollo-apollo\\x2dsfs-minio-pool.mount", "fsname": "…" } ],
    "roles": {
      "blob_storage_shard":      { "enabled": true,  "implemented": true,  "percent": 70, "bytes": 0, "enforcement": "prjquota|pending-remount|recorded|none", "note": "" },
      "postgres_shard":          { "enabled": true,  "implemented": false, "percent": 20, "bytes": 0, "enforcement": "recorded", "note": "Reserved — Postgres sharding is not implemented yet." },
      "database_backup":         { "enabled": false, "implemented": false, "percent": 0,  "bytes": 0, "enforcement": "none", "note": "Reserved — database backup is not implemented yet." },
      "blob_storage_redundancy": { "enabled": true,  "implemented": false, "percent": 10, "bytes": 0, "enforcement": "recorded", "note": "Reserved — blob redundancy is not implemented yet." }
    },
    "components": { "node_status": { "sha256": "…", "installed_at": "…" }, "nginx": { … }, "env": { … } },
    "stack": { "nodes_file_sha256": "…", "services": ["minio", "node-agent-fast"], "registered_at": "…" },
    "health": { "last_check_at": "…", "result": "pass|warn|fail", "checks": [ { "name": "…", "status": "pass|warn|fail", "detail": "…" } ], "acknowledged_alerts": [ { "at": "…", "level": "crit", "id": "…", "title": "…", "run_id": "…" } ] },
    "heartbeat": { "last_ok_at": "…", "manager": "apollo-sfs-1", "result": "pass|fail", "checks": [ … ] },
    "handover": { "at": "…", "from": "apollo-sfs-1", "to": "apollo-sfs-2" }
  },

  "metrics": {                                   // service — mirrors the admin metrics page per-node view
    "hostname": "apollo-sfs-1", "sampled_at": "…", "uptime_seconds": 0, "load_avg": [0, 0, 0],
    "cpu": { "percent": 0.0, "temp_celsius": null, "cores": 16 },
    "memory": { "used_bytes": 0, "total_bytes": 0, "available_bytes": 0 },
    "swap": { "used_bytes": 0, "total_bytes": 0 },
    "network": { "bytes_sent": 0, "bytes_recv": 0, "send_bps": 0, "recv_bps": 0, "interfaces": ["enp5s0"] },
    "drive_capacity": { "total_bytes": 0, "used_bytes": 0, "percent": 0.0, "disk_count": 1 },
    "disks": [ { "label": "hdd-01", "uuid": "…", "device": "/dev/sda1", "mountpoint": "/srv/minio/hdd-01", "mounted": true,
                 "temp_celsius": 34.0, "total_bytes": 0, "used_bytes": 0, "free_bytes": 0, "used_percent": 0.0,
                 "read_bytes": 0, "write_bytes": 0, "read_bps": 0, "write_bps": 0,
                 "smart_health": "PASSED|FAILED|unknown", "blob_quota": { "limit_bytes": null, "used_bytes": 0 } } ],
    "pools": [ { "path": "…", "tier": "fast", "mounted": true, "branches_ok": true, "total_bytes": 0, "used_bytes": 0, "free_bytes": 0 } ],
    "ping": { "target": "8.8.8.8", "ms": 12.3, "loss_pct": 0.0, "sampled_at": "…" },
    "docker": { "daemon": "running|down", "swarm_state": "active|inactive|…", "swarm_role": "manager|worker|none",
                "containers": [ { "name": "…", "service": "apollo-sfs_api", "state": "running", "health": "healthy|unhealthy|none" } ] }
  },
  "status": { "ok": true, "alerts": [ { "level": "warn|crit", "id": "pool-unmounted", "message": "…" } ] },
  "cluster_view": { "nodes": [ { "hostname": "…", "role": "worker", "state": "ready", "availability": "active", "addr": "…" } ],
                    "heartbeats": { "apollo-sfs": { "received_at": "…", "result": "pass" } } }   // manager only
}
```

**Valid deployment** = parses, `schema_version` supported, and
`deployment.last_success.revision >= 1`. A failed/in-progress run is only a
warning (so `update` can repair it); a hostname mismatch is only a warning.

Metric definitions match `api/cmd/node-agent/collect.go` / `NodeFrame`:
disk `total = used + free` where `free` is space available to non-root;
network counts host NICs only (excluding `lo`, `veth*`, `docker*`, `br-*`).

---

## Manager-side cluster registry (`cluster/`, gitignored, owned by the repo owner)

| Path | Contents |
|---|---|
| `cluster/nodes/<hostname>.json` | one record per node (below) |
| `cluster/heartbeats/<hostname>.json` | last heartbeat received + verdict |
| `cluster/labels.json` | reserved drive labels (`{"hdd-01": "apollo-sfs-1", …}`) |
| `cluster/docker-stack.nodes.yml` | **generated** per-node services (deployed with `-c docker-stack.yml -c cluster/docker-stack.nodes.yml`) |
| `cluster/.backups/` | previous versions of the above |

Node record (`cluster/nodes/<hostname>.json`):

```jsonc
{
  "hostname": "apollo-sfs", "seeded": false, "registered_at": "…", "updated_at": "…",
  "role": "worker", "address": "192.168.68.60", "arch": "aarch64",
  "tier": "fast",                              // blob tier this node serves, or null
  "services": { "agent": "node-agent-fast", "minio": "minio" },   // minio null when no blob role
  "placement": "node.labels.tier == fast",     // legacy nodes keep their constraint; new: node.hostname == <host>
  "disk_mounts":  [ { "label": "nvme-01", "path": "/home/apollo/apollo-sfs/minio/nvme-01" } ],
  "bench_mounts": [ { "label": "nvme-01", "host": "/home/apollo/apollo-sfs/minio/nvme-01/.bench", "container": "/bench/nvme-01" } ],
  "minio_data_path": "/home/apollo/apollo-sfs/minio/pool",
  "deployment": { … the node's deployment.node/cluster/drives/pools/roles … }
}
```

Seeding: on the first adoption the manager writes `seeded: true` records for
the existing nodes from `scripts/deploy/templates/legacy-node-services.yml` + the
live services, keeping names and constraints, so the rendered file is identical
to what is running (no restarts).

---

## `_remote` protocol (worker → manager over ssh)

`ssh <owner>@<manager> <repo>/deploy.sh _remote <op> --proto 1 [--test] [args]`,
JSON request on stdin, one JSON envelope on stdout:

```json
{"proto":1,"op":"heartbeat","ok":true,"host":"apollo-sfs-1","test":false,"data":{…}}
{"proto":1,"op":"heartbeat","ok":false,"host":"apollo-sfs-1","test":false,"error":{"code":"…","message":"…"}}
```

| Op | Request | `data` |
|---|---|---|
| `info` | `{}` | `{proto_min, proto_max, script_version, server_name, swarm{id, manager{hostname, addr, node_id}}, repo{path, commit, dirty}, registry, nodes[{hostname, id, role, state, availability, addr, labels{}}], tiers{fast, standard}, stack_running}` |
| `join-token` | `{"role":"worker"}` | `{token, addr}` (token is redacted in logs) |
| `reserve-labels` | `{"hostname":"…","classes":["nvme","nvme"]}` | `{labels:["nvme-03","nvme-04"]}` |
| `register-node` | `{"hostname", "swarm_node_id", "previous_names":[], "phase":"drives"\|"full", "deployment":{node, cluster, storage, drives, pools, roles}}` | `{labels{}, db{row_id, created, renamed}, stack{changed_services[], deployed}, warnings[]}` |
| `heartbeat` | `{"hostname", "swarm_node_id", "last_updated_epoch", "metrics":{…}, "expect":{"disks":[{"label","device","size_bytes"}],"services":[…]}}` | `{ok, skew_s, checks:[{name, status, detail}], recorded}` |
| `restart-node-services` | `{"hostname"}` | `{services:[{name, ok, state}]}` |
| `scale` | `{"services":{"api":0}}` | `{scaled:[{service, from, to}]}` |
| `promote` | `{"hostname"}` | `{state}` |
| `handover-preflight` / `-maintenance` / `-switch` / `-finalize` / `-rollback` | see handover.sh | |
| `handover-export ITEM` | — | raw tar stream (no envelope) |

Exit codes: 0 ok · 1 op error · 2 usage/unknown op · 6 protocol mismatch.

---

## Fixtures (`--fixtures DIR`, test harness)

`probe KEY -- cmd…` prints `DIR/KEY` (exit code from `DIR/KEY.rc`, default 0)
instead of running `cmd`. Keys are lower-case `[a-z0-9._-]`; build dynamic keys
with `probe_key`. With `APOLLO_FIXTURES_STRICT=1` a missing fixture fails with
rc 127 (and is logged to `$APOLLO_FIXTURE_MISSING_LOG`). Each library documents
its keys in `scripts/deploy/tests/fixtures/README.md`.

## Renaming a node

Choose a new name at the **System name** step of `deploy` or `update`. On a swarm member, the step first asks to restart Docker, because Swarm only reads the hostname at start-up. The old name is added to `deployment.node.previous_names`, and the rest of the run treats every previous name as this node:

- **Blob storage:** if the tier is held by this node's old name (for example the Pi `apollo-sfs` → `nh-fast-node-001`), the blob storage role stays available and the role simply carries over. The drives, the data, `minio_data_path` and the MinIO service (`minio` / `minio-standard`) are unchanged, so nothing is copied or re-created.
- **Node record:** `register-node` moves the record in `cluster/nodes/` to the new name and moves `<old>.json` to `cluster/.backups/<old>.json.renamed-<ts>`, so the node's services never render twice. A `node.hostname == <old>` placement is rewritten to the new hostname. Service names (`node-agent-<old>`, legacy `node-agent-fast`) are kept, so no service is recreated. Legacy `node.labels.tier` placements need no change at all, because Swarm labels belong to the node ID.
- **Database:** the `nodes` row is renamed in place, so metric history stays attached.
- **Drive labels:** labels reserved under the old name stay this node's.
- **A name another node uses now** is never treated as this node's old name, so its record and DB row are left alone.

### Renaming the manager

Swarm identifies nodes by node ID, certificate and IP address. The hostname is only a description, so a rename does not affect membership and workers stay joined. The step still proves it:

1. **Before:** it records the node ID, the swarm ID and which nodes are Ready. If autolock is on, it warns you to have the unlock key ready.
2. **Restart:** it stops Docker, saves `/var/lib/docker/swarm` to `/var/backups/apollo-sfs/<run-id>/swarm-state.tgz` (root only, contains swarm keys), and starts Docker. Every service on the manager is down during this.
3. **After:** it waits until Docker and the swarm both report the new name, with the same node ID and swarm ID, this node still in control, and every previously Ready node Ready again. If not, the `swarm-after-rename` alert says what is missing and offers a retry. Then it waits for the stack's services, and registration waits for the database.

`deploy.sh` addresses the local node by its swarm node ID, so every command works before and after the rename. If the swarm still has the old name, `register-node` refuses with `name_mismatch` instead of storing a name the metrics would not match.

**Workers need no change and no ssh from the manager.** They use the manager's IP address for the swarm, for ssh and for the registry. The only copy of the name is `deployment.cluster.manager.hostname` in their `node.json` (display only), and each worker refreshes it at its next heartbeat (`restart`, `update` or `deploy`). What does change is the mDNS name you type yourself: `ssh <user>@<new-name>.local`. If the manager's **IP** changes, workers do need attention.

If a manager rename is rolled back after the Services step, run `deploy` again: the manager's record and DB row still carry the new name until the node registers again.

- **In `--test`:** the rename is only printed. Swarm and the database still know the node by its current hostname, so the heartbeat runs under that name.

## Manager-to-worker checks

On a manager, the **Health check & heartbeat** step (`deploy`, `update`) and the **Heartbeat** step (`restart`) also check the connection from the manager to every worker, for up to 90 s:

| Check | What it proves |
|---|---|
| `network` | the worker's address answers on swarm port 7946 from the manager |
| `swarm`, `tasks` | Ready/Active, and all its tasks running |
| `nodes_row`, `metrics_fresh`, `disk <label>` | its node-agent reports reach the database, fresh, for each recorded drive |
| `overlay` | the api container reaches that worker's MinIO through the overlay network (blob nodes only) |
| `own_heartbeat` | when the worker last sent its own heartbeat (informational) |

A record in `cluster/nodes/` with no matching swarm node fails; a swarm node that was never deployed with `deploy.sh` is a warning. A failing worker fails the step, with retry / acknowledge / quit. In `--test` the checks really run (they are read-only), but failures are only warnings. Results are stored in `node.json` under `deployment.heartbeat.workers`.

## Rolling back a run

Each `deploy`, `update` or `restart` keeps a rollback journal of the changes it makes on **this** node, in `/var/backups/apollo-sfs/<run-id>/journal`, next to the backups of the files it changed. In `--test` the journal is kept in the sandbox instead.

**What the journal records**
- **Files:** every file the run writes. The rollback restores the original from the backup, or removes the file if the run created it. When a run writes the same file more than once, the backup still holds the first, pre-run version.
- **Changes it can undo:**
  - mount and pool units started by the run are stopped again;
  - branches added to a live mergerfs pool are removed (MinIO keeps running);
  - `chattr +i` on mountpoints is removed, and directories the run created are deleted if they are empty;
  - a hostname change is reverted (with a Docker restart when the node is in a swarm);
  - a `swarm init` or `swarm join` is left again;
  - `apollo-node-status` is disabled if the run enabled it;
  - a registry container the run created is removed;
  - XFS blob quotas are lifted;
  - MinIO that was scaled to 0 for a pool conversion is scaled back up.

  After restoring files, the rollback runs `systemctl daemon-reload` for fstab and unit files, `nginx -t && reload` for nginx files, and `systemctl reload docker` for `daemon.json`.
- **Changes it cannot undo** (listed as `CANNOT UNDO`):
  - **Formatted disks:** a wipe erases the data for good.
  - **Installed packages** stay installed.
  - **`fail2ban/install.sh`** changes stay.
  - **Manager-side changes:** the node record, swarm labels, the DB row and the stack deploy. Re-run `deploy` or `update` to change them.

**When you're offered a rollback.** If a run stops after changing something (you quit at an alert, a step fails, or you press Ctrl-C), the script lists the journal newest-first and asks `Roll these changes back now? [y/N]`. The default is **no**. Non-interactive runs print the command to run instead.

**Rolling back later.** `sudo ./deploy.sh rollback` lists the runs that still have a journal and lets you pick one. `sudo ./deploy.sh rollback <run-id>` rolls back that run directly. After a rollback the journal is renamed `journal.rolled-back-<ts>`, so it can't be replayed twice.

## Manager handover runbook

Run `sudo ./deploy.sh deploy` on the NEW node (N) and choose "join as the new MANAGER".

1. **Preflight** (`_remote handover-preflight` on the old manager O). Blockers: N is not amd64
   (frontend/recognition/test-runner/ingest are amd64-only), N's repo commit differs from O's,
   not enough free space (data + dumps + 20 %), N already has `docker/postgresql-*` data, or O
   runs an older deploy.sh. Type `HANDOVER` to continue.
2. **N joins as a worker** (never a long two-manager window) and copies the static config:
   `.env`, `cluster/`, the origin certificate, `/etc/GeoIP.conf`, the well-known files and
   `auto-blocked.conf`. No downtime yet. N then runs its own steps (status service, manager
   infrastructure, drives, roles).
3. **Maintenance window** (type `MAINTENANCE`): O scales the app + postfix to 0; both databases
   are dumped (`pg_dump -Fc`) into `/var/backups/apollo-sfs/handover-<ts>/` with row counts and
   checksums; O stops both databases; the data dirs, e-mail, postfix spool and registry are copied
   byte-for-byte.
4. **Verification** on N with throw-away Postgres containers. A mismatch rolls back: O restarts
   everything — nothing on O was changed.
5. **Switch**: O promotes N, the `apollo-manager` label moves to N, the registry starts on N
   (`REGISTRY=<N>:5000`), the stack is deployed from N. From here N's api serves (point of no
   return); if it doesn't come up healthy you are offered a rollback to O (writes made on N would
   be lost).
6. **Finish**: migrations, `docker node demote O`, O's `docker/postgresql-*` renamed
   `*.handover-<ts>` (never deleted, so a stale DB can't start there), then a reminder to point
   the router's 80/443 at N. Run `./deploy.sh update` on O afterwards — it notices it is a worker
   now and offers to disable its leftover nginx/fail2ban/registry.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `restart`/`update` are greyed out | `node.json` has no successful deploy (`deployment.last_success.revision`); run `deploy` |
| "metrics are stale" | `systemctl status apollo-node-status`, `journalctl -u apollo-node-status -n 50`; `update` reinstalls it |
| drive metrics never reach the manager | the node has no `nodes` row (ingest silently drops unknown hostnames — `update` re-registers), or a drive is unmounted (its `.bench` bind source is missing, so the node's whole node-agent can't start) |
| a pool is not mounted after boot | by design when a branch drive is missing (all-or-nothing). Reconnect the drive, `./deploy.sh restart`. Never `mount -a`: a partial pool lets the 4am reconciliation delete the rows of every file on the missing drive |
| "Cannot reach the manager over ssh" | `ssh <owner>@<manager>` must work without a password; re-run `update` to redo the key setup |
| protocol mismatch | the manager runs an older/newer `deploy.sh` — check out the same commit on both nodes |
| `nginx -t` fails after an update | the previous files were restored automatically; the backup is in `/var/backups/apollo-sfs/<run-id>/etc/nginx` |
| a `--test` run should be inspected | add `--keep-sandbox`; rendered files are under the printed sandbox's `fs/` |
