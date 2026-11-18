"""apollo_metrics.py — the apollo-node-status collector (python3 stdlib, >= 3.9).

Implements two apollo_node.py subcommands:

  daemon  --output P [--interval 5] [--lock P] [--host-root /] [--repo P]
          Every INTERVAL seconds: collect metrics + component status (and, on a
          swarm manager, a cluster view) and merge them into node.json under the
          node lock, preserving `deployment` and any key this module does not own.
  collect --once [--node-json P] [--host-root /] [--repo P] [--pretty] [--ping]
          One collection printed to stdout. Writes nothing (used by --test).

Owned node.json keys: last_updated, last_updated_epoch, collector, metrics,
status, cluster_view. Everything else (notably `deployment`, written by
deploy.sh) is preserved verbatim.

Metric definitions mirror api/cmd/node-agent/collect.go and the admin metrics
page (NodeFrame) so node.json and the dashboard agree:
  * cpu %      — /proc/stat deltas (all cores)
  * memory     — used = MemTotal − MemAvailable
  * disks      — free = space available to non-root; total = used + free
  * disk temp  — the hwmon device whose `device` symlink resolves to the disk
  * disk I/O   — /proc/diskstats sectors × 512, keyed by partition basename
Unlike node-agent (which runs in a container and therefore sees only its own
network namespace) this runs on the host, so network counters are the real NIC
traffic, excluding lo / veth* / docker* / br-* / virbr*.

--host-root prefixes every /proc, /sys, /dev, /etc and /run path so the unit
tests can point the collector at a fake host tree. When it is not "/", nothing
is executed (no smartctl, ping or systemctl).
"""

import argparse
import glob
import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

import apollo_node

VERSION = "1.0.0"
NAME = "apollo-node-status"
NET_EXCLUDE = re.compile(r"^(lo|veth|docker|br-|virbr)")
CPU_TEMP_KEYS = ("coretemp", "k10temp", "package id", "tctl", "cpu")
SMART_TTL = 600          # seconds between SMART health checks per disk
PING_EVERY = 30          # seconds between ping samples (same cadence as the API)
SERVICE_TTL = 30         # seconds between systemctl is-active checks
FS_TIMEOUT = 2.0         # statvfs/getxattr timeout — a hung FUSE mount must not block us
RE_NVME_CTRL = re.compile(r"^nvme\d+")
RE_BLOCK_DISK = re.compile(r"^(sd[a-z]+|mmcblk\d+)")


def log(msg):
    sys.stderr.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg))
    sys.stderr.flush()


def iso_utc(ts=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if ts is None else ts))


def run_with_timeout(fn, timeout, *args):
    """Run fn(*args) in a daemon thread; return (ok, value). Used for statvfs and
    getxattr, which block forever on a dead FUSE (mergerfs) mount."""
    box = {}

    def target():
        try:
            box["value"] = fn(*args)
        except Exception as e:  # noqa: BLE001 — any failure just means "no reading"
            box["error"] = e

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive() or "error" in box:
        return False, box.get("error")
    return True, box.get("value")


class Host:
    """Filesystem view of the host (or a fake tree in tests)."""

    def __init__(self, root="/"):
        self.root = root or "/"

    @property
    def is_real(self):
        return os.path.realpath(self.root) == "/"

    def p(self, path):
        if self.is_real:
            return path
        return os.path.join(self.root, path.lstrip("/"))

    def read(self, path, default=None):
        try:
            with open(self.p(path), "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        except OSError:
            return default

    def realpath(self, path):
        return os.path.realpath(self.p(path))


# ── parsers (pure functions; unit-tested) ────────────────────────────────────
def parse_proc_stat(text):
    """Return (total_jiffies, idle_jiffies, cores) from /proc/stat."""
    total = idle = 0
    cores = 0
    for line in (text or "").splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "cpu":
            vals = [int(x) for x in parts[1:9]] + [0] * max(0, 8 - len(parts[1:9]))
            # user nice system idle iowait irq softirq steal
            total = sum(vals[:8])
            idle = vals[3] + vals[4]
        elif re.match(r"^cpu\d+$", parts[0]):
            cores += 1
    return total, idle, cores


def parse_meminfo(text):
    out = {}
    for line in (text or "").splitlines():
        m = re.match(r"^(\w+):\s+(\d+)(\s+kB)?", line)
        if m:
            out[m.group(1)] = int(m.group(2)) * (1024 if m.group(3) else 1)
    return out


def parse_net_dev(text):
    """Return {iface: (rx_bytes, tx_bytes)} for interfaces that are real NICs."""
    out = {}
    for line in (text or "").splitlines()[2:]:
        if ":" not in line:
            continue
        name, rest = line.split(":", 1)
        name = name.strip()
        if NET_EXCLUDE.match(name):
            continue
        f = rest.split()
        if len(f) >= 9:
            out[name] = (int(f[0]), int(f[8]))
    return out


def parse_diskstats(text):
    """Return {name: (read_bytes, write_bytes)} — sectors are always 512 bytes here."""
    out = {}
    for line in (text or "").splitlines():
        f = line.split()
        if len(f) >= 10:
            try:
                out[f[2]] = (int(f[5]) * 512, int(f[9]) * 512)
            except ValueError:
                continue
    return out


def unescape_mount(s):
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)


