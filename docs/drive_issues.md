# NVMe Drive Failure — Causes, Diagnosis & Prevention

## Possible Causes

### 1. Insufficient Power Supply

The most common cause of NVMe failure on a Pi. Under write load the drive draws more current, causing a voltage drop that locks up the controller.

**Test:**
```bash
# Check for undervoltage events (0x50005 means throttling occurred)
vcgencmd get_throttled
dmesg | grep -i "undervoltage\|voltage\|throttl"
```

**Fix:** Use a genuine 27W USB-C PD supply (the official Pi 5 adapter). Third-party supplies that claim the right wattage often can't deliver stable voltage under load.

---

### 2. Defective Drive (DOA)

New drives fail more often than people expect, especially under the first heavy write workload.

**Test:** Try the drive in another machine and run a full write stress test:
```bash
sudo apt install smartmontools
sudo smartctl -t long /dev/nvme0   # run long SMART self-test (~30 min)
sudo smartctl -a /dev/nvme0        # read results after
```

**Fix:** Return under warranty — a drive that fails this quickly with no physical cause qualifies as DOA in virtually every warranty policy.

---

### 3. Overheating

NVMe drives on a Pi inside an enclosure with no airflow can hit thermal limits under sustained write load and start throwing errors.

**Test** (once a replacement drive is installed):
```bash
# Monitor NVMe temperature during load
watch -n2 "sudo nvme smart-log /dev/nvme0n1 | grep temperature"
# Also monitor Pi SoC temp
watch -n2 "vcgencmd measure_temp"
```

**Fix:** Add a heatsink directly on the NVMe chip, ensure the enclosure has ventilation, or add active cooling.

---

### 4. HAT or PCIe Connection Issue

A loose or partially-seated HAT connection causes intermittent PCIe errors that the OS sees as I/O errors.

**Test:**
```bash
# Check negotiated PCIe link speed and width
sudo lspci -vv | grep -A10 -i nvme
# Look for "LnkSta" — Speed and Width should match the HAT spec
dmesg | grep -i "pcie\|pci\|link"
```

**Fix:** Power off completely, reseat the HAT, reseat the NVMe card, power back on. Verify the HAT is compatible with your specific NVMe model (M.2 Key M, correct PCIe Gen).

---

### 5. Unclean Shutdown / No UPS

If the Pi loses power mid-write the NVMe controller can be mid-operation and leave the filesystem corrupted. Repeated unclean shutdowns wear down both the filesystem and the drive's internal state.

**Test:**
```bash
last -x | grep -i "shutdown\|reboot"
dmesg | grep -i "unexpected\|panic\|crash"
```

**Fix:** Add a UPS or a capacitor-backed power HAT. Also add `errors=remount-ro` to the filesystem's fstab entry so it goes read-only rather than corrupting further on errors:
```
/dev/nvme0n1p1  /your/mount/point  ext4  defaults,errors=remount-ro  0  2
```

---

### 6. No Backups

Not a cause of the failure itself, but the reason all data was lost. For a self-hosted file storage service this is critical.

**Fix:** Set up automated MinIO bucket snapshots using `mc mirror`:
```bash
# Example: daily mirror to a backup location
mc mirror --overwrite myminio/files /backup/minio-daily/
```
Schedule this as a cron job to run nightly. Even mirroring to a large USB drive attached to the Pi is far better than nothing.

---

## Removing the Dead Drive from the OS

**1. Remove from `/etc/fstab`** to prevent boot hangs:
```bash
sudo nano /etc/fstab
# Delete or comment out the line referencing /dev/nvme0n1p1 or /dev/nvme0n1
```

**2. Remove the old mount point directories:**
```bash
sudo umount /home/apollo/apollo-sfs/minio/nvme-01/data 2>/dev/null
sudo rmdir /home/apollo/apollo-sfs/minio/nvme-01/data
sudo rmdir /home/apollo/apollo-sfs/minio/nvme-01
```

**3. Remove the device from the running kernel** to stop I/O error spam in `dmesg`:
```bash
# Find the PCIe address of the NVMe controller
readlink -f /sys/class/nvme/nvme0
# Output will contain the PCI address, e.g. 0000:01:00.0
# Use that address to remove the device:
echo 1 | sudo tee /sys/bus/pci/devices/0000:01:00.0/remove
```

After this the device disappears from `/dev` and `dmesg` will be clean. It will not reappear until the next reboot, at which point fstab will no longer attempt to mount it.

**4.** Physically remove the drive from the HAT while the Pi is powered off.
