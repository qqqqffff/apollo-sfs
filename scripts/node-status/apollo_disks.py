"""apollo_disks.py — drive discovery + classification (python3 stdlib).

`apollo_node.py disks …` subcommands (all READ-ONLY; every input is a file so
the test harness can replay fixtures):

  list   --lsblk-json F [--swaps F] [--fstab F] [--crypttab F] [--mountinfo F]
         [--by-id F] [--sys-root D] [--node-json F]
         → {"disks":[…], "pools":[…], "warnings":[…]}
  fstab-fix --fstab F --target MNT [--add nofail,x-systemd.device-timeout=10]
         → the repaired fstab line for MNT (or nothing when it is already fine)

Classification of every whole disk (`status`):
  system   backs /, /boot*, /usr, /var, /home, swap — or is the boot SD card
  in_use   LVM/md/LUKS/ZFS member, held (device-mapper), mounted somewhere that
           is not an Apollo path, referenced in fstab/crypttab, read-only, an
           extra SD/eMMC card
  apollo   carries an Apollo label (nvme-NN / ssd-NN / hdd-NN) or a UUID that
           node.json records → ADOPTED, never formatted
  foreign  has partitions / filesystems / a partition table → typed ERASE
  blank    nothing on it → typed device name
The removable flag alone never excludes a disk (USB bridges set it).
"""

import argparse
import json
import os
import re
import sys

APOLLO_LABEL = re.compile(r"^(nvme|ssd|hdd)-\d{2}$")
APOLLO_PATH = re.compile(r"/(nvme|ssd|hdd)-\d{2}(/.*)?$|/pool(-[a-z]+)?$")
SYSTEM_MOUNTS = ("/", "/usr", "/var", "/home", "/etc", "/opt", "/root", "/tmp")
MEMBER_FSTYPES = {"LVM2_member": "LVM physical volume", "linux_raid_member": "md RAID member",
                  "crypto_LUKS": "LUKS container", "zfs_member": "ZFS pool member", "bcache": "bcache device",
                  "ceph_bluestore": "Ceph OSD", "btrfs_member": "btrfs multi-device member"}
SKIP_NAME = re.compile(r"^(loop|zram|ram|sr|fd)\d*|^mmcblk\d+(boot\d+|rpmb)$")


def _read(path, default=""):
    if not path:
        return default
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return default


def _truthy(v):
    return v in (True, 1, "1", "true", "True")


def flatten(dev):
    """The device and all descendants (partitions, dm, md…), depth first."""
    out = [dev]
    for c in dev.get("children") or []:
        out += flatten(c)
    return out


def mountpoints_of(dev):
    mps = []
    for key in ("mountpoints", "mountpoint"):
        v = dev.get(key)
        if isinstance(v, list):
            mps += [m for m in v if m]
        elif v:
            mps.append(v)
    return sorted(set(mps))


def parse_swaps(text):
    return {line.split()[0] for line in text.splitlines()[1:] if line.strip()}


def parse_fstab(text):
    """[{spec, target, fstype, options, line}] for non-comment lines."""
    out = []
    for line in text.splitlines():
        s = line.split("#", 1)[0].strip() if not line.strip().startswith("#") else ""
        if not s:
            continue
        f = s.split()
        if len(f) >= 2:
            out.append({"spec": f[0], "target": f[1], "fstype": f[2] if len(f) > 2 else "",
                        "options": f[3] if len(f) > 3 else "defaults", "line": line})
    return out


def parse_crypttab(text):
    out = []
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            f = s.split()
            if len(f) >= 2:
                out.append({"name": f[0], "spec": f[1]})
    return out


def parse_mountinfo(text):
    out = []
    for line in text.splitlines():
        if " - " not in line:
            continue
        pre, post = line.split(" - ", 1)
        a, b = pre.split(), post.split()
        if len(a) >= 5 and len(b) >= 2:
            unesc = lambda s: re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)
            out.append({"target": unesc(a[4]), "fstype": b[0], "source": unesc(b[1]), "options": a[5] if len(a) > 5 else ""})
    return out


def parse_by_id(text):
    """'<id> <link target>' lines → {kernel name: [ids]} (stable names first)."""
    out = {}
    for line in text.splitlines():
        f = line.split()
        if len(f) >= 2:
            out.setdefault(os.path.basename(f[1]), []).append(f[0])
    for k, ids in out.items():
        ids.sort(key=lambda i: (i.startswith(("wwn-", "nvme-eui.", "nvme-nvme.")), i))
    return out