def parse_mountinfo(text):
    """Return {mountpoint: {"source", "fstype", "devno"}} (last mount wins, like the kernel)."""
    out = {}
    for line in (text or "").splitlines():
        if " - " not in line:
            continue
        pre, post = line.split(" - ", 1)
        a = pre.split()
        b = post.split()
        if len(a) < 5 or len(b) < 2:
            continue
        out[unescape_mount(a[4])] = {"source": unescape_mount(b[1]), "fstype": b[0], "devno": a[2]}
    return out


def parse_smart(text):
    t = text or ""
    if re.search(r"STANDBY|SLEEP", t, re.I) and "result" not in t.lower():
        return "standby"
    if re.search(r"(result|Health Status):\s*(PASSED|OK)", t, re.I):
        return "PASSED"
    if re.search(r"(result|Health Status):\s*FAIL", t, re.I):
        return "FAILED"
    return "unknown"


def parse_ping(text):
    loss = ms = None
    m = re.search(r"([\d.]+)% packet loss", text or "")
    if m:
        loss = float(m.group(1))
    m = re.search(r"= [\d.]+/([\d.]+)/", text or "")
    if m:
        ms = float(m.group(1))
    return ms, loss


def parse_health(status):
    s = (status or "").lower()
    if "(unhealthy)" in s:
        return "unhealthy"
    if "(healthy)" in s:
        return "healthy"
    if "health: starting" in s:
        return "starting"
    return "none"


def mergerfs_branches(raw):
    """'/a/data=RW:/b/data=RW' → ['/a/data', '/b/data']."""
    if not raw:
        return []
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    return [b.split("=", 1)[0] for b in raw.strip().split(":") if b]


def disk_of(device_base):
    """Partition/namespace basename → (kind, name) for hwmon/SMART lookups."""
    m = RE_NVME_CTRL.match(device_base)
    if m:
        return "nvme", m.group(0)
    m = RE_BLOCK_DISK.match(device_base)
    if m:
        return "block", m.group(1)
    return None, None


# ── docker over the unix socket ──────────────────────────────────────────────
class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout=3.0):
        super().__init__("localhost", timeout=timeout)
        self._unix_path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._unix_path)
        self.sock = s


def docker_get(sock_path, path, timeout=3.0):
    conn = _UnixHTTPConnection(sock_path, timeout=timeout)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        body = resp.read()
        if resp.status != 200:
            raise OSError("docker API %s → HTTP %d" % (path, resp.status))
        return json.loads(body.decode("utf-8"))
    finally:
        conn.close()


