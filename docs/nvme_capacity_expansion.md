# Adding NVMe Capacity to the Raspberry Pi (no redundancy)

This guide adds a **second NVMe drive** to the Raspberry Pi storage node purely to
**increase capacity** — not for redundancy. The new drive is mounted alongside the
existing one following the same convention (`nvme-01` → `nvme-02`), and both drives
are pooled into a single volume that MinIO writes to.

> For the larger two-node (Ryzen + Pi) Swarm/tiering plan, see
> [storage_node_setup.md](storage_node_setup.md). This document is the simpler,
> single-node "just give me more space" path.

---

## Why mergerfs (and not the obvious alternatives)

MinIO runs here as **single-node, single-drive** (`server /data` in
[`docker-compose.yml`](../docker-compose.yml)). That mode has no "just attach
another drive" path, and MinIO has **no JBOD/no-parity multi-drive mode**:

| Approach | Redundancy | Migration needed | Keeps `nvme-01`/`nvme-02` layout | Verdict |
|----------|-----------|------------------|----------------------------------|---------|
| MinIO multi-drive (`server /data{1...2}`) | **Yes** (erasure coding, ~½ raw lost) | Yes (wipe + redeploy) | No | ✗ adds redundancy you don't want |
| LVM/mdadm linear concat | No | **Yes** (must wipe nvme-01) | No (one merged mount) | ✗ destroys existing data layout |
| Second MinIO bucket/tier | No | No | Yes | ✗ needs app changes (single bucket today) |
| **mergerfs union pool** | **No** | **No** | **Yes** | ✓ chosen |

**mergerfs** is a FUSE union filesystem. It pools `nvme-01/data` and `nvme-02/data`
into one mount; existing objects stay physically where they are and remain visible,
new writes are placed on the drive with the most free space. Capacity ≈ drive1 +
drive2, no parity, no migration.

**Caveat:** MinIO officially recommends raw XFS. A mergerfs union works well for a
capacity-focused single-node setup but carries a small performance overhead and is
not an officially supported MinIO backend. Accept slightly lower throughput in
exchange for "more space, no redundancy, no data migration."

**Durability:** no redundancy means a single drive failure loses the objects on
*that* drive. The app-layer AES-256-GCM protects confidentiality, not against drive
loss — keep an off-box backup.

---

## Layout

| Path | What |
|------|------|
| `/home/apollo/apollo-sfs/minio/nvme-01` | mount point of the **existing** NVMe (XFS, label `nvme-01`) |
| `/home/apollo/apollo-sfs/minio/nvme-01/data` | existing MinIO objects (unchanged) |
| `/home/apollo/apollo-sfs/minio/nvme-02` | mount point of the **new** NVMe (XFS, label `nvme-02`) |
| `/home/apollo/apollo-sfs/minio/nvme-02/data` | new, empty branch |
| `/home/apollo/apollo-sfs/minio/pool` | **mergerfs union** of both `data` dirs — this is what MinIO uses |

The MinIO container runs as **uid/gid 1000**, so every `data` dir must be owned by
`1000:1000`.

---

## Step 1 — Identify and health-check the new drive

```bash
lsblk -f                          # find the NEW, unformatted disk — likely /dev/nvme1n1
sudo smartctl -H /dev/nvme1n1     # overall health (needs smartmontools)
sudo smartctl -t short /dev/nvme1n1
```

Confirm the device has **no mountpoint and no filesystem** before continuing.
Substitute the real device for `/dev/nvme1n1` everywhere below — **Step 2 erases it.**

## Step 2 — Format XFS and mount at `…/minio/nvme-02`

```bash
sudo wipefs -a /dev/nvme1n1
sudo mkfs.xfs -L nvme-02 /dev/nvme1n1

sudo mkdir -p /home/apollo/apollo-sfs/minio/nvme-02
UUID=$(sudo blkid -s UUID -o value /dev/nvme1n1)
echo "UUID=$UUID  /home/apollo/apollo-sfs/minio/nvme-02  xfs  defaults,noatime,nofail,x-systemd.device-timeout=10  0  2" \
  | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount -a
df -hT /home/apollo/apollo-sfs/minio/nvme-02      # expect the new size, xfs
```

