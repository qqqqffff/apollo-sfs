# Storage Cluster Setup — Two-Node Swarm with Tiered MinIO

This guide sets up Apollo SFS as a **two-node Docker Swarm** with **two storage tiers**,
and migrates the running deployment off the single Raspberry Pi onto the new node.

| Node | Hostname | Arch | Swarm role | Runs | Storage tier |
|------|----------|------|-----------|------|--------------|
| **Ryzen 5 7500X3D box** | `apollo-sfs-1` | amd64 | **manager** | `api`, `frontend`, `keycloak`, `postfix`, `ddns`, `db-app`, `db-keycloak`, `minio-standard`, **host nginx + Cloudflare TLS** | **8TB HDD → `hdd` / standard** |
| **Raspberry Pi 5** | `apollo-sfs` | arm64 | **worker** | `minio-fast` only | **4TB NVMe → `nvme` / fast** |

The Ryzen runs the OS + the whole Docker stack from its **own NVMe**; its **8TB SATA HDD**
is dedicated entirely to standard-tier object storage. The Pi keeps its existing NVMe
blobs in place and serves them as the fast tier.

> **The app is built for this.** The API models a `server → node → drive` topology with a
> `DriveType` of `nvme` / `hdd` and a MinIO endpoint per server (see `models/server.go`,
> `routes/admin/infrastructure.go`, `routes/admin/nodes.go`). So two tiers is a
> **configuration** task (Part 6), not a code change. Clients are allocated to drives;
> each drive belongs to a node on a server that points at one MinIO instance.

---

## Honest caveats about running this on Swarm

Swarm fits the node-management and overlay-DNS needs well, but three things differ from
plain `docker compose` — all are handled in this guide and in `docker-stack.yml`:

1. **No `build:`** — Swarm deploys pre-built images. We build the `api`/`frontend` images
   on the manager and deploy with `--resolve-image never` (Part 1, Part 3). No registry
   needed because those images run only on the manager.
2. **No `privileged:` / host namespaces** — the API's remote **kill switch** can't run as
   a Swarm service. Either accept it's inert, or run the API as a standalone privileged
   container attached to the (attachable) overlay. See the `api` comment in
   `docker-stack.yml`.
3. **Published ports use `mode: host`** — they bind only on the pinned node, so the host
   firewall must block `3000`/`8080`/`8180` from outside (Part 4). The blobs themselves
   never leave the overlay.

No `mc mirror` blob migration is needed: **MinIO stays on the Pi**, so the only data that
moves is the two (small) Postgres databases.

---

## Part 0 — Install command-line Debian on the Ryzen node

Target: headless Debian (no desktop), **OS on the NVMe**, the **8TB HDD as one XFS blob
volume**.

### 0.1 Avoid the EFI trap — isolate the HDD during install
The Debian installer likes to reuse an **existing EFI partition** it finds. If it writes
GRUB to the **HDD's** ESP while installing the OS to the NVMe, wiping the HDD later breaks
boot. Prevent this:

- **Best:** physically **disconnect the 8TB HDD** (SATA data or power) during install, so
  the installer is forced to put EFI + GRUB on the NVMe. Reconnect it afterward (0.4).
- **Alternative:** during installer partitioning, **delete all partitions on the HDD**
  (especially any old ESP) before configuring the NVMe.

### 0.2 Install (netinst, no GUI)
1. Write the **netinst** image to USB (`dd if=debian-*.iso of=/dev/sdX bs=4M status=progress && sync`).
2. Locale / keyboard / network.
3. Hostname `apollo-sfs-1`; **leave "Domain name" blank** (`.local` is mDNS/avahi).
4. **Leave the root password BLANK** → Debian then adds your first user to `sudo`
   automatically. (Setting a root password is what causes the "not in the sudoers file"
   problem and leaves you doing `usermod -aG sudo` by hand.)
5. Create user `apollo`.
6. Partitioning → **Guided – use entire disk**, and **select the NVMe** (`nvme0n1`). Scheme
   "All files in one partition" (creates EFI + root + swap on the NVMe). At the summary,
   confirm **only `nvme0n1` is modified** — `sda` (HDD) must be untouched.
7. **Software selection:** deselect **Debian desktop environment**; select only
   **SSH server** + **standard system utilities**.
8. Install GRUB to the **NVMe**; reboot; remove USB. In BIOS, set the **NVMe first** in the
   boot order.

> Already installed a desktop by mistake? You don't need to reinstall — over SSH:
> `sudo systemctl set-default multi-user.target` (boot to text), then
> `sudo apt purge -y task-gnome-desktop task-desktop gnome-shell gdm3 && sudo apt autoremove --purge`.
> Watch the autoremove list — `sudo` can get caught; reinstall it from `su -` if so.