# ── the collector ────────────────────────────────────────────────────────────
class Collector:
    def __init__(self, host, repo_dir=None, enable_ping=True):
        self.host = host
        self.repo_dir = repo_dir
        self.enable_ping = enable_ping and host.is_real
        self.prev = None                 # (monotonic, cpu_total, cpu_idle, net{}, disk{})
        self.smart_cache = {}            # disk → (ts, health)
        self.service_cache = {}          # unit → (ts, active?)
        self.ping = {"target": "8.8.8.8", "ms": None, "loss_pct": None, "sampled_at": None}
        self._ping_thread = None
        self.started_at = iso_utc()

    # ---- ping runs in its own thread so the 5 s tick never waits on it
    def start_ping_thread(self, stop_event):
        if not self.enable_ping or not shutil.which("ping"):
            return

        def loop():
            while not stop_event.is_set():
                try:
                    out = subprocess.run(["ping", "-c", "4", "-W", "1", "-q", self.ping["target"]],
                                         capture_output=True, text=True, timeout=15).stdout
                    ms, loss = parse_ping(out)
                    self.ping = {"target": self.ping["target"], "ms": ms, "loss_pct": loss, "sampled_at": iso_utc()}
                except (OSError, subprocess.SubprocessError):
                    self.ping = dict(self.ping, ms=None, loss_pct=100.0, sampled_at=iso_utc())
                stop_event.wait(PING_EVERY)

        self._ping_thread = threading.Thread(target=loop, name="ping", daemon=True)
        self._ping_thread.start()

    # ---- individual readings
    def cpu_temp(self):
        best = None
        for hw in sorted(glob.glob(self.host.p("/sys/class/hwmon/hwmon*"))):
            name = (self._read_abs(os.path.join(hw, "name")) or "").strip()
            for inp in sorted(glob.glob(os.path.join(hw, "temp*_input"))):
                label = (self._read_abs(inp.replace("_input", "_label")) or "").strip()
                key = ("%s_%s" % (name, label)).lower()
                if any(k in key for k in CPU_TEMP_KEYS):
                    v = self._read_milli(inp)
                    if v is not None and v > 0:
                        return v
        for tz in sorted(glob.glob(self.host.p("/sys/class/thermal/thermal_zone*"))):
            typ = (self._read_abs(os.path.join(tz, "type")) or "").strip().lower()
            if "cpu" in typ or "x86_pkg" in typ or "soc" in typ:
                v = self._read_milli(os.path.join(tz, "temp"))
                if v is not None and v > 0:
                    best = best if best is not None else v
        return best

    def drive_temp(self, device_base):
        """node-agent's driveTempPath: find the hwmon whose `device` symlink
        resolves to the disk's own canonical sysfs device."""
        kind, name = disk_of(device_base)
        if kind == "nvme":
            want = self.host.p("/sys/class/nvme/%s" % name)
        elif kind == "block":
            want = self.host.p("/sys/class/block/%s/device" % name)
        else:
            return None
        try:
            want_real = os.path.realpath(want)
            if not os.path.exists(want_real):
                return None
        except OSError:
            return None
        for hw in sorted(glob.glob(self.host.p("/sys/class/hwmon/hwmon*"))):
            try:
                if os.path.realpath(os.path.join(hw, "device")) != want_real:
                    continue
            except OSError:
                continue
            inputs = sorted(glob.glob(os.path.join(hw, "temp*_input")))
            if inputs:
                return self._read_milli(inputs[0])
        return None

    def smart_health(self, device_base, usb=False):
        if not self.host.is_real or not shutil.which("smartctl"):
            return "unknown"
        kind, name = disk_of(device_base)
        if not name:
            return "unknown"
        now = time.monotonic()
        cached = self.smart_cache.get(name)
        if cached and now - cached[0] < SMART_TTL:
            return cached[1]
        args = ["smartctl", "-H", "-n", "standby"]
        if usb:
            args += ["-d", "sat"]
        try:
            out = subprocess.run(args + ["/dev/%s" % name], capture_output=True, text=True, timeout=20).stdout
            health = parse_smart(out)
            if health == "unknown" and not usb and re.search(r"USB bridge|specify device type", out, re.I):
                out = subprocess.run(["smartctl", "-H", "-n", "standby", "-d", "sat", "/dev/%s" % name],
                                     capture_output=True, text=True, timeout=20).stdout
                health = parse_smart(out)
        except (OSError, subprocess.SubprocessError):
            health = "unknown"
        if health == "standby" and cached:
            health = cached[1]  # a sleeping disk keeps its last known verdict
        self.smart_cache[name] = (now, health)
        return health

    def service_active(self, unit):
        if not self.host.is_real or not shutil.which("systemctl"):
            return None
        now = time.monotonic()
        cached = self.service_cache.get(unit)
        if cached and now - cached[0] < SERVICE_TTL:
            return cached[1]
        try:
            rc = subprocess.run(["systemctl", "is-active", "--quiet", unit], timeout=5).returncode
            active = rc == 0
        except (OSError, subprocess.SubprocessError):
            active = None
        self.service_cache[unit] = (now, active)
        return active

    def statvfs(self, path):
        ok, st = run_with_timeout(os.statvfs, FS_TIMEOUT, self.host.p(path))
        if not ok or st is None:
            return None
        used = (st.f_blocks - st.f_bfree) * st.f_frsize
        free = st.f_bavail * st.f_frsize
        return {"total_bytes": used + free, "used_bytes": used, "free_bytes": free,
                "size_bytes": st.f_blocks * st.f_frsize}

    def docker_state(self):
        sock = self.host.p("/var/run/docker.sock")
        state = {"daemon": "down", "swarm_state": "unknown", "swarm_role": "none", "containers": []}
        if not os.path.exists(sock):
            state["daemon"] = "absent"
            return state, None
        try:
            info = docker_get(sock, "/info")
        except (OSError, ValueError, http.client.HTTPException):
            return state, None
        state["daemon"] = "running"
        swarm = info.get("Swarm") or {}
        state["swarm_state"] = swarm.get("LocalNodeState") or "inactive"
        if swarm.get("ControlAvailable"):
            state["swarm_role"] = "manager"
        elif state["swarm_state"] == "active":
            state["swarm_role"] = "worker"
        try:
            for c in docker_get(sock, "/containers/json") or []:
                labels = c.get("Labels") or {}
                names = c.get("Names") or ["?"]
                state["containers"].append({
                    "name": names[0].lstrip("/"),
                    "service": labels.get("com.docker.swarm.service.name"),
                    "state": c.get("State"),
                    "health": parse_health(c.get("Status")),
                })
        except (OSError, ValueError, http.client.HTTPException):
            pass
        nodes = None
        if state["swarm_role"] == "manager":
            try:
                nodes = []
                for n in docker_get(sock, "/nodes") or []:
                    spec = n.get("Spec") or {}
                    st = n.get("Status") or {}
                    mgr = n.get("ManagerStatus") or {}
                    nodes.append({
                        "hostname": (n.get("Description") or {}).get("Hostname"),
                        "id": n.get("ID"),
                        "role": spec.get("Role"),
                        "availability": spec.get("Availability"),
                        "state": st.get("State"),
                        "addr": st.get("Addr"),
                        "reachability": mgr.get("Reachability"),
                        "leader": bool(mgr.get("Leader")),
                        "labels": spec.get("Labels") or {},
                    })
            except (OSError, ValueError, http.client.HTTPException):
                nodes = None
        return state, nodes

    def heartbeats(self):
        out = {}
        if not self.repo_dir:
            return out
        for f in sorted(glob.glob(os.path.join(self.repo_dir, "cluster", "heartbeats", "*.json"))):
            try:
                with open(f, encoding="utf-8") as fh:
                    hb = json.load(fh)
                out[os.path.basename(f)[:-5]] = {
                    "received_at": hb.get("received_at"), "result": hb.get("result") or ("pass" if hb.get("ok") else "fail")}
            except (OSError, ValueError):
                continue
        return out

    # ---- helpers
    def _read_abs(self, abs_path):
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                return f.read()
        except OSError:
            return None

    def _read_milli(self, abs_path):
        raw = self._read_abs(abs_path)
        try:
            return round(float(raw.strip()) / 1000.0, 1)
        except (AttributeError, ValueError):
            return None

    # ---- one full collection
    def collect(self, deployment):
        deployment = deployment if isinstance(deployment, dict) else {}
        now_mono = time.monotonic()
        total, idle, cores = parse_proc_stat(self.host.read("/proc/stat", ""))
        mem = parse_meminfo(self.host.read("/proc/meminfo", ""))
        net = parse_net_dev(self.host.read("/proc/net/dev", ""))
        dstats = parse_diskstats(self.host.read("/proc/diskstats", ""))
        mounts = parse_mountinfo(self.host.read("/proc/self/mountinfo", ""))
        prev = self.prev
        dt = (now_mono - prev[0]) if prev else 0.0

        cpu_pct = None
        if prev and total > prev[1]:
            dtot, didle = total - prev[1], idle - prev[2]
            cpu_pct = round(max(0.0, min(100.0, 100.0 * (dtot - didle) / dtot)), 1)

        rx = sum(v[0] for v in net.values())
        tx = sum(v[1] for v in net.values())
        recv_bps = send_bps = None
        if prev and dt > 0:
            recv_bps = max(0, int((rx - prev[3][0]) / dt))
            send_bps = max(0, int((tx - prev[3][1]) / dt))

        uptime = None
        up = (self.host.read("/proc/uptime", "") or "").split()
        if up:
            try:
                uptime = int(float(up[0]))
            except ValueError:
                pass
        load = [float(x) for x in (self.host.read("/proc/loadavg", "") or "0 0 0").split()[:3]]

        alerts = []
        disks = []
        cap_total = cap_used = 0
        for d in deployment.get("drives") or []:
            if not isinstance(d, dict) or not d.get("label"):
                continue
            label = d["label"]
            mp = d.get("mountpoint") or ""
            mi = mounts.get(mp)
            mounted = bool(mi)
            device = mi["source"] if mi else None
            if mounted and d.get("uuid") and not str(d.get("uuid")).startswith("planned"):
                byuuid = self.host.p("/dev/disk/by-uuid/%s" % d["uuid"])
                if os.path.lexists(byuuid) and device:
                    if os.path.basename(os.path.realpath(byuuid)) != os.path.basename(device):
                        alerts.append({"level": "crit", "id": "drive-wrong-device-%s" % label,
                                       "message": "%s: %s is mounted from %s, not the recorded filesystem %s"
                                                  % (label, mp, device, d["uuid"])})
            entry = {"label": label, "uuid": d.get("uuid"), "device": device, "mountpoint": mp,
                     "mounted": mounted, "temp_celsius": None, "total_bytes": None, "used_bytes": None,
                     "free_bytes": None, "used_percent": None, "read_bytes": None, "write_bytes": None,
                     "read_bps": None, "write_bps": None, "smart_health": "unknown",
                     "blob_quota": {"limit_bytes": None, "used_bytes": None}}
            if mounted:
                # Only statvfs a path we KNOW is mounted: on an unmounted
                # mountpoint statvfs would report the root filesystem instead.
                usage = self.statvfs(mp)
                if usage:
                    entry.update(total_bytes=usage["total_bytes"], used_bytes=usage["used_bytes"],
                                 free_bytes=usage["free_bytes"])
                    if usage["total_bytes"]:
                        entry["used_percent"] = round(100.0 * usage["used_bytes"] / usage["total_bytes"], 1)
                        cap_total += usage["total_bytes"]
                        cap_used += usage["used_bytes"]
                        if entry["used_percent"] >= 90:
                            alerts.append({"level": "warn", "id": "disk-full-%s" % label,
                                           "message": "%s is %.0f%% full" % (label, entry["used_percent"])})
                base = os.path.basename(device or "")
                io = dstats.get(base)
                if io:
                    entry["read_bytes"], entry["write_bytes"] = io
                    pio = prev[4].get(base) if prev else None
                    if pio and dt > 0:
                        entry["read_bps"] = max(0, int((io[0] - pio[0]) / dt))
                        entry["write_bps"] = max(0, int((io[1] - pio[1]) / dt))
                entry["temp_celsius"] = self.drive_temp(base)
                entry["smart_health"] = self.smart_health(base, usb=(d.get("tran") == "usb"))
                if entry["smart_health"] == "FAILED":
                    alerts.append({"level": "crit", "id": "smart-failed-%s" % label,
                                   "message": "%s (%s) reports a FAILED SMART health check" % (label, base)})
                if d.get("prjquota") and d.get("data_dir"):
                    q = self.statvfs(d["data_dir"])
                    if q:
                        entry["blob_quota"] = {"limit_bytes": q["size_bytes"], "used_bytes": q["used_bytes"]}
            else:
                alerts.append({"level": "crit", "id": "drive-unmounted-%s" % label,
                               "message": "%s is not mounted at %s" % (label, mp or "?")})
            disks.append(entry)

        pools = []
        for pl in deployment.get("pools") or []:
            if not isinstance(pl, dict) or not pl.get("path"):
                continue
            path = pl["path"]
            mi = mounts.get(path)
            mounted = bool(mi and "mergerfs" in (mi.get("fstype") or ""))
            p_entry = {"path": path, "tier": pl.get("tier"), "mounted": mounted, "branches_ok": None,
                       "branches": None, "total_bytes": None, "used_bytes": None, "free_bytes": None}
            if mounted:
                ok, raw = run_with_timeout(os.getxattr, FS_TIMEOUT, self.host.p(os.path.join(path, ".mergerfs")),
                                           "user.mergerfs.branches")
                if ok:
                    have = mergerfs_branches(raw)
                    p_entry["branches"] = have
                    p_entry["branches_ok"] = sorted(have) == sorted(pl.get("branches") or [])
                    if not p_entry["branches_ok"]:
                        alerts.append({"level": "crit", "id": "pool-branches-%s" % (pl.get("tier") or path),
                                       "message": "pool %s serves branches %s, expected %s"
                                                  % (path, have, pl.get("branches"))})
                usage = self.statvfs(path)
                if usage:
                    p_entry.update(total_bytes=usage["total_bytes"], used_bytes=usage["used_bytes"],
                                   free_bytes=usage["free_bytes"])
            else:
                alerts.append({"level": "crit", "id": "pool-unmounted-%s" % (pl.get("tier") or path),
                               "message": "storage pool %s is not mounted — its MinIO stays down" % path})
            pools.append(p_entry)

        docker, nodes = self.docker_state()
        if docker["daemon"] != "running":
            alerts.append({"level": "crit", "id": "docker-down", "message": "the Docker daemon is not reachable"})
        expected = ((deployment.get("stack") or {}).get("services")) or []
        if docker["daemon"] == "running" and expected:
            running = {c.get("service") for c in docker["containers"] if c.get("state") == "running"}
            for svc in expected:
                full = svc if svc.startswith("apollo-sfs_") else "apollo-sfs_" + svc
                if full not in running:
                    alerts.append({"level": "warn", "id": "service-missing-%s" % svc,
                                   "message": "expected service %s has no running container on this node" % full})
        role = ((deployment.get("cluster") or {}).get("role"))
        if role == "manager":
            for unit in ("nginx", "fail2ban"):
                if self.service_active(unit) is False:
                    alerts.append({"level": "warn", "id": "%s-inactive" % unit, "message": "%s is not running" % unit})
            if docker["daemon"] == "running" and not any(c.get("name") == "registry" and c.get("state") == "running"
                                                         for c in docker["containers"]):
                alerts.append({"level": "warn", "id": "registry-down", "message": "the image registry container is not running"})

        swap_total = mem.get("SwapTotal", 0)
        metrics = {
            "hostname": socket.gethostname() if self.host.is_real else (self.host.read("/etc/hostname", "") or "").strip(),
            "sampled_at": iso_utc(),
            "uptime_seconds": uptime,
            "load_avg": load,
            "cpu": {"percent": cpu_pct, "temp_celsius": self.cpu_temp(), "cores": cores},
            "memory": {"used_bytes": max(0, mem.get("MemTotal", 0) - mem.get("MemAvailable", 0)),
                       "total_bytes": mem.get("MemTotal", 0), "available_bytes": mem.get("MemAvailable", 0)},
            "swap": {"used_bytes": max(0, swap_total - mem.get("SwapFree", 0)), "total_bytes": swap_total},
            "network": {"bytes_sent": tx, "bytes_recv": rx, "send_bps": send_bps, "recv_bps": recv_bps,
                        "interfaces": sorted(net.keys())},
            "drive_capacity": {"total_bytes": cap_total, "used_bytes": cap_used,
                               "percent": round(100.0 * cap_used / cap_total, 1) if cap_total else None,
                               "disk_count": len(disks)},
            "disks": disks,
            "pools": pools,
            "ping": dict(self.ping),
            "docker": docker,
        }
        self.prev = (now_mono, total, idle, (rx, tx), dstats)
        status = {"ok": not any(a["level"] == "crit" for a in alerts), "alerts": alerts, "checked_at": iso_utc()}
        out = {"metrics": metrics, "status": status}
        if nodes is not None:
            out["cluster_view"] = {"nodes": nodes, "heartbeats": self.heartbeats()}
        return out