def spec_matches(spec, part):
    """Does an fstab/crypttab spec (UUID=, PARTUUID=, LABEL=, /dev/…) name part?"""
    if spec.startswith("UUID="):
        return bool(part.get("uuid")) and spec[5:].strip('"') == part.get("uuid")
    if spec.startswith("PARTUUID="):
        return bool(part.get("partuuid")) and spec[9:].strip('"').lower() == (part.get("partuuid") or "").lower()
    if spec.startswith("LABEL="):
        return bool(part.get("label")) and spec[6:].strip('"') == part.get("label")
    if spec.startswith("/dev/disk/by-uuid/"):
        return spec.rsplit("/", 1)[1] == part.get("uuid")
    if spec.startswith("/dev/disk/by-label/"):
        return spec.rsplit("/", 1)[1] == part.get("label")
    if spec.startswith("/dev/"):
        return spec == part.get("path") or os.path.basename(spec) == part.get("name")
    return False


def is_apollo_path(mp, apollo_mounts):
    return mp in apollo_mounts or bool(APOLLO_PATH.search(mp or ""))


def class_guess(dev):
    tran = (dev.get("tran") or "").lower()
    name = dev.get("name") or ""
    if tran == "nvme" or name.startswith("nvme"):
        return "nvme"
    if _truthy(dev.get("rota")):
        return "hdd"
    return "ssd"


def classify(disk, ctx):
    """Return the public description of one whole disk."""
    reasons = []
    status = None
    devs = flatten(disk)
    name = disk.get("name") or ""
    apollo_label = None
    data_part = None
    for d in devs:
        lab = d.get("label") or ""
        if APOLLO_LABEL.match(lab) or (d.get("uuid") and d.get("uuid") in ctx["recorded_uuids"]):
            if apollo_label is None:
                apollo_label, data_part = lab or ctx["recorded_uuids"].get(d.get("uuid")), d
    mounted = []
    for d in devs:
        for mp in mountpoints_of(d) + ctx["mounts_by_dev"].get(d.get("path") or "", []):
            mounted.append((d, mp))
    # ---- system
    for d, mp in mounted:
        if mp == "[SWAP]" or d.get("path") in ctx["swaps"]:
            status = "system"; reasons.append("%s is active swap" % d.get("name"))
        elif mp in SYSTEM_MOUNTS or mp.startswith("/boot"):
            status = "system"; reasons.append("%s backs %s" % (d.get("name"), mp))
    for d in devs:
        if d.get("path") in ctx["swaps"] and "active swap" not in " ".join(reasons):
            status = "system"; reasons.append("%s is active swap" % d.get("name"))
    if name.startswith("mmcblk") and status != "system":
        status = "in_use"; reasons.append("SD/eMMC card — not used for Apollo storage")
    # ---- in use
    if status is None:
        if _truthy(disk.get("ro")):
            status = "in_use"; reasons.append("read-only device")
        for d in devs:
            fst = d.get("fstype") or ""
            if fst in MEMBER_FSTYPES:
                status = "in_use"; reasons.append("%s is a %s" % (d.get("name"), MEMBER_FSTYPES[fst]))
            if d is not disk and (d.get("type") or "") not in ("part", "disk"):
                status = "in_use"; reasons.append("%s is in use as %s" % (d.get("name"), d.get("type")))
        for d in devs:
            held = ctx["holders"].get(d.get("name") or "")
            if held:
                status = "in_use"; reasons.append("%s is held by %s" % (d.get("name"), ", ".join(held)))
        for d, mp in mounted:
            if not is_apollo_path(mp, ctx["apollo_mounts"]):
                status = "in_use"; reasons.append("%s is mounted at %s" % (d.get("name"), mp))
        for d in devs:
            for e in ctx["fstab"]:
                if spec_matches(e["spec"], d) and not is_apollo_path(e["target"], ctx["apollo_mounts"]):
                    status = "in_use"; reasons.append("%s is listed in /etc/fstab for %s" % (d.get("name"), e["target"]))
            for e in ctx["crypttab"]:
                if spec_matches(e["spec"], d):
                    status = "in_use"; reasons.append("%s is listed in /etc/crypttab (%s)" % (d.get("name"), e["name"]))
    # ---- apollo / foreign / blank
    if status is None:
        if apollo_label:
            status = "apollo"
            reasons.append("Apollo drive %s — adopted, never formatted" % apollo_label)
        elif len(devs) > 1 or disk.get("fstype") or disk.get("pttype") or disk.get("label"):
            status = "foreign"
            what = [d.get("fstype") or d.get("type") for d in devs[1:]] or [disk.get("fstype") or disk.get("pttype") or "data"]
            reasons.append("contains %s — erasing it destroys that data" % ", ".join(sorted({w for w in what if w})))
        else:
            status = "blank"
            reasons.append("no partitions or filesystems")
    cls = class_guess(disk)
    tran = (disk.get("tran") or "").lower()
    part = data_part or (devs[1] if len(devs) > 1 else disk)
    part_mps = mountpoints_of(part) + ctx["mounts_by_dev"].get(part.get("path") or "", [])
    return {
        "name": name, "path": disk.get("path") or "/dev/" + name,
        "by_id": (ctx["by_id"].get(name) or [None])[0],
        "size_bytes": int(disk.get("size") or 0), "model": (disk.get("model") or "").strip(),
        "serial": (disk.get("serial") or "").strip(), "wwn": disk.get("wwn"), "tran": tran or None,
        "rota": _truthy(disk.get("rota")), "removable": _truthy(disk.get("rm")) or _truthy(disk.get("hotplug")),
        "class_guess": cls, "tier_guess": "standard" if cls == "hdd" else "fast",
        "needs_class_confirm": tran == "usb",
        "status": status, "reasons": reasons, "label": apollo_label,
        "part_path": part.get("path"), "part_name": part.get("name"),
        "uuid": part.get("uuid"), "partuuid": part.get("partuuid"), "fstype": part.get("fstype"),
        "part_size_bytes": int(part.get("size") or disk.get("size") or 0),
        "mountpoint": (part_mps or [None])[0],
        "children": [{"name": d.get("name"), "path": d.get("path"), "type": d.get("type"), "fstype": d.get("fstype"),
                      "label": d.get("label"), "uuid": d.get("uuid"), "partuuid": d.get("partuuid"),
                      "size_bytes": int(d.get("size") or 0), "mountpoints": mountpoints_of(d)} for d in devs[1:]],
    }