### 0.3 Base setup
```bash
ssh apollo@apollo-sfs-1.local
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y curl ca-certificates gnupg ufw vim htop parted gdisk \
  smartmontools xfsprogs avahi-daemon
sudo timedatectl set-ntp true        # Swarm + TLS are clock-sensitive
# optional SSH hardening once key auth works:
ssh-copy-id apollo@apollo-sfs-1.local
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```
Set a **static IP** (router DHCP reservation or on the box) — the port-forward and Swarm
advertise address point here. Use the static IP for Swarm, not `.local`.

### 0.4 Set up the 8TB HDD as one XFS blob volume
Reconnect the HDD if you disconnected it. **Confirm device identity before wiping —
destructive.**
```bash
lsblk -f
```
Expect `nvme0n1` carrying `/`, `/boot/efi`, `[SWAP]` (leave it), and `sda` = the 8TB HDD.
Then:
```bash
sudo smartctl -H /dev/sda            # health verdict (run the long test later, 0.6)

sudo wipefs -a /dev/sda              # clear any old signatures/partition table
sudo sgdisk --zap-all /dev/sda
sudo parted /dev/sda --script mklabel gpt
sudo parted /dev/sda --script mkpart primary 0% 100%
sudo parted /dev/sda --script align-check optimal 1     # expect "1 aligned"
sudo mkfs.xfs -L hdd-01 /dev/sda1    # XFS = MinIO's recommended FS
```
Mount by UUID, persistently, and create the MinIO data dir:
```bash
sudo mkdir -p /srv/minio/hdd-01
UUID=$(sudo blkid -s UUID -o value /dev/sda1)
echo "UUID=$UUID  /srv/minio/hdd-01  xfs  defaults,noatime,nofail,x-systemd.device-timeout=10  0  2" \
  | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount -a
sudo mkdir -p /srv/minio/hdd-01/data
sudo chown -R 1000:1000 /srv/minio/hdd-01/data    # MinIO container runs as uid/gid 1000
df -hT /srv/minio/hdd-01             # expect ~7.3T, xfs
```
- `noatime` reduces writes; `nofail` + `x-systemd.device-timeout` keep the box bootable if
  the drive ever drops.

### 0.5 Clone the repo and bring over secrets
```bash
git clone <repo-url> /home/apollo/apollo-sfs
cd /home/apollo/apollo-sfs
scp apollo@apollo-sfs.local:/home/apollo/apollo-sfs/.env ./.env   # review paths/secrets
mkdir -p /home/apollo/service-worker-email docker/postfix \
         docker/postgresql-app docker/postgresql-keycloak
sudo apt install -y geoipupdate    # provides /var/lib/GeoIP for the api mount (or remove that mount)
```

### 0.6 SMART monitoring + long test
```bash
sudo systemctl enable --now smartd
sudo smartctl -t long /dev/sda       # full surface scan (~12–15h on 8TB); check with:
sudo smartctl -l selftest /dev/sda
```
A single 8TB HDD has **no redundancy** — back the standard tier up off-box, or add a
second drive as a ZFS/mdadm mirror later. App-layer AES-256-GCM protects confidentiality,
not against drive failure.

---

## Part 1 — Build the amd64 images on the manager
Swarm deploys images, it doesn't build. The custom images run only on the manager, so
build locally — no registry required:
```bash
cd /home/apollo/apollo-sfs
docker build -t apollo-sfs-api:amd64 ./api
docker build -t apollo-sfs-frontend:amd64 ./frontend
```
(MinIO / Postgres / Keycloak / Postfix are public multi-arch images, pulled per node.)

---

## Part 2 — Form the Swarm and label the nodes

### 2.1 Firewall (between the two nodes only — never public)
On the manager (`ufw`, adjust `<PI_IP>`):
```bash
sudo ufw allow from <PI_IP> to any port 2377 proto tcp   # cluster mgmt
sudo ufw allow from <PI_IP> to any port 7946              # gossip (tcp+udp)
sudo ufw allow from <PI_IP> to any port 4789 proto udp    # overlay VXLAN
sudo ufw allow OpenSSH
# keep app ports off the public side:
sudo ufw deny 3000 ; sudo ufw deny 8080 ; sudo ufw deny 8180
sudo ufw enable
```