def _owned_update(doc, result, interval, started_at):
    epoch = int(time.time())
    doc["last_updated"] = iso_utc(epoch)
    doc["last_updated_epoch"] = epoch
    doc["collector"] = {"name": NAME, "version": VERSION, "interval_seconds": interval,
                        "pid": os.getpid(), "started_at": started_at}
    doc["metrics"] = result["metrics"]
    doc["status"] = result["status"]
    if "cluster_view" in result:
        doc["cluster_view"] = result["cluster_view"]
    else:
        doc.pop("cluster_view", None)
    return doc


def _read_deployment(path):
    try:
        doc = apollo_node.read_json(path, missing_ok=True)
    except (ValueError, OSError):
        return {}
    return (doc or {}).get("deployment") or {}


def main_daemon(argv):
    ap = argparse.ArgumentParser(prog="apollo_node.py daemon")
    ap.add_argument("--output", required=True)
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("--lock")
    ap.add_argument("--host-root", default="/")
    ap.add_argument("--repo")
    ap.add_argument("--max-ticks", type=int, default=0, help="stop after N ticks (tests)")
    args = ap.parse_args(argv)
    repo = args.repo or os.path.dirname(os.path.abspath(args.output))
    stop = threading.Event()

    def _stop(signum, _frame):
        log("received signal %d — stopping" % signum)
        stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    collector = Collector(Host(args.host_root), repo_dir=repo)
    collector.start_ping_thread(stop)
    log("%s %s started (interval %.0fs, output %s)" % (NAME, VERSION, args.interval, args.output))
    next_tick = time.monotonic()
    ticks = 0
    last_err = None
    while not stop.is_set():
        try:
            result = collector.collect(_read_deployment(args.output))
            # Collection happens outside the lock (it can take a second); the
            # read-modify-write of node.json is the only locked section, so
            # deploy.sh is never blocked for long.
            with apollo_node.file_lock(args.lock):
                doc = apollo_node.read_json(args.output, missing_ok=True)
                if not isinstance(doc, dict):
                    doc = apollo_node.new_document()
                doc.setdefault("schema_version", apollo_node.SCHEMA_VERSION)
                apollo_node.atomic_write_json(args.output, _owned_update(doc, result, args.interval, collector.started_at))
            last_err = None
        except Exception as e:  # noqa: BLE001 — never die on one bad tick
            msg = "%s: %s" % (type(e).__name__, e)
            if msg != last_err:
                log("collection failed: " + msg)
            last_err = msg
        ticks += 1
        if args.max_ticks and ticks >= args.max_ticks:
            break
        next_tick += args.interval
        delay = next_tick - time.monotonic()
        if delay < 0:  # fell behind (slow disk, suspend) — re-anchor instead of bursting
            next_tick = time.monotonic()
            delay = 0
        stop.wait(delay)
    return 0


