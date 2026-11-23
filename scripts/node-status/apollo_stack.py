"""apollo_stack.py — renders cluster/docker-stack.nodes.yml (python3 stdlib).

The per-node services (a node-agent per node, the blob-storage MinIO instances)
are generated from node records in cluster/nodes/<hostname>.json (schema in
docs/node_provisioning.md) and deployed alongside docker-stack.yml:

    docker stack deploy -c docker-stack.yml -c cluster/docker-stack.nodes.yml apollo-sfs

Rendering reproduces the pre-2.0 definitions (scripts/deploy/templates/
legacy-node-services.yml) line for line — same names, constraints, env and
volume order — so adopting today's nodes changes no service spec and restarts
nothing. tests/python/test_stack_render.py proves it.

Subcommands (via `apollo_node.py stack …`):
  render        --nodes-dir D [--out F|-]
  legacy-seeds  [--fast-host H] [--standard-host H] [--now ISO]
  merge-record  --nodes-dir D --hostname H --request F [--now ISO]
  tiers         --nodes-dir D
  services      --nodes-dir D --hostname H
  compare       --a F --b F          (structural compare of two compose files)
"""

import argparse
import glob
import json
import os
import re
import sys
import time

HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
SERVICE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]+$")
LABEL_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,15}$")
PLACEMENT_RE = re.compile(r"^node\.(hostname == [a-z0-9-]+|labels\.tier == (fast|standard))$")
MINIO_FOR_TIER = {"fast": "minio", "standard": "minio-standard"}

# The pre-2.0 per-node services, as data (see the template file for the text).
LEGACY = {
    "standard": {
        "services": {"agent": "node-agent-standard", "minio": "minio-standard"},
        "placement": "node.labels.tier == standard",
        "disk_mounts": [{"label": "hdd-01", "path": "/srv/minio/hdd-01"}],
        "minio_data_path": "/srv/minio/hdd-01/data",
        "role": "manager",
    },
    "fast": {
        "services": {"agent": "node-agent-fast", "minio": "minio"},
        "placement": "node.labels.tier == fast",
        "disk_mounts": [{"label": "nvme-01", "path": "/home/apollo/apollo-sfs/minio/nvme-01"},
                        {"label": "nvme-02", "path": "/home/apollo/apollo-sfs/minio/nvme-02"}],
        "minio_data_path": "/home/apollo/apollo-sfs/minio/pool",
        "role": "worker",
    },
}

AGENT_IMAGE = "${REGISTRY:-192.168.68.57:5000}/apollo-sfs-node-agent:${NODE_AGENT_TAG}"
LOGGING = ["    logging:", "      driver: json-file", '      options: { max-size: "10m", max-file: "3" }']


class RecordError(Exception):
    pass


def iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def bench_mounts(rec):
    """Benchmark scratch dirs: <mount>/.bench → /bench/<label> (rw)."""
    if rec.get("bench_mounts"):
        return rec["bench_mounts"]
    return [{"label": m["label"], "host": m["path"].rstrip("/") + "/.bench", "container": "/bench/" + m["label"]}
            for m in rec.get("disk_mounts") or []]


def validate_record(rec):
    h = rec.get("hostname", "")
    if not HOST_RE.match(h) and not h.startswith("legacy-"):
        raise RecordError("bad hostname %r" % h)
    svc = rec.get("services") or {}
    if not SERVICE_RE.match(svc.get("agent") or ""):
        raise RecordError("%s: bad agent service name %r" % (h, svc.get("agent")))
    if svc.get("minio") not in (None, "minio", "minio-standard"):
        raise RecordError("%s: bad minio service name %r" % (h, svc.get("minio")))
    if not PLACEMENT_RE.match(rec.get("placement") or ""):
        raise RecordError("%s: bad placement %r" % (h, rec.get("placement")))
    for m in rec.get("disk_mounts") or []:
        if not LABEL_RE.match(m.get("label") or "") or not PATH_RE.match(m.get("path") or ""):
            raise RecordError("%s: bad disk mount %r" % (h, m))
    for b in bench_mounts(rec):
        if not PATH_RE.match(b.get("host") or "") or not PATH_RE.match(b.get("container") or ""):
            raise RecordError("%s: bad bench mount %r" % (h, b))
    if svc.get("minio") and not PATH_RE.match(rec.get("minio_data_path") or ""):
        raise RecordError("%s: blob storage needs a valid minio_data_path" % h)


def deploy_block(placement):
    return ["    networks: [app-network]",
            "    deploy:",
            "      replicas: 1",
            "      placement:",
            "        constraints: [%s]" % placement,
            "      restart_policy:",
            "        condition: any"] + LOGGING


