# Storage Node + Cluster Setup — Debian (Ryzen) Manager + Raspberry Pi Worker

This guide covers adding a second server node — a headless, command-line-only Debian
box built on a **Ryzen 5 7500X3D (x86_64 / amd64)** — and reorganising the Apollo SFS
deployment as a two-node **Docker Swarm** cluster.

Because the Ryzen box is far more powerful than the Pi 5, it becomes the **cluster
manager and app/compute host**, and the **Raspberry Pi 5 is demoted to a worker /
storage node**. A new **8TB SATA HDD** in the Ryzen box is set up as a **"standard"
storage tier**.

> **Read this first — two honest caveats:**
>
> 1. **Docker Swarm does not add storage by itself.** Swarm is a scheduler/management
>    layer that decides which node runs which container. The capacity gain comes from
>    how **MinIO** and the underlying drives are configured (Parts B and D).
>
> 2. **The current MinIO cannot be expanded in place.** It runs as *single-node,
>    single-drive* (`server /data`). MinIO does **not** support expanding that mode.
>    To put data on the new drive / a clustered store you redeploy MinIO and
>    **migrate the existing blobs** with `mc mirror` (Part B). There is no live
>    "just attach the new drive" path for a single-node-single-drive deployment.

---

## Target topology

| Role | Node | Arch | Holds |
|------|------|------|-------|
| **Swarm manager + app/compute host** | Ryzen Debian box | amd64 | host nginx + Cloudflare TLS, `api`, `frontend`, `keycloak`, `postfix`, `ddns`, Postgres ×2, **8TB HDD = "standard" storage tier (SATA)** |
| **Swarm worker + fast-tier storage** | Raspberry Pi 5 | arm64 | existing **NVMe = "fast" storage tier**, MinIO (fast tier) |

Two consequences of the Ryzen being the app host:

- The **public entry point moves to the Ryzen** — host nginx, the Cloudflare Origin
  cert, and your router's 80/443 port-forward all move with it (see Part A).
- The app images (`frontend`, `api`) are currently **`platform: linux/arm64` only** and
  must be rebuilt for **amd64** (see Part C). Building natively on the Ryzen makes this
  trivial.
- Storing the 8TB "standard" tier **on the same box as the API** means file I/O to that
  tier is local (no network hop). The Pi's NVMe "fast" tier is now one LAN hop away
  from the API (~110 MB/s on gigabit) — fine for hot/small objects; consider 2.5G/10G
  networking later if that tier gets heavy.

---

## Part 0 — Install and prepare command-line Debian on the Ryzen node

Do this on the Ryzen box *before* touching the cluster. Target: a headless Debian 12
("bookworm") with no desktop environment.

### 0.1 Install Debian (netinst, no GUI)
1. Download the **netinst** image from <https://www.debian.org/distrib/> and write it to
   a USB stick (`dd if=debian-*.iso of=/dev/sdX bs=4M status=progress && sync`).
