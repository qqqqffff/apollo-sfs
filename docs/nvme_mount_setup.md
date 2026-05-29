# NVMe Drive Mount Setup

Mounts the NVMe drive directly at the Docker Compose volume directory so MinIO
data lands on fast storage and disk metrics reflect the real drive capacity —
no changes to `docker-compose.yml` required.

**Relevant compose paths:**
- MinIO data: `minio-data` volume → `/home/apollo/apollo-sfs/minio/nvme-01/data`
- API disk metrics: `/home/apollo/apollo-sfs/minio/nvme-01` bind-mounted as `/data:ro` (`DISK_STATS_PATH=/data`)

---

## Steps (run on the Pi)

### 1. Find the new drive
```bash
lsblk
# Look for the new nvme device, e.g. nvme1n1
```

### 2. Partition and format
```bash
sudo fdisk /dev/nvme1n1
# Inside fdisk: g (GPT) → n (new partition) → accept all defaults → w (write)

sudo mkfs.ext4 /dev/nvme1n1p1
```

### 3. Mount at the existing volume directory
```bash
mkdir -p /home/apollo/apollo-sfs/minio/nvme-01

sudo mount /dev/nvme1n1p1 /home/apollo/apollo-sfs/minio/nvme-01
df -h /home/apollo/apollo-sfs/minio/nvme-01  # verify
```

### 4. Make persistent via fstab
```bash
sudo blkid /dev/nvme1n1p1  # copy the UUID

echo "UUID=<your-uuid>  /home/apollo/apollo-sfs/minio/nvme-01  ext4  defaults,noatime  0  2" | sudo tee -a /etc/fstab

sudo mount -a  # verify no errors
```

### 5. Create MinIO data subdirectory and fix ownership
```bash
sudo mkdir -p /home/apollo/apollo-sfs/minio/nvme-01/data
sudo chown -R $USER:$USER /home/apollo/apollo-sfs/minio/nvme-01
```

### 6. Start the stack
```bash
cd /home/apollo/apollo-sfs
docker compose up -d
```

---

## Notes

- `noatime` prevents access-time updates on every file read — good practice for NVMe storage drives.
- NVMe temperature is already picked up automatically by the metrics service via `lm-sensors` (sensor key matching `"nvme"`). Ensure `lm-sensors` is installed: `sudo apt install lm-sensors && sudo sensors-detect`.
- If this is a fresh drive with no prior MinIO data, the stack will initialise a clean MinIO instance on first boot.
- If migrating existing data, copy it before starting the stack: `cp -a /old/minio/data/. /home/apollo/apollo-sfs/minio/nvme-01/data/`