### 2.2 Install Docker (if not already) and init the swarm
```bash
# manager
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER  # re-login
docker swarm init --advertise-addr <MANAGER_LAN_IP>
docker swarm join-token worker        # copy the printed command
```
```bash
# Pi
docker swarm join --token SWMTKN-... <MANAGER_LAN_IP>:2377
```
> Already have a swarm with the **Pi as manager**? Promote then demote instead: join the
> Ryzen with the *manager* token (`docker swarm join-token manager`), then from the Ryzen
> `docker node demote apollo-sfs`. Keep a single manager (2 managers = no fault tolerance).

### 2.3 Label nodes for placement
```bash
# on the manager
docker node update --label-add tier=standard apollo-sfs-1   # 8TB HDD
docker node update --label-add tier=fast     apollo-sfs      # Pi NVMe
docker node ls
```

---

## Part 3 — Deploy the stack
`docker-stack.yml` (repo root) defines everything: `minio-fast` pinned to the Pi (reusing
its existing data dir), `minio-standard` on the manager's HDD, and the rest of the stack
pinned to the manager.

```bash
cd /home/apollo/apollo-sfs
set -a && . ./.env && set +a          # stack deploy does NOT auto-read .env
docker stack deploy -c docker-stack.yml --resolve-image never apollo-sfs
docker stack services apollo-sfs      # watch replicas reach 1/1
docker stack ps apollo-sfs            # confirm each task landed on the right node
```
Don't deploy `minio-fast` against the Pi while the Pi's old `docker compose` MinIO is still
running on the same data dir — bring the old stack down first (Part 5, cutover).

---

## Part 4 — nginx + Cloudflare on the manager
TLS termination moves to the manager with the app:
1. `sudo apt install -y nginx`.
2. Copy the Pi's server block and the **Cloudflare Origin cert + key** to the manager
   (`/etc/nginx/...`, `/etc/ssl/...`). Keep Cloudflare in **Full (Strict)**.
3. Point upstreams at the manager's host-published ports: `127.0.0.1:3000` (frontend) and
   `127.0.0.1:8080` (api). (`mode: host` binds them on the manager.)
4. **Repoint the router's 80/443 port-forward to the manager's LAN IP.** The `ddns`
   service keeps updating the same public A record; only the internal target changes.

---

## Part 5 — Migrate from the Pi

**No blob copy** — only the two Postgres DBs and the configs move. Do everything except the
cutover live; the cutover is a short maintenance window.

### 5.1 Dump the databases on the Pi (logical dump — safe across arm64 → amd64)
Do **not** copy raw `PGDATA` between architectures; use `pg_dump`.
```bash
# on the Pi
docker exec apollo-sfs-postgresql-app      pg_dump -U "$POSTGRES_APP_USER" -Fc "$POSTGRES_APP_DB" > app.dump
docker exec apollo-sfs-postgresql-keycloak pg_dump -U "$POSTGRES_KC_USER"  -Fc "$POSTGRES_KC_DB"  > kc.dump
scp app.dump kc.dump apollo@apollo-sfs-1.local:/home/apollo/apollo-sfs/
```
Migrating `db-keycloak` carries the **whole Keycloak realm + users** — no separate realm
export needed.

### 5.2 Restore into the manager's DB containers
After the stack is up (Part 3) and the DB containers are healthy:
```bash
APPDB=$(docker ps -qf name=apollo-sfs_db-app)
KCDB=$(docker ps -qf name=apollo-sfs_db-keycloak)
docker exec -i "$APPDB" pg_restore -U "$POSTGRES_APP_USER" -d "$POSTGRES_APP_DB" --clean --if-exists < app.dump
docker exec -i "$KCDB"  pg_restore -U "$POSTGRES_KC_USER"  -d "$POSTGRES_KC_DB"  --clean --if-exists < kc.dump
```

### 5.3 Cutover (⏱ maintenance window)
1. Stop writes on the Pi (maintenance page / stop the old app containers' inbound traffic).
2. Re-run **5.1 → 5.2** for the final delta (catches changes since the first dump).
3. On the Pi, `docker compose down` the **old full stack** so its MinIO releases the NVMe
   data dir, then let Swarm's `minio-fast` task start on the Pi (it reuses that dir).
4. Flip the **port-forward** to the manager (Part 4).
5. Verify (Part 7).

---

## Part 6 — Register the two-tier topology in the app

> **Two facts confirmed from the code that shape this section:**
> 1. **`PATCH /servers/:id` (`UpdateServer`) only accepts `is_active` and `name`** — it
>    **cannot change the server's `minio_endpoint`** (set only at `CreateServer`). To point
>    storage at a *different* MinIO instance, set a **per-node** `minio_endpoint` override
>    (`POST`/`PATCH .../nodes`) instead — see "Add the manager + its 8TB HDD" below.
> 2. **`drive_type` (`nvme`/`hdd`) is now a persisted column on `drives`**, set
>    explicitly at `AddDrive` (migration `db/migrations/020_drive_type.sql`). Pass it in
>    the request; if omitted it's inferred from the label (`nvme` substring → `nvme`,
>    else `hdd`) for backward compatibility. Apply the migration before deploying:
>    `docker exec -i <db-app> psql -U $POSTGRES_APP_USER -d $POSTGRES_APP_DB -f /docker-entrypoint-initdb.d/migrations/020_drive_type.sql`