Create the data dir and give it to MinIO's uid/gid:

```bash
sudo mkdir -p /home/apollo/apollo-sfs/minio/nvme-02/data
sudo chown -R 1000:1000 /home/apollo/apollo-sfs/minio/nvme-02/data
```

- `noatime` — fewer metadata writes.
- `nofail` + `x-systemd.device-timeout` — the Pi still boots if the drive is absent.

## Step 3 — Pool both drives with mergerfs

```bash
sudo apt update && sudo apt install -y mergerfs fuse3

# allow the MinIO container (uid 1000) to access the root-created FUSE mount
sudo sed -i 's/^#\?user_allow_other/user_allow_other/' /etc/fuse.conf

sudo mkdir -p /home/apollo/apollo-sfs/minio/pool
```

Add the pool to `/etc/fstab` as a **single line**:

```
/home/apollo/apollo-sfs/minio/nvme-01/data:/home/apollo/apollo-sfs/minio/nvme-02/data  /home/apollo/apollo-sfs/minio/pool  fuse.mergerfs  defaults,allow_other,use_ino,cache.files=partial,category.create=mfs,minfreespace=20G,fsname=minio-pool,x-systemd.requires=/home/apollo/apollo-sfs/minio/nvme-01,x-systemd.requires=/home/apollo/apollo-sfs/minio/nvme-02  0  0
```

```bash
sudo systemctl daemon-reload
sudo mount /home/apollo/apollo-sfs/minio/pool
df -h /home/apollo/apollo-sfs/minio/pool          # should show COMBINED capacity
ls  /home/apollo/apollo-sfs/minio/pool            # existing MinIO objects appear here
```

mergerfs option notes:
- `category.create=mfs` — new files go to the drive with **most free space** (fills the
  empty nvme-02 first, then balances).
- `minfreespace=20G` — stop writing to a drive once it drops below 20 GB free.
- `allow_other` — lets the MinIO container (uid 1000) read/write the root-owned mount
  (requires `user_allow_other` in `/etc/fuse.conf`, set above).
- `use_ino` — consistent inode reporting across the pool.
- `x-systemd.requires=…` — guarantees both NVMe drives are mounted **before** the pool,
  and the pool is up before Docker starts the MinIO container.

## Step 4 — Point the server at the pool

These edits are **already applied** in [`docker-compose.yml`](../docker-compose.yml);
listed here for reference:

```yaml
# api service — disk-stats reader now reports COMBINED capacity
environment:
  DISK_STATS_DRIVE_LABEL: nvme-pool
volumes:
  - /home/apollo/apollo-sfs/minio/pool:/data:ro

# minio service — data bind-mount points at the pool
volumes:
  minio-data:
    driver_opts:
      device: /home/apollo/apollo-sfs/minio/pool
```

`df` on a mergerfs mount aggregates both drives, so the API reports combined
capacity/usage automatically.

## Step 5 — Restart and verify

```bash
cd /home/apollo/apollo-sfs
docker compose down          # stop so MinIO isn't writing during cutover
docker compose up -d

docker exec apollo-sfs-minio df -h /data     # combined size
docker compose logs minio | tail             # healthy, no filesystem errors
```

Existing files are intact (still physically on nvme-01, visible through the pool),
and new uploads land on whichever drive has more room.

---

## Rolling back

mergerfs is non-destructive — it never moved your data. To revert, stop the stack,
point `minio-data.device` and the API volume back to
`/home/apollo/apollo-sfs/minio/nvme-01/data` / `…/nvme-01`, remove the mergerfs
fstab line, and `docker compose up -d`. (Any objects mergerfs placed on nvme-02
would then be invisible to MinIO until copied back to nvme-01.)