def render_agent(rec):
    name = rec["services"]["agent"]
    mounts = rec.get("disk_mounts") or []
    bench = bench_mounts(rec)
    out = ["  # node-agent for %s — CPU/memory/network/drive metrics → node-metrics-ingest"
           % rec["hostname"], "  %s:" % name,
           "    image: %s" % AGENT_IMAGE,
           "    environment:",
           '      NODE_HOSTNAME: "{{.Node.Hostname}}"',
           "      NODE_METRICS_INGEST_URL: http://node-metrics-ingest:8080",
           "      NODE_AGENT_TOKEN: ${NODE_AGENT_TOKEN}"]
    if mounts:
        out.append('      NODE_DISK_MOUNTS: "%s"' % ",".join("%s:%s" % (m["label"], m["path"]) for m in mounts))
        out.append('      NODE_BENCHMARK_MOUNTS: "%s"' % ",".join("%s:%s" % (b["label"], b["container"]) for b in bench))
    out += ["    volumes:", "      - /sys:/sys:ro", "      - /dev/disk/by-label:/dev/disk/by-label:ro"]
    out += ["      - %s:%s:ro" % (m["path"], m["path"]) for m in mounts]
    out += ["      - %s:%s" % (b["host"], b["container"]) for b in bench]
    out += deploy_block(rec["placement"])
    return out


def render_minio(rec):
    name = rec["services"]["minio"]
    tier = "fast" if name == "minio" else "standard"
    return ["  # %s — %s-tier blob storage on %s" % (name, tier, rec["hostname"]),
            "  %s:" % name,
            "    image: minio/minio:latest",
            '    command: server /data --console-address ":9001"',
            "    environment:",
            "      MINIO_ROOT_USER: ${MINIO_ROOT_USER}",
            "      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}",
            "    volumes:",
            "      - %s:/data" % rec["minio_data_path"],
            "    healthcheck:",
            '      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]',
            "      interval: 30s",
            "      timeout: 10s",
            "      retries: 3",
            "      start_period: 15s"] + deploy_block(rec["placement"])


def load_records(nodes_dir):
    recs = []
    for f in sorted(glob.glob(os.path.join(nodes_dir, "*.json"))):
        with open(f, encoding="utf-8") as fh:
            rec = json.load(fh)
        validate_record(rec)
        recs.append(rec)
    return recs


def check_unique(recs):
    seen = {}
    for r in recs:
        for kind in ("agent", "minio"):
            n = (r.get("services") or {}).get(kind)
            if not n:
                continue
            if n in seen:
                raise RecordError("service %s is claimed by both %s and %s" % (n, seen[n], r["hostname"]))
            seen[n] = r["hostname"]


def render(recs):
    check_unique(recs)
    lines = ["# ─────────────────────────────────────────────────────────────────────────────",
             "# cluster/docker-stack.nodes.yml — GENERATED by deploy.sh from cluster/nodes/*.json.",
             "# Do not edit: re-render with `./deploy.sh update` on the manager. Deployed with:",
             "#   docker stack deploy -c docker-stack.yml -c cluster/docker-stack.nodes.yml apollo-sfs",
             "# ─────────────────────────────────────────────────────────────────────────────",
             "", "services:", ""]
    blocks = []
    for r in recs:
        if (r.get("services") or {}).get("minio"):
            blocks.append((0, r["services"]["minio"], render_minio(r)))
        blocks.append((1, r["services"]["agent"], render_agent(r)))
    for _, _, b in sorted(blocks, key=lambda x: (x[0], x[1])):
        lines += b + [""]
    lines += ["networks:", "  app-network:", "    driver: overlay",
              "    attachable: true      # same definition as docker-stack.yml (the files are merged)", ""]
    return "\n".join(lines)


def legacy_seeds(fast_host=None, standard_host=None, now=None):
    now = now or iso_now()
    out = []
    for tier, host in (("standard", standard_host), ("fast", fast_host)):
        base = LEGACY[tier]
        rec = {"hostname": host or ("legacy-%s" % tier), "seeded": True, "registered_at": now, "updated_at": now,
               "role": base["role"], "address": None, "arch": None, "tier": tier,
               "services": dict(base["services"]), "placement": base["placement"],
               "disk_mounts": [dict(m) for m in base["disk_mounts"]],
               "minio_data_path": base["minio_data_path"], "deployment": None}
        out.append(rec)
    return out