def discover_pools(fstab, mounts):
    """mergerfs pools from fstab (static truth) + mountinfo (mounted?)."""
    mounted = {m["target"]: m for m in mounts if "mergerfs" in m["fstype"]}
    pools = []
    for e in fstab:
        if "mergerfs" not in e["fstype"]:
            continue
        pools.append({"path": e["target"], "branches": [b for b in e["spec"].split(":") if b],
                      "options": e["options"], "fstab_line": e["line"], "mounted": e["target"] in mounted,
                      "nofail": "nofail" in e["options"].split(",")})
    for t, m in mounted.items():
        if not any(p["path"] == t for p in pools):
            pools.append({"path": t, "branches": [], "options": m["options"], "fstab_line": None,
                          "mounted": True, "nofail": False})
    return pools


def build_context(args):
    node = {}
    if args.node_json:
        try:
            node = json.loads(_read(args.node_json, "{}") or "{}")
        except ValueError:
            node = {}
    dep = node.get("deployment") or {}
    recorded = {d.get("uuid"): d.get("label") for d in dep.get("drives") or [] if d.get("uuid")}
    apollo_mounts = {d.get("mountpoint") for d in dep.get("drives") or [] if d.get("mountpoint")}
    apollo_mounts |= {d.get("data_dir") for d in dep.get("drives") or [] if d.get("data_dir")}
    apollo_mounts |= {p.get("path") for p in dep.get("pools") or [] if p.get("path")}
    mounts = parse_mountinfo(_read(args.mountinfo))
    by_dev = {}
    for m in mounts:
        if m["source"].startswith("/dev/"):
            by_dev.setdefault(m["source"], []).append(m["target"])
    holders = {}
    root = args.sys_root or "/"
    for d in [os.path.join(root, "sys/block", x) for x in _listdir(os.path.join(root, "sys/block"))]:
        h = _listdir(os.path.join(d, "holders"))
        if h:
            holders[os.path.basename(d)] = h
        for part in _listdir(d):
            ph = _listdir(os.path.join(d, part, "holders"))
            if ph:
                holders[part] = ph
    return {"swaps": parse_swaps(_read(args.swaps)), "fstab": parse_fstab(_read(args.fstab)),
            "crypttab": parse_crypttab(_read(args.crypttab)), "mounts": mounts, "mounts_by_dev": by_dev,
            "holders": holders, "by_id": parse_by_id(_read(args.by_id)), "recorded_uuids": recorded,
            "apollo_mounts": apollo_mounts}


def _listdir(p):
    try:
        return sorted(os.listdir(p))
    except OSError:
        return []