2. Boot the installer; proceed through locale / keyboard / network.
3. Set the hostname to `apollo-sfs-1` (matching the Pi's `apollo-sfs`). **Leave the
   "Domain name" prompt blank** — the `.local` suffix is mDNS (avahi), not a DNS domain.
4. Create your user account (this guide assumes `apollo`, i.e. `apollo@apollo-sfs-1.local`).
5. Partitioning — this deployment uses the **8TB HDD split into two partitions** (a
   dedicated OS SSD would be better long-term, but this works for now):
   - **p2 (~10%, ~800 GB, ext4)** → the **root filesystem** (`/`): OS, the cloned repo,
     and the PostgreSQL data dirs (kept here until a dedicated DB drive is added).
   - **p1 (~90%, ~7.3 TB)** → left for **blob/object storage**, formatted in Part 0.4.

     Note: both partitions share one physical spindle, so heavy blob I/O contends with
     the DB — another reason to move Postgres to its own drive later.
6. At the **Software selection** (tasksel) screen, **deselect "Debian desktop
   environment"** and all desktop options. Select only:
   - **SSH server**
   - **standard system utilities**
7. Finish, install GRUB, reboot, remove the USB stick.

### 0.2 First login and base setup
SSH in (`ssh apollo@<RYZEN_IP>`), then:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y curl ca-certificates gnupg ufw vim htop parted smartmontools xfsprogs avahi-daemon
```

Set up SSH key auth, then harden (optional but recommended):

```bash
# From your workstation
ssh-copy-id apollo@<RYZEN_IP>
```
```bash
# On the Ryzen box
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

### 0.3 Static address, hostname, time sync
A manager/app host needs a stable address (Cloudflare/port-forward point here).

```bash
sudo hostnamectl set-hostname apollo-sfs-1      # reachable as apollo-sfs-1.local via avahi
# set a static DHCP lease on your router, or a static IP on the box
sudo timedatectl set-ntp true      # Swarm + TLS are clock-sensitive
timedatectl status
```
> Use the node's **static IP** (not `apollo-sfs-1.local`) for the Swarm
> `--advertise-addr` and worker join in Part A — keep mDNS for convenience SSH only.

### 0.4 Format the blob-storage partition (p1) as the "standard" storage tier
The 8TB HDD is split into two partitions (see Part 0.1):

| Partition | Size | Filesystem | Mount | Holds |
|-----------|------|-----------|-------|-------|
| **p2** | ~10% (~800 GB) | ext4 | `/` (root) | OS, repo, Postgres data — set up by the installer, **leave as-is** |
| **p1** | ~90% (~7.3 TB) | **XFS** | `/srv/storage/standard-01` | blob/object storage (MinIO) |

The `standard-01` label mirrors the existing `nvme-01` convention
(`DISK_STATS_DRIVE_LABEL` in `docker-compose.yml`) so the server classifies and reports
it as **standard** storage.

> **If p1 was created as NTFS, it must be reformatted.** NTFS-on-Linux has no real POSIX
> ownership, so MinIO can't `chown` its data dir to uid/gid 1000. XFS is required.

**1. Identify the partitions and confirm roles before doing anything destructive:**
```bash
lsblk -f
```
Verify:
- the **large (~7.3T)** partition is **p1**, with an **empty mountpoint** (NOT `/`,
  `/boot`, or `/boot/efi`) — this is the one to format;
- the **small (~800G)** ext4 partition is **p2**, mounted at **`/`** — leave it alone.

If the sizes look swapped or p1 shows a mountpoint, **stop** and recheck before formatting.
Substitute the real partition for `/dev/sda` (p1) below. **mkfs erases it.**

**2. (Recommended) health check on the physical disk before trusting it with data:**
```bash
sudo smartctl -H /dev/sda                        # overall health (whole disk, not p1)
sudo smartctl -t short /dev/sda                  # ~2 min self-test
sudo smartctl -t long /dev/sda                  # ~2 min self-test
```

**3. Reformat p1 from NTFS to XFS (MinIO's recommended filesystem) with a tier label:**
```bash
sudo umount /dev/sda 2>/dev/null
sudo wipefs -a /dev/sda                          # clear the NTFS signature
sudo mkfs.xfs -L standard-01 /dev/sda
```
XFS handles 4K-sector (Advanced Format) HDDs automatically — no manual alignment needed.

**4. Mount p1 by UUID, persistently:**
```bash
sudo mkdir -p /srv/storage/standard-01
UUID=$(sudo blkid -s UUID -o value /dev/sda)
echo "UUID=$UUID  /srv/storage/standard-01  xfs  defaults,noatime,nofail,x-systemd.device-timeout=10  0  2" \
  | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount -a
df -hT /srv/storage/standard-01                  # expect ~7.3T, xfs
```
- `noatime` — fewer metadata writes (HDD-friendly).
- `nofail` + `x-systemd.device-timeout` — the box still boots if the drive is absent.

**5. Create the data dir and set ownership** (the MinIO container runs as uid/gid 1000):
```bash
sudo mkdir -p /srv/storage/standard-01/data
sudo chown -R 1000:1000 /srv/storage/standard-01/data
```

**6. Enable ongoing SMART monitoring** (HDDs fail more than NVMe — watch them):
```bash
sudo systemctl enable --now smartd
# optionally edit /etc/smartd.conf to add: /dev/sdX -a -m you@example.com
```

**p2 needs no setup here** — it's the installer-made ext4 root. The repo and the
PostgreSQL data dirs (`./docker/postgresql-app`, `./docker/postgresql-keycloak`) live on
it normally. Move Postgres to a dedicated drive when you can: a single spinning HDD is
slow for DB random I/O, and p1/p2 share one spindle so blob I/O contends with the DB.

> **Redundancy note:** a single 8TB HDD has **no built-in redundancy** (and p2 holds your
> OS + DB on that same disk). If durability matters, back it up off-box, or pair with a
> second drive as a **ZFS/mdadm mirror**, or use **MinIO distributed mode** with 2+ drives
> (Part B, Option 1). App-layer AES-256-GCM protects confidentiality, not against drive
> failure.

---

## Part A — Swarm cluster with the Ryzen as manager

### A1. Network prerequisites
Both nodes must reach each other on a private network (same LAN, or a WireGuard tunnel
if remote — use the tunnel IPs everywhere). Open these ports **between the two nodes
only**, never public:

- `2377/tcp` — cluster management
- `7946/tcp` + `7946/udp` — node-to-node gossip
- `4789/udp` — overlay network (VXLAN)

With `ufw` on the Ryzen box (adjust `<PI_IP>`):
```bash
sudo ufw allow from <PI_IP> to any port 2377 proto tcp
sudo ufw allow from <PI_IP> to any port 7946
sudo ufw allow from <PI_IP> to any port 4789 proto udp
sudo ufw allow OpenSSH
sudo ufw enable
```

### A2. Install Docker on the Ryzen node
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER     # log out/in afterward
docker --version
```

### A3a. Greenfield — initialise the swarm on the Ryzen (recommended if nothing is deployed yet)
```bash
# On the Ryzen box (the manager)
docker swarm init --advertise-addr <RYZEN_IP>
```
It prints a `docker swarm join --token ...` command — run it on the Pi:
```bash
# On the Pi (joins as a worker)
docker swarm join --token SWMTKN-... <RYZEN_IP>:2377
```

### A3b. Migration — if the Pi is ALREADY the swarm manager (from an earlier setup)
With only two nodes, run **a single manager** (the Ryzen). Two managers give *no* fault
tolerance and add risk, so the plan is: promote the Ryzen, then demote the Pi.

```bash
# 1. Add the Ryzen to the swarm first. On the current manager (Pi), get the MANAGER token:
docker swarm join-token manager        # copy the printed command
#    Run that command on the Ryzen box so it joins as a manager.

# 2. On the Ryzen, confirm it sees both nodes:
docker node ls

# 3. From the Ryzen, demote the Pi to a worker:
docker node demote <pi-hostname>

# 4. Verify leadership moved to the Ryzen:
docker node ls     # Ryzen: MANAGER STATUS = "Leader";  Pi: blank (worker)
```
Notes:
- Never demote the last/only manager — promote the new one **first** (steps 1–2).
- After step 3 the Ryzen holds the raft state and is the sole control plane.
- If the Pi previously advertised the swarm on its own IP, that's fine — workers don't
  advertise; only the manager's `--advertise-addr` matters going forward.

### A4. Label the nodes
```bash
# Run on the Ryzen (manager)
docker node update --label-add role=app      <ryzen-hostname>
docker node update --label-add role=storage  <pi-hostname>
docker node update --label-add tier=standard <ryzen-hostname>   # 8TB HDD lives here
docker node update --label-add tier=fast     <pi-hostname>      # NVMe lives here
```
Use these labels in `placement.constraints` so each service lands on the right node.

### A5. Move the app stack + public entry point to the Ryzen
Because the manager/app host moved, the front door moves too:
1. Copy the repo and `.env` to the Ryzen.
2. Build images natively on amd64 (Part C).
3. **Migrate Postgres** (both DBs) Pi → Ryzen: either `pg_dump`/`pg_restore`, or stop the
   containers and copy the `./docker/postgresql-app` and `./docker/postgresql-keycloak`
   data dirs across.
4. **Migrate MinIO blobs** per Part B (`mc mirror`).
5. Install **nginx on the Ryzen**, move the Cloudflare **Origin certificate** + server
   block over, and **repoint your router's 80/443 port-forward (and any Cloudflare
   DNS/DDNS target) to the Ryzen's IP**.
6. The `api` kill switch (`privileged` + `nsenter` + `docker.sock`) now acts on the
   Ryzen host — expected, since the `api` container moved here.

---

## Part B — MinIO storage layout (what actually serves the bytes)

Pick **one** shape. They have very different tradeoffs.

### Option 1 — Distributed MinIO (single namespace, redundant)
A single bucket namespace with erasure coding so a drive/node loss doesn't lose data.

- **Minimum 4 drives total** (e.g. 2 per node). Usable capacity ≈ **half of raw** — the
  rest is parity. Buys resilience + a unified namespace, not maximum raw GB.
- **Do not run distributed MinIO over the Swarm overlay network** — it needs stable
  hostnames and low latency. Pin one MinIO task per node (constraint on the `role`/`tier`
  labels) with published ports / host networking.

### Option 2 — Single drive per tier (simplest; max raw capacity, no redundancy)
Run MinIO on the Ryzen using the **8TB HDD** (`/srv/storage/standard-01/data`) as the
**standard** tier, local to the API. Optionally keep the Pi's NVMe as a separate **fast**
tier (second MinIO instance/bucket, or a MinIO ILM transition target). No erasure
overhead — you keep ~all raw capacity, but back up separately.

In `docker-compose.yml`, the standard-tier MinIO bind-mount and the API's disk-stats
reader point at the new drive and carry the `standard-01` label:
```yaml
# minio (standard tier) — pinned to the Ryzen
volumes:
  - /srv/storage/standard-01/data:/data
# api
environment:
  DISK_STATS_DRIVE_LABEL: standard-01
volumes:
  - /srv/storage/standard-01:/data:ro
```

### Migration (required for BOTH options — single-drive can't expand in place)
```bash
mc alias set old http://<old-minio>:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD
mc alias set new http://<new-minio>:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD
mc mirror --preserve old/<bucket> new/<bucket>
```
Verify object counts/sizes match, repoint the API, then decommission the old volume.
Because blobs are app-layer encrypted, `mc mirror` just moves opaque ciphertext — no key
handling during migration.

---

## Part C — Building the app images for amd64 (now required)

The app host is now amd64, so the `frontend` and `api` images must run on amd64:

- **Simplest:** build them natively on the Ryzen and set `platform: linux/amd64` on those
  services (or remove the hardcoded `platform: linux/arm64` lines).
- **If you ever schedule them on the Pi too:** build **multi-arch** images and push to a
  registry:
  ```bash
  docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/apollo-sfs-api --push ./api
  ```
- MinIO / Postgres / Keycloak / Postfix images are already multi-arch — no change.

Pin services with placement constraints so nothing lands on the wrong arch/role:
```yaml
deploy:
  placement:
    constraints: [node.labels.role == app]      # api, frontend, keycloak, postgres, ...
```

---

## What runs where (summary)

- **Ryzen (manager / app host):** host nginx + Cloudflare TLS, `api` (+ kill switch),
  `frontend`, `keycloak`, `postfix`, `ddns`, both Postgres instances, and the **8TB HDD
  standard tier**.
- **Pi (worker / fast storage):** the existing **NVMe fast tier** and its MinIO instance.

---

## Decisions still open before editing the stack

1. **MinIO shape** — Option 1 (distributed/redundant, ~half usable) or Option 2
   (single drive per tier, max raw GB)?
2. **Fast tier** — keep the Pi's NVMe as a separate MinIO instance/bucket, or collapse
   everything onto the Ryzen's 8TB tier?
3. **Redundancy for the 8TB drive** — single drive + off-box backup, or add a second
   drive for a ZFS/mdadm mirror?

Tell me your picks and I'll generate the concrete `docker-compose.yml` swarm-stack edits
(`deploy.placement`, the standard-tier MinIO service, `.env` additions) for the repo.