def _dep(request):
    dep = request.get("deployment") or {}
    return dep if isinstance(dep, dict) else {}


def merge_record(existing, request, hostname, tiers_taken, now=None):
    """Return (record, warnings). Raises RecordError on conflicts."""
    now = now or iso_now()
    warnings = []
    dep = _dep(request)
    node = dep.get("node") or {}
    cluster = dep.get("cluster") or {}
    storage = dep.get("storage") or {}
    roles = dep.get("roles") or {}
    phase = request.get("phase") or "full"
    rec = dict(existing) if existing else {"hostname": hostname, "seeded": False, "registered_at": now}
    rec["hostname"] = hostname
    rec["updated_at"] = now
    rec["role"] = cluster.get("role") or rec.get("role")
    rec["address"] = node.get("ip") or rec.get("address")
    rec["arch"] = node.get("arch") or rec.get("arch")
    drives = [d for d in dep.get("drives") or [] if isinstance(d, dict) and d.get("label") and d.get("mountpoint")
              and not d.get("unassigned")]
    if drives or not existing:
        rec["disk_mounts"] = [{"label": d["label"], "path": d["mountpoint"]} for d in drives]
        rec["bench_mounts"] = [{"label": d["label"], "host": d.get("bench_dir") or d["mountpoint"].rstrip("/") + "/.bench",
                                "container": "/bench/" + d["label"]} for d in drives]
    tier = storage.get("tier") or rec.get("tier")
    rec["tier"] = tier
    services = dict(rec.get("services") or {})
    if not services.get("agent"):
        services["agent"] = "node-agent-%s" % hostname
    old_name = rec.pop("renamed_from", None) if existing else None
    if old_name and rec.get("placement") == "node.hostname == %s" % old_name:
        # Renamed node: Swarm knows it by the new hostname now. Service names
        # (node-agent-<old>, minio*) are kept so nothing is recreated.
        rec["placement"] = "node.hostname == %s" % hostname
        warnings.append("%s was renamed from %s: its services now follow the new hostname" % (hostname, old_name))
    if old_name:
        rec.setdefault("previous_names", [])
        if old_name not in rec["previous_names"]:
            rec["previous_names"] = rec["previous_names"] + [old_name]
    if not rec.get("placement"):
        rec["placement"] = "node.hostname == %s" % hostname

    blob = (roles.get("blob_storage_shard") or {}).get("enabled")
    if phase == "full" and blob is not None:
        if blob:
            if tier not in MINIO_FOR_TIER:
                raise RecordError("%s holds the blob storage role but has no storage tier" % hostname)
            want = MINIO_FOR_TIER[tier]
            holder = tiers_taken.get(tier)
            if holder and holder != hostname:
                raise RecordError("the %s tier is already served by %s (one blob node per tier — the API supports "
                                  "exactly one MinIO endpoint per tier)" % (tier, holder))
            if services.get("minio") and services["minio"] != want:
                raise RecordError("%s already serves %s; changing its tier needs a data migration"
                                  % (hostname, services["minio"]))
            services["minio"] = want
        elif services.get("minio"):
            warnings.append("%s no longer holds the blob storage role, but its MinIO service (%s) is kept: removing "
                            "it would strand the data. Migrate the data first, then remove the service by hand."
                            % (hostname, services["minio"]))
    if services.get("minio"):
        pools = [p for p in dep.get("pools") or [] if isinstance(p, dict) and p.get("tier") == tier and p.get("path")]
        tier_drives = [d for d in drives if d.get("tier") == tier and d.get("data_dir")]
        if pools:
            rec["minio_data_path"] = pools[0]["path"]
        elif len(tier_drives) == 1:
            rec["minio_data_path"] = tier_drives[0]["data_dir"]
        elif not rec.get("minio_data_path"):
            raise RecordError("%s: cannot tell where MinIO's data lives (no pool and %d %s drives)"
                              % (hostname, len(tier_drives), tier))
    rec["services"] = services
    rec["deployment"] = dep or rec.get("deployment")
    validate_record(rec)
    return rec, warnings


def tiers(recs):
    out = {"fast": None, "standard": None}
    for r in recs:
        m = (r.get("services") or {}).get("minio")
        if m == "minio":
            out["fast"] = r["hostname"]
        elif m == "minio-standard":
            out["standard"] = r["hostname"]
    return out