**The existing (fast) server — no endpoint change needed.** Because the fast MinIO service
is named **`minio`** in `docker-stack.yml`, it resolves at the same `minio:9000` the
existing DB record almost certainly already holds — so the record keeps working untouched.
Confirm first:
```sql
-- on the manager: docker exec -i <db-app> psql -U $POSTGRES_APP_USER -d $POSTGRES_APP_DB
SELECT id, name, minio_endpoint FROM servers;
```
- If `minio_endpoint` is `minio:9000` → nothing to do; just register its node (below).
- If it's something else (an IP, a different name) → either rename the `minio` service in
  the stack to match it, or update the row directly (`UPDATE servers SET minio_endpoint='minio:9000' WHERE id=...`),
  since the API can't change it. **Keep the same bucket** — user→drive allocations depend on it.

Register the Pi as the fast server's node (admin API, `/api/v1/admin/system/...`):
```
POST /servers/<fast_server_id>/nodes   { "hostname": "apollo-sfs", "role": "worker", "address": "<pi-ip>" }
```

**Add the manager + its 8TB HDD to the *same* server (per-node MinIO endpoint).**
A node may now override its server's MinIO endpoint (migration
`db/migrations/023_node_minio_endpoints.sql`), so the standard tier lives under the **same
server** as the fast tier instead of a separate one — both show under one server in the
metrics view, while each drive still routes to the correct MinIO instance. Credentials are
inherited from the server (every instance shares the same root credentials), so only the
endpoint is set per node.
```
POST /servers/<server_id>/nodes    { "hostname": "apollo-sfs-1", "role": "manager", "address": "<mgr-ip>",
                                     "minio_endpoint": "minio-standard:9000", "minio_use_ssl": false }
POST /servers/<server_id>/drives   { "label": "hdd-01", "minio_bucket": "<std-bucket>",
                                     "drive_type": "hdd", "node_id": "<apollo-sfs-1 node-id>" }
```
`AddDrive` creates the bucket **on the node's MinIO** (`minio-standard:9000`) when the node
carries an endpoint override, and persists `drive_type` (here `hdd` → standard tier). Run
`POST /drives/<id>/sync-capacity` to populate capacity from the disk-stats path.

> **Or let the sync do it.** `POST /system/sync` reconciles the whole Swarm into a single
> server: each node whose `tier` label maps to a non-primary endpoint
> (`MINIO_STANDARD_ENDPOINT`) gets that endpoint as an override automatically, and each
> tier's buckets attach to the matching node. No separate standard server is created.

> Endpoints resolve over the Swarm **overlay** by service name (`minio:9000`,
> `minio-standard:9000`) from the `api` container — no host ports for MinIO. A drive on a
> node with no endpoint override falls back to its server's endpoint (unchanged for
> single-instance clusters).

> ⚠ **Remaining limitation.** `sync-capacity` still reads the single `DISK_STATS_PATH`
> (`/data`) regardless of which drive you sync — so capacity auto-detect is only correct
> for the drive on the API's own node. Tier classification, however, is now a persisted
> `drive_type` column (overhaul done), not a label heuristic.

---

## Part 7 — Verify & clean up
- `docker stack ps apollo-sfs` — all tasks `Running` on the expected nodes.
- Log in (Keycloak), **download an existing file** (proves the fast tier + bucket survived),
  **upload to fast** and **upload to standard**.
- Admin → infrastructure shows both nodes and both drives (fast `nvme`, standard `hdd`)
  with capacities.
- Once confirmed, remove the Pi's **old Postgres data dirs** — but **keep its MinIO data
  dir** (`/home/apollo/apollo-sfs/minio/nvme-01/data`).