def main_collect(argv):
    ap = argparse.ArgumentParser(prog="apollo_node.py collect")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--node-json")
    ap.add_argument("--host-root", default="/")
    ap.add_argument("--repo")
    ap.add_argument("--pretty", action="store_true")
    ap.add_argument("--ping", action="store_true", help="also take one ping sample")
    args = ap.parse_args(argv)
    deployment = _read_deployment(args.node_json) if args.node_json else {}
    c = Collector(Host(args.host_root), repo_dir=args.repo, enable_ping=False)
    c.collect(deployment)                       # prime the deltas (cpu %, rates)
    time.sleep(0.5)
    if args.ping and Host(args.host_root).is_real and shutil.which("ping"):
        try:
            out = subprocess.run(["ping", "-c", "2", "-W", "1", "-q", "8.8.8.8"], capture_output=True, text=True,
                                 timeout=8).stdout
            ms, loss = parse_ping(out)
            c.ping = {"target": "8.8.8.8", "ms": ms, "loss_pct": loss, "sampled_at": iso_utc()}
        except (OSError, subprocess.SubprocessError):
            pass
    result = c.collect(deployment)
    doc = _owned_update({"schema_version": apollo_node.SCHEMA_VERSION}, result, 5, c.started_at)
    sys.stdout.write(json.dumps(doc, indent=2 if args.pretty else None) + "\n")
    return 0