# ── structural comparison (tests + drift) ───────────────────────────────────
def service_blocks(text):
    """{service: [normalised lines]} for the top-level `services:` map —
    comments and blank lines dropped, trailing inline comments stripped."""
    blocks, cur, in_services = {}, None, False
    for raw in text.splitlines():
        line = re.sub(r"\s+#[^\"']*$", "", raw).rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if re.match(r"^\S", line):
            in_services = line.startswith("services:")
            cur = None
            continue
        if not in_services:
            continue
        m = re.match(r"^  ([a-z0-9][a-z0-9-]*):$", line)
        if m:
            cur = m.group(1)
            blocks[cur] = []
            continue
        if cur:
            # Keep the indentation (it IS the YAML structure); only collapse runs of
            # spaces inside the content, e.g. aligned inline comments.
            indent = len(line) - len(line.lstrip(" "))
            blocks[cur].append(" " * indent + re.sub(r"\s+", " ", line.strip()))
    return blocks


def compare(a_text, b_text):
    a, b = service_blocks(a_text), service_blocks(b_text)
    diffs = []
    for name in sorted(set(a) | set(b)):
        if name not in a:
            diffs.append("+ service %s" % name)
        elif name not in b:
            diffs.append("- service %s" % name)
        elif a[name] != b[name]:
            for i, (x, y) in enumerate(zip(a[name] + [""] * len(b[name]), b[name] + [""] * len(a[name]))):
                if x != y:
                    diffs.append("~ %s line %d: %r != %r" % (name, i, x, y))
                    break
    return diffs


def main(argv):
    ap = argparse.ArgumentParser(prog="apollo_node.py stack")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render")
    r.add_argument("--nodes-dir", required=True)
    r.add_argument("--out", default="-")
    s = sub.add_parser("legacy-seeds")
    s.add_argument("--fast-host")
    s.add_argument("--standard-host")
    s.add_argument("--now")
    m = sub.add_parser("merge-record")
    m.add_argument("--nodes-dir", required=True)
    m.add_argument("--hostname", required=True)
    m.add_argument("--request", required=True)
    m.add_argument("--now")
    t = sub.add_parser("tiers")
    t.add_argument("--nodes-dir", required=True)
    v = sub.add_parser("services")
    v.add_argument("--nodes-dir", required=True)
    v.add_argument("--hostname", required=True)
    c = sub.add_parser("compare")
    c.add_argument("--a", required=True)
    c.add_argument("--b", required=True)
    args = ap.parse_args(argv)
    try:
        if args.cmd == "render":
            text = render(load_records(args.nodes_dir))
            if args.out == "-":
                sys.stdout.write(text)
            else:
                import apollo_node
                apollo_node.guard_write(args.out)
                with open(args.out, "w", encoding="utf-8") as f:
                    f.write(text)
            return 0
        if args.cmd == "legacy-seeds":
            print(json.dumps(legacy_seeds(args.fast_host, args.standard_host, args.now), indent=2))
            return 0
        if args.cmd == "merge-record":
            if not HOST_RE.match(args.hostname):
                raise RecordError("bad hostname %r" % args.hostname)
            with open(args.request, encoding="utf-8") as f:
                request = json.load(f)
            recs = load_records(args.nodes_dir)
            existing = next((x for x in recs if x["hostname"] == args.hostname), None)
            prev_names = request.get("previous_names") or []
            if existing is None:
                existing = next((x for x in recs if x["hostname"] in prev_names), None)
                if existing is not None:
                    existing = dict(existing, renamed_from=existing["hostname"])
            taken = tiers([x for x in recs if x["hostname"] != args.hostname and
                           (existing is None or x["hostname"] != existing.get("renamed_from"))])
            rec, warnings = merge_record(existing, request, args.hostname, taken, args.now)
            for w in warnings:
                print("warning: " + w, file=sys.stderr)
            print(json.dumps(rec, indent=2))
            return 0
        if args.cmd == "tiers":
            print(json.dumps(tiers(load_records(args.nodes_dir))))
            return 0
        if args.cmd == "services":
            rec = next((x for x in load_records(args.nodes_dir) if x["hostname"] == args.hostname), None)
            names = []
            if rec:
                names = [n for n in (rec["services"].get("minio"), rec["services"].get("agent")) if n]
            print(json.dumps(names))
            return 0
        if args.cmd == "compare":
            with open(args.a, encoding="utf-8") as fa, open(args.b, encoding="utf-8") as fb:
                diffs = compare(fa.read(), fb.read())
            for d in diffs:
                print(d)
            return 0 if not diffs else 1
    except RecordError as e:
        print("stack: %s" % e, file=sys.stderr)
        return 3
    except (OSError, ValueError) as e:
        print("stack: %s" % e, file=sys.stderr)
        return 1
    return 2