### Operational notes
- **Downtime** is only the 5.3 window (final DB delta + port-forward flip) — minutes.
- **Kill switch:** inert under Swarm (caveat #2). If you need it, run `api` as a standalone
  privileged container on the overlay (see `docker-stack.yml`).
- **Secrets:** `.env` works via shell sourcing; consider Docker **secrets** for the KEK and
  DB passwords later.
- **Redundancy:** none by design ("for now"). The standard tier is a single HDD — back it
  up. If a tier's MinIO is down, the app surfaces capacity/expansion handling per
  `models/expansion_request.go`.

---

## Part 8 — Deploying an update to the running Swarm

Run everything from the repo root on the **manager** unless noted. Swarm deploys
pre-built images, so the cycle is **migrate DB → rebuild images → redeploy**.

### 8.1 Pull the new code
```bash
cd /home/apollo/apollo-sfs
git pull
set -a && . ./.env && set +a            # stack deploy does NOT auto-read .env
```

### 8.2 Back up, then apply pending migrations
Migrations are **not** auto-run; apply each new file once against the live app DB.
```bash
APPDB=$(docker ps -qf name=apollo-sfs_db-app)
docker exec "$APPDB" pg_dump -U "$POSTGRES_APP_USER" "$POSTGRES_APP_DB" \
  | gzip > ~/apollo-app-$(date +%F-%H%M).sql.gz          # safety net

for m in 023_node_minio_endpoints 024_node_disks; do
  docker exec -i "$APPDB" psql -v ON_ERROR_STOP=1 -U "$POSTGRES_APP_USER" -d "$POSTGRES_APP_DB" \
    -f "/docker-entrypoint-initdb.d/migrations/${m}.sql"
done
```
Both migrations are idempotent (`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`).

### 8.3 Ensure the node-agent token exists
Per-disk telemetry needs the agents pushing; an empty token disables ingest (fails
closed) and crash-loops the agent.
```bash
grep -q '^NODE_AGENT_TOKEN=' .env || echo "NODE_AGENT_TOKEN=$(openssl rand -hex 32)" >> .env
set -a && . ./.env && set +a
```

### 8.4 Rebuild images
The custom images run only on the manager (amd64); build them there:
```bash
docker build -t apollo-sfs-api:amd64       ./api
docker build -t apollo-sfs-frontend:amd64  ./frontend
docker build -t apollo-sfs-node-agent:latest -f api/Dockerfile.node-agent ./api
```
The **node-agent runs on the Pi too** (arm64), and its code is unchanged by this
update — but if its image is missing/stale on the Pi, rebuild it there so the
worker has a matching local image:
```bash
ssh apollo@<pi-ip> 'cd /home/apollo/apollo-sfs && git pull && \
  docker build -t apollo-sfs-node-agent:latest -f api/Dockerfile.node-agent ./api'
```

### 8.5 Label the Pi's pooled disks (one-time)
The agent reports each **labelled, mounted** disk. `nvme-02` is already xfs-labelled;
give the ext4 `nvme-01` partition a label so it reports too (safe, live):
```bash
ssh apollo@<pi-ip> 'sudo e2label /dev/nvme0n1p1 nvme-01 && lsblk -f /dev/nvme0n1'
```
The stack now bind-mounts both `…/minio/nvme-01` and `…/minio/nvme-02` into the
node-agent so it can read each disk's usage.

### 8.6 Redeploy
A stack deploy rolls only the services whose image/spec changed:
```bash
docker stack deploy -c docker-stack.yml --resolve-image never apollo-sfs
docker stack services apollo-sfs        # watch replicas reach 1/1
```
To roll a single service instead of the whole stack (local image, no registry):
```bash
docker service update --no-resolve-image --force --image apollo-sfs-api:amd64       apollo-sfs_api
docker service update --no-resolve-image --force --image apollo-sfs-frontend:amd64  apollo-sfs_frontend
docker service update --no-resolve-image --force apollo-sfs_node-agent   # picks up new mounts + token
```

### 8.7 Reconcile topology + verify
```bash
# Fold both tiers into one server (sets the manager node's minio-standard override):
curl -fsS -X POST https://files.<domain>/api/v1/admin/system/sync -H "Cookie: <admin session>"
```
- Admin → **infrastructure**: one server (`NH-0001`) with `apollo-sfs` (fast) and
  `apollo-sfs-1` (standard) nodes; no stale `NH-0001-node-1`, no separate `Standard tier`.
  Delete the stale node/server if the sync left them (`DELETE …/nodes/:id`).
- Admin → **metrics** → pick the Pi node: the **Physical disks** card lists `nvme-01`
  *and* `nvme-02` with independent fill bars + temperatures; click one to graph its
  temperature history. Upload to fast and to standard to confirm routing.
- `docker service logs apollo-sfs_node-agent --tail 20` on each node — pushes succeeding,
  no `NODE_AGENT_TOKEN is required` fatal.