def _label_owner(cands, ctx):
    """Among disks carrying the same Apollo label, the one that really IS that
    drive: recorded in node.json > mounted now > named in fstab by UUID/PARTUUID.
    None when that can't be decided."""
    recorded = ctx["recorded_uuids"]
    for test in (lambda d: d.get("uuid") in recorded,
                 lambda d: bool(d.get("mountpoint")),
                 lambda d: any(e["spec"].startswith(("UUID=", "PARTUUID=", "/dev/disk/by-uuid/"))
                               and spec_matches(e["spec"], {"uuid": d.get("uuid"), "partuuid": d.get("partuuid")})
                               for e in ctx["fstab"])):
        hits = [d for d in cands if test(d)]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            return None
    return None


def resolve_duplicate_labels(disks, ctx, warnings):
    """Two filesystems with the same Apollo label (e.g. a new drive prepared by
    hand as "nvme-01"): only the real one may be adopted. The others become
    foreign (format to use them) — adopting one would mount the wrong disk."""
    by_label = {}
    for d in disks:
        if d["status"] == "apollo" and d["label"]:
            by_label.setdefault(d["label"], []).append(d)
    for lab, cands in by_label.items():
        if len(cands) < 2:
            continue
        owner = _label_owner(cands, ctx)
        for d in cands:
            d["duplicate_label"] = True
            if d is owner:
                d["reasons"].append("other disks also carry the label %s; this one is the real %s (%s)"
                                    % (lab, lab, "recorded" if d.get("uuid") in ctx["recorded_uuids"]
                                       else "mounted" if d.get("mountpoint") else "in /etc/fstab"))
                continue
            if owner is not None:
                d["status"] = "foreign"
                d["label"] = None
                d["reasons"] = ["carries the label %s, but %s is the real %s — a duplicate; formatting it gives it a new label "
                                "(erases its data)" % (lab, owner["name"], lab)]
            else:
                d["status"] = "in_use"
                d["reasons"] = ["label %s is on more than one disk and none is mounted or recorded — relabel the extra one "
                                "first (xfs_admin -L / e2label) so the right disk is adopted" % lab]
        warnings.append("label %s is on %s — %s" % (
            lab, ", ".join(c["name"] for c in cands),
            ("only %s is adopted; the other(s) can be formatted" % owner["name"]) if owner
            else "none can be adopted until the duplicates are relabelled"))


def cmd_list(args):
    data = json.loads(_read(args.lsblk_json, "{}") or "{}")
    ctx = build_context(args)
    disks, warnings = [], []
    for dev in data.get("blockdevices") or []:
        name = dev.get("name") or ""
        if (dev.get("type") or "") != "disk" or SKIP_NAME.match(name):
            continue
        disks.append(classify(dev, ctx))
    resolve_duplicate_labels(disks, ctx, warnings)
    print(json.dumps({"disks": disks, "pools": discover_pools(ctx["fstab"], ctx["mounts"]), "warnings": warnings}))
    return 0


def fstab_fix(text, target, add):
    """Return the fstab line for TARGET with ADD options ensured, or None."""
    for e in parse_fstab(text):
        if e["target"] != target:
            continue
        opts = e["options"].split(",")
        missing = [o for o in add if o.split("=")[0] not in {x.split("=")[0] for x in opts}]
        if not missing:
            return None
        fields = e["line"].split("#", 1)[0].split()
        fields[3] = ",".join(opts + missing)
        while len(fields) < 6:
            fields.append("0")
        return " ".join(fields)
    return None


def main(argv):
    ap = argparse.ArgumentParser(prog="apollo_node.py disks")
    sub = ap.add_subparsers(dest="cmd", required=True)
    l = sub.add_parser("list")
    for opt in ("--lsblk-json", "--swaps", "--fstab", "--crypttab", "--mountinfo", "--by-id", "--node-json"):
        l.add_argument(opt)
    l.add_argument("--sys-root", default="/")
    f = sub.add_parser("fstab-fix")
    f.add_argument("--fstab", required=True)
    f.add_argument("--target", required=True)
    f.add_argument("--add", default="nofail,x-systemd.device-timeout=10")
    args = ap.parse_args(argv)
    if args.cmd == "list":
        if not args.lsblk_json:
            print("disks list: --lsblk-json is required", file=sys.stderr)
            return 2
        return cmd_list(args)
    if args.cmd == "fstab-fix":
        line = fstab_fix(_read(args.fstab), args.target, [o for o in args.add.split(",") if o])
        if line:
            print(line)
        return 0
    return 2
