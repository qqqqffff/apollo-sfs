# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/drives.sh — drive discovery, formatting, mounts and mergerfs pools (WS2).
#
# Safety rules (each one exists because the failure it prevents loses data):
#   * apollo_disks.py classifies every disk; system/in_use disks are never
#     offered, Apollo-labelled disks are ADOPTED (never formatted), anything
#     else needs a typed confirmation (`ERASE <dev>` when it holds data).
#   * serial + size are re-checked right before wiping (device names move).
#   * mounts are started ONLY through their systemd .mount units, never with
#     `mount`/`mount -a`: `x-systemd.requires=` (which makes a pool
#     all-or-nothing) is honoured only by systemd. A pool mounted over a missing
#     branch would let MinIO serve a partial view, and the 4am reconciliation
#     would then delete the "ghost" rows of every file on the missing drive.
#   * empty mountpoints are made immutable (chattr +i) so nothing — MinIO, a
#     pool — can write into the root filesystem when a drive is missing.
# ─────────────────────────────────────────────────────────────────────────────

DRIVES_DEFAULT_BASE="/srv/minio"
DRIVES_LSBLK_COLS="NAME,KNAME,PATH,TYPE,SIZE,ROTA,TRAN,MODEL,SERIAL,WWN,FSTYPE,LABEL,UUID,PARTUUID,PARTLABEL,PTTYPE,MOUNTPOINT,PKNAME,RM,RO,HOTPLUG"
DRIVES_MOUNT_OPTS="defaults,noatime,nofail,prjquota,x-systemd.device-timeout=10"
DRIVES_POOL_OPTS="defaults,allow_other,cache.files=partial,category.create=mfs,minfreespace=20G"
DRIVES_JSON=""        # last discovery result

# ── discovery ────────────────────────────────────────────────────────────────
# drives_discover — classify every disk; sets DRIVES_JSON (and prints it).
drives_discover() {
  local d; d="$(mktemp -d "${TMPDIR:-/tmp}/apollo-disks.XXXXXX")"
  if ! probe lsblk-json -- lsblk -J -b -o "$DRIVES_LSBLK_COLS" >"$d/lsblk.json" 2>/dev/null; then
    probe lsblk-json-basic -- lsblk -J -b -o NAME,PATH,TYPE,SIZE,ROTA,TRAN,MODEL,SERIAL,FSTYPE,LABEL,UUID,PARTUUID,MOUNTPOINT,RM,RO >"$d/lsblk.json" 2>/dev/null ||
      { rm -rf "$d"; log_error "lsblk failed"; return 1; }
  fi
  probe proc-swaps -- cat /proc/swaps >"$d/swaps" 2>/dev/null || : >"$d/swaps"
  fstab_text >"$d/fstab"
  probe etc-crypttab -- cat /etc/crypttab >"$d/crypttab" 2>/dev/null || : >"$d/crypttab"
  probe proc-mountinfo -- cat /proc/self/mountinfo >"$d/mountinfo" 2>/dev/null || : >"$d/mountinfo"
  probe disk-by-id -- sh -c 'cd /dev/disk/by-id 2>/dev/null && for f in *; do [ -L "$f" ] && printf "%s %s\n" "$f" "$(readlink "$f")"; done' >"$d/byid" 2>/dev/null || : >"$d/byid"
  local sysroot=/
  if [[ -n "$FIXTURES" ]]; then sysroot="$FIXTURES/sysroot"; mkdir -p "$d/emptysys"; [[ -d "$sysroot" ]] || sysroot="$d/emptysys"; fi
  local -a nj=(); [[ -f "$NODE_JSON" ]] && nj=(--node-json "$NODE_JSON")
  DRIVES_JSON="$(py disks list --lsblk-json "$d/lsblk.json" --swaps "$d/swaps" --fstab "$d/fstab" --crypttab "$d/crypttab" \
    --mountinfo "$d/mountinfo" --by-id "$d/byid" --sys-root "$sysroot" "${nj[@]+"${nj[@]}"}")" || { rm -rf "$d"; return 1; }
  rm -rf "$d"
  printf '%s' "$DRIVES_JSON"
}

# _drives_q EXPR — evaluate a python expression over DRIVES_JSON (as `D`).
_drives_q() {
  printf '%s' "$DRIVES_JSON" | python3 -I -c "import json,sys; D=json.load(sys.stdin); print($1)"
}

_drives_show_table() {
  local rows
  rows="$(printf '%s' "$DRIVES_JSON" | python3 -I -c '
import json, sys
def size(n):
    for u in ("B","KB","MB","GB","TB","PB"):
        if n < 1000: return ("%.1f %s" % (n, u)).replace(".0 ", " ")
        n /= 1000.0
    return "%d" % n
for d in json.load(sys.stdin)["disks"]:
    det = d.get("label") or ""
    if d["status"] in ("system", "in_use", "foreign"): det = "; ".join(d["reasons"])[:70]
    elif d["status"] == "apollo": det = "%s (%s) at %s" % (d.get("label"), d.get("fstype"), d.get("mountpoint") or "not mounted")
    print("%s|%s|%s|%s|%s|%s" % (d["name"], size(d["size_bytes"]), (d.get("model") or "?")[:24], d["class_guess"] + (" (usb)" if d.get("tran") == "usb" else ""), d["status"], det))')"
  local -a t=("DEVICE|SIZE|MODEL|CLASS|STATUS|DETAIL")
  while IFS= read -r r; do [[ -n "$r" ]] && t+=("$r"); done <<<"$rows"
  ui_table "${t[@]}"
  local w; w="$(_drives_q '"\n".join(D["warnings"])')"
  [[ -n "$w" ]] && while IFS= read -r l; do log_warn "$l"; done <<<"$w"
  return 0
}

# ── primitives (every mutation via run) ──────────────────────────────────────
_drives_unit_for() { systemd-escape --path --suffix=mount "$1"; }

# _drives_protect_mountpoint DIR — chattr +i on the EMPTY directory a
# filesystem is (or will be) mounted on. If DIR is currently a mountpoint,
# `chattr DIR` would hit the mounted fs's root instead, so we reach the
# underlying directory through a private bind of its parent filesystem.
_drives_protect_mountpoint() {
  local dir="$1"
  if ! probe "mountpoint-$(probe_key "$dir")" -- mountpoint -q "$dir" >/dev/null 2>&1; then
    run -- chattr +i "$dir" || { log_warn "could not make $dir immutable (filesystem without chattr support?)"; return 0; }
    return 0
  fi
  local parent_mnt rel tmp
  parent_mnt="$(probe "findmnt-parent-$(probe_key "$dir")" -- findmnt -no TARGET -T "$(dirname "$dir")" 2>/dev/null || echo /)"
  rel="${dir#"${parent_mnt%/}"/}"
  tmp="/run/apollo-sfs/protect.$$"
  run -- unshare -m --propagation private sh -c 'mkdir -p "$1" && mount --bind "$2" "$1" && chattr +i "$1/$3"; rc=$?; umount "$1"; rmdir "$1"; exit $rc' \
    sh "$tmp" "$parent_mnt" "$rel" || log_warn "could not protect the directory underneath $dir"
  return 0
}

# _drives_start_mount MNT EXPECT_UUID — start MNT's .mount unit and verify the
# right filesystem landed there. rc 0/1.
_drives_start_mount() {
  local mnt="$1" uuid="$2" unit got
  unit="$(_drives_unit_for "$mnt")"
  run -- systemctl start "$unit" || { log_error "systemctl start $unit failed"; return 1; }
  is_test && return 0
  got="$(findmnt -no UUID "$mnt" 2>/dev/null || true)"
  if [[ -n "$uuid" && "$got" != "$uuid" ]]; then
    log_error "$mnt has filesystem '${got:-nothing}' mounted, expected $uuid"
    return 1
  fi
  return 0
}

# _drives_mounted MNT — rc 0 if MNT is currently a mountpoint.
_drives_mounted() { probe "mountpoint-$(probe_key "$1")" -- mountpoint -q "$1" >/dev/null 2>&1; }

# _drives_part_path DISK_PATH N — kernel naming: nvme0n1 → nvme0n1p1, sda → sda1.
_drives_part_path() { if [[ "$1" =~ [0-9]$ ]]; then printf '%sp%s' "$1" "$2"; else printf '%s%s' "$1" "$2"; fi; }

# _drives_format DISK_JSON LABEL — wipe + GPT + one partition + XFS. Prints
# "PART_PATH UUID PARTUUID". Every step via run; --test prints planned values.
_drives_format() {
  local disk="$1" label="$2" path name serial size
  path="$(printf '%s' "$disk" | json_get path)"; name="$(printf '%s' "$disk" | json_get name)"
  serial="$(printf '%s' "$disk" | json_get serial "")"; size="$(printf '%s' "$disk" | json_get size_bytes 0)"
  # Device names move between boots: re-read identity right before wiping.
  local now; now="$(probe "lsblk-identity-$(probe_key "$name")" -- lsblk -dnbo SERIAL,SIZE "$path" 2>/dev/null | xargs)"
  if [[ -n "$now" && "$now" != "$(xargs <<<"$serial $size")" ]]; then
    log_error "$path changed identity (now '$now', expected '$serial $size') — refusing to format it."
    return 1
  fi
  local children; children="$(printf '%s' "$disk" | python3 -I -c 'import json,sys; [print(c["path"]) for c in json.load(sys.stdin)["children"] if c.get("path")]')"
  local c
  while IFS= read -r c; do [[ -n "$c" ]] && { run -- wipefs -a "$c" >/dev/null || return 1; }; done <<<"$children"
  run -- wipefs -a "$path" >/dev/null || return 1
  run -- sgdisk --zap-all "$path" >/dev/null || return 1
  local guid; guid="$(python3 -I -c 'import uuid; print(uuid.uuid4())')"
  run -- sgdisk -n1:0:0 -t1:8300 "-c1:$label" "-u1:$guid" "$path" >/dev/null || return 1
  run -- partprobe "$path" || true
  run -- udevadm settle || true
  local part uuid
  if is_test; then
    part="$(_drives_part_path "$path" 1)"; uuid="planned-$label"
  else
    local i
    for i in $(seq 1 30); do [[ -e "/dev/disk/by-partuuid/$guid" ]] && break; sleep 1; done
    [[ -e "/dev/disk/by-partuuid/$guid" ]] || { log_error "the new partition on $path did not appear"; return 1; }
    part="$(readlink -f "/dev/disk/by-partuuid/$guid")"
  fi
  # A fresh partition can still carry an old filesystem signature at the same offset.
  run -- wipefs -a "$part" >/dev/null || return 1
  run -- mkfs.xfs -f -L "$label" "$part" >/dev/null || return 1
  if ! is_test; then
    uuid="$(blkid -s UUID -o value "$part" 2>/dev/null || true)"
    [[ -n "$uuid" ]] || { log_error "mkfs.xfs left no UUID on $part"; return 1; }
  fi
  printf '%s %s %s\n' "$part" "$uuid" "$guid"
}

# _drives_prepare_dirs MNT — data/ for MinIO (uid 1000) + .bench/ for node-agent.
_drives_prepare_dirs() {
  local mnt="$1"
  ensure_dir "$mnt/data" 0755 "$MINIO_UID:$MINIO_GID" || return 1
  ensure_dir "$mnt/.bench" 0755 root:root || return 1
}

# _drives_mount_new LABEL UUID MNT — protect, fstab, start, prepare.
_drives_mount_new() {
  local label="$1" uuid="$2" mnt="$3"
  ensure_dir "$mnt" 0755 root:root || return 1
  _drives_protect_mountpoint "$mnt"
  fstab_upsert "drive-$label" "UUID=$uuid  $mnt  xfs  $DRIVES_MOUNT_OPTS  0  2" || return 1
  _drives_start_mount "$mnt" "$uuid" || return 1
  _drives_prepare_dirs "$mnt"
}

# _drives_fstab_repair TARGET — add nofail (+device timeout) to an existing line.
_drives_fstab_repair() {
  local target="$1" f fixed marker
  f="$(mktemp "${TMPDIR:-/tmp}/apollo-fstab.XXXXXX")"; fstab_text >"$f"
  fixed="$(py disks fstab-fix --fstab "$f" --target "$target" --add nofail,x-systemd.device-timeout=10)"
  rm -f "$f"
  [[ -n "$fixed" ]] || return 0
  marker="mount-$(probe_key "$(basename "$target")")"
  log_info "Adding nofail to the fstab line for $target (a missing drive must never block boot)."
  fstab_upsert "$marker" "$fixed" --replace-target "$target"
}

# _drives_fstab_dedupe TARGET UUID — comment out fstab lines that mount a
# DIFFERENT filesystem on TARGET (left by adopting a disk that only shared the
# label). Only offered when UUID is the filesystem actually mounted there.
_drives_fstab_dedupe() {
  local target="$1" uuid="$2" cur bad
  [[ -n "$uuid" ]] || return 0
  cur="$(fstab_text)"
  bad="$(awk -v t="$target" -v u="UUID=$uuid" '$1 !~ /^#/ && $2 == t && $1 != u' <<<"$cur")"
  [[ -n "$bad" ]] || return 0
  if ! is_test; then
    local live; live="$(findmnt -no UUID "$target" 2>/dev/null || true)"
    [[ "$live" == "$uuid" ]] || { log_warn "not cleaning fstab for $target: $uuid is not what is mounted there"; return 0; }
  fi
  log_warn "/etc/fstab has other filesystems on $target (from a disk that only shares its label):"
  while IFS= read -r l; do log_detail "    $l"; done <<<"$bad"
  ask_yn "Comment these lines out? (they would mount the wrong disk at boot)" y || return 0
  local out="" l f1 f2 stamp; stamp="$(now_iso)"
  while IFS= read -r l || [[ -n "$l" ]]; do
    read -r f1 f2 _ <<<"$l"
    if [[ ! "$l" =~ ^[[:space:]]*# && "$f2" == "$target" && "$f1" != "UUID=$uuid" ]]; then
      out+="# disabled by deploy.sh $stamp (not the filesystem at $target): $l"$'\n'
    else
      out+="$l"$'\n'
    fi
  done <<<"$cur"
  printf '%s' "$out" | write_file /etc/fstab 0644 root:root || return 1
  [[ $WRITE_CHANGED == 1 ]] && { run -- systemctl daemon-reload || return 1; }
  return 0
}

# ── pools ────────────────────────────────────────────────────────────────────
# _drives_pool_line BRANCHES(:-joined) POOL TIER MNT… — the mergerfs fstab line.
_drives_pool_line() {
  local branches="$1" pool="$2" tier="$3"; shift 3
  local opts="$DRIVES_POOL_OPTS,fsname=apollo-pool-$tier,nofail" m
  for m in "$@"; do opts+=",x-systemd.requires=$m"; done
  printf '%s  %s  fuse.mergerfs  %s  0  0' "$branches" "$pool" "$opts"
}

# _drives_pool_start POOL MNT… — start the pool only if every branch drive is
# really mounted (never a partial pool), then verify mergerfs' branch list.
_drives_pool_start() {
  local pool="$1"; shift
  local m
  if ! is_test; then
    for m in "$@"; do
      mountpoint -q "$m" || { log_error "refusing to start $pool: branch drive $m is not mounted"; return 1; }
    done
  fi
  run -- systemctl start "$(_drives_unit_for "$pool")" || return 1
  if ! is_test; then
    local have; have="$(getfattr -n user.mergerfs.branches --only-values "$pool/.mergerfs" 2>/dev/null || true)"
    for m in "$@"; do
      [[ ":$have:" == *"$m/data"* ]] || { log_error "$pool came up without branch $m/data (branches: $have)"; return 1; }
    done
  fi
  return 0
}

# ── the drives step ──────────────────────────────────────────────────────────
# _drives_choose — interactive selection → DRIVES_PLAN (JSON list of actions).
DRIVES_PLAN="[]"
_drives_choose() {
  local -a opts=() dis=() pre=()
  local line name st label cls tier reason
  while IFS='|' read -r name st label cls tier reason; do
    [[ -n "$name" ]] || continue
    case "$st" in
      apollo) opts+=("$name=$name — adopt $label ($cls, $tier tier; data kept)"); pre+=(--preselect "$name") ;;
      foreign) opts+=("$name=$name — ERASE and format ($cls, $tier tier): $reason") ;;
      blank) opts+=("$name=$name — format ($cls, $tier tier)") ;;
      *) opts+=("$name=$name"); dis+=(--disable "$name=$st: $reason") ;;
    esac
  done < <(_drives_q '"\n".join("%s|%s|%s|%s|%s|%s" % (d["name"], d["status"], d.get("label") or "", d["class_guess"], d["tier_guess"], ("; ".join(d["reasons"]))[:60].replace("|","/")) for d in D["disks"])')
  if ((${#opts[@]} == 0)); then DRIVES_PLAN="[]"; return 0; fi
  local -a picked=()
  checklist picked "Which drives should this node use for Apollo storage?" --min 0 \
    "${pre[@]+"${pre[@]}"}" "${dis[@]+"${dis[@]}"}" "${opts[@]}"
  local -a plan=() p disk status dname
  for p in "${picked[@]+"${picked[@]}"}"; do
    disk="$(_drives_q "json.dumps(next(d for d in D['disks'] if d['name'] == '$p'))")"
    status="$(printf '%s' "$disk" | json_get status)"
    cls="$(printf '%s' "$disk" | json_get class_guess)"
    if [[ "$(printf '%s' "$disk" | json_get needs_class_confirm false)" == true && "$status" != apollo ]]; then
      select_one cls "$p is behind a USB bridge (its rotational flag can't be trusted). What is it?" --default "$cls" \
        nvme="NVMe SSD (fast tier)" ssd="SATA SSD (fast tier)" hdd="hard disk (standard tier)"
    fi
    if [[ "$status" == foreign ]]; then
      log_warn "$p ($(printf '%s' "$disk" | json_get model '?'), $(fmt_bytes "$(printf '%s' "$disk" | json_get size_bytes 0)")) currently holds:"
      printf '%s' "$disk" | python3 -I -c 'import json,sys; [print("      %s  %s %s %s" % (c["name"], c.get("fstype") or c.get("type"), c.get("label") or "", c.get("mountpoints") or "")) for c in json.load(sys.stdin)["children"]]' >&2
      confirm_typed "ERASE $p" "Everything on /dev/$p will be destroyed." || { log_info "Skipping $p."; continue; }
    elif [[ "$status" == blank ]]; then
      confirm_typed "$p" "Format /dev/$p ($(printf '%s' "$disk" | json_get model '?'), $(fmt_bytes "$(printf '%s' "$disk" | json_get size_bytes 0)")) as an Apollo drive?" ||
        { log_info "Skipping $p."; continue; }
    fi
    local t; [[ "$cls" == hdd ]] && t=standard || t=fast
    plan+=("$(printf '%s' "$disk" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); d["class"]=sys.argv[1]; d["tier"]=sys.argv[2]; print(json.dumps(d))' "$cls" "$t")")
  done
  DRIVES_PLAN="$(printf '%s\n' "${plan[@]+"${plan[@]}"}" | python3 -I -c 'import json,sys; print(json.dumps([json.loads(l) for l in sys.stdin if l.strip()]))')"
  return 0
}

# _drives_reserve_labels CLASS… — cluster-unique labels (manager registry);
# local next-free fallback only when the manager can't be asked.
# _drives_local_labels — every Apollo-style label already present on THIS node:
# any filesystem label on any disk (adopted, duplicate, foreign or in use), the
# labels recorded in node.json, and mountpoint names in /etc/fstab. None of
# them may be handed out to a new drive.
_drives_local_labels() {
  {
    printf '%s' "${DRIVES_JSON:-{\}}" | python3 -I -c '
import json, sys
D = json.load(sys.stdin)
for d in D.get("disks") or []:
    for x in [d] + (d.get("children") or []):
        if x.get("label"): print(x["label"])' 2>/dev/null
    node_json_get deployment.drives '[]' 2>/dev/null | python3 -I -c 'import json,sys; [print(d.get("label","")) for d in json.load(sys.stdin)]' 2>/dev/null
    fstab_text 2>/dev/null | awk '$1 !~ /^#/ {n=split($2,a,"/"); print a[n]}'
  } | { grep -E '^(nvme|ssd|hdd)-[0-9]{2}$' || true; } | sort -u
}

_drives_reserve_labels() {
  (($#)) || return 0
  local f rc=0 local_labels
  local_labels="$(_drives_local_labels)"
  f="$(mktemp "${TMPDIR:-/tmp}/apollo-labels.XXXXXX")"
  printf '{"hostname":%s,"previous_names":%s,"classes":%s,"in_use":%s}' "$(json_escape "$(node_name)")" "$(node_previous_names)" \
    "$(printf '%s\n' "$@" | python3 -I -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')" \
    "$(printf '%s\n' "$local_labels" | python3 -I -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')" >"$f"
  cluster_call reserve-labels --in "$f" --quiet || rc=$?
  rm -f "$f"
  if [[ $rc -eq 0 ]]; then
    local got clash="" l
    got="$(mgr_data labels | python3 -I -c 'import json,sys; [print(x) for x in json.load(sys.stdin)]')"
    # Never trust a label that already exists here (an older manager doesn't
    # know this node's existing drives).
    for l in $got; do grep -qx "$l" <<<"$local_labels" && clash+="$l "; done
    if [[ -n "$clash" ]]; then
      log_error "The manager offered label(s) ${clash% } which already exist on this node — refusing to format with them."
      log_error "Update deploy.sh on the manager (it must receive this node's existing labels) and retry."
      return 1
    fi
    printf '%s\n' "$got"; return 0
  fi
  if [[ "$(node_role)" != manager ]] && ! is_test; then log_error "the manager could not reserve drive labels"; return 1; fi
  log_warn "Labels picked locally (not reserved cluster-wide)."
  local taken; taken="$(tr '\n' ' ' <<<"$local_labels")"
  local cls n lab
  for cls in "$@"; do
    n=1; while :; do printf -v lab '%s-%02d' "$cls" "$n"; [[ " $taken " == *" $lab "* ]] || break; n=$((n + 1)); done
    taken+=" $lab"; printf '%s\n' "$lab"
  done
}

# _drives_mount_base — parent dir of this node's existing Apollo drives, else /srv/minio.
_drives_mount_base() {
  local mp; mp="$(_drives_q 'next((d["mountpoint"] for d in D["disks"] if d["status"] == "apollo" and d.get("mountpoint")), "")')"
  if [[ -n "$mp" ]]; then dirname "$mp"; else printf '%s' "$DRIVES_DEFAULT_BASE"; fi
}

# _drives_adopt DISK_JSON BASE — make an Apollo drive usable without touching
# its data: mount it if needed, repair its fstab line, create missing dirs.
# Prints the drive record JSON.
_drives_adopt() {
  local disk="$1" base="$2" label uuid fstype mnt mounted=1 part
  label="$(printf '%s' "$disk" | json_get label)"; uuid="$(printf '%s' "$disk" | json_get uuid "")"
  fstype="$(printf '%s' "$disk" | json_get fstype "xfs")"; part="$(printf '%s' "$disk" | json_get part_path "")"
  mnt="$(printf '%s' "$disk" | json_get mountpoint "")"
  if [[ -z "$mnt" ]]; then
    mounted=0
    mnt="$(fstab_text | awk -v u="UUID=$uuid" -v l="LABEL=$label" '$1 == u || $1 == l {print $2; exit}')"
    if [[ -z "$mnt" ]]; then
      mnt="$base/$label"
      # Never claim a mountpoint another filesystem already owns (a second fstab
      # line for the same path, or a disk that only shares the label).
      local other
      other="$(fstab_text | awk -v t="$mnt" '$1 !~ /^#/ && $2 == t {print $1; exit}')"
      if [[ -n "$other" ]] || _drives_mounted "$mnt"; then
        log_error "$mnt already belongs to another filesystem (${other:-mounted now}); $label on $(printf '%s' "$disk" | json_get path) is not that drive."
        log_error "Relabel or format the extra disk instead of adopting it."
        return 1
      fi
      ensure_dir "$mnt" 0755 root:root || return 1
      _drives_protect_mountpoint "$mnt"
      fstab_upsert "drive-$label" "UUID=$uuid  $mnt  $fstype  defaults,noatime,nofail,x-systemd.device-timeout=10  0  2" || return 1
    fi
    log_info "Mounting $label at $mnt (through its systemd unit)…"
    _drives_start_mount "$mnt" "$uuid" || return 1
  fi
  _drives_fstab_dedupe "$mnt" "$uuid" || return 1
  _drives_fstab_repair "$mnt" || return 1
  local opts prj=false
  opts="$(probe "findmnt-opts-$(probe_key "$mnt")" -- findmnt -no OPTIONS "$mnt" 2>/dev/null || true)"
  [[ ",$opts," == *",prjquota,"* || ",$opts," == *",pquota,"* || ",$opts," == *",prjquota"* ]] && prj=true
  probe "dir-exists-$(probe_key "$mnt/data")" -- test -d "$mnt/data" >/dev/null 2>&1 || _drives_prepare_dirs "$mnt" || return 1
  probe "dir-exists-$(probe_key "$mnt/.bench")" -- test -d "$mnt/.bench" >/dev/null 2>&1 || ensure_dir "$mnt/.bench" 0755 root:root || return 1
  printf '%s' "$disk" | python3 -I -c '
import json, sys
d = json.load(sys.stdin); mnt, prj = sys.argv[1], sys.argv[2] == "true"
print(json.dumps({"label": d["label"], "class": d.get("class") or d["class_guess"], "tier": d.get("tier") or d["tier_guess"],
  "uuid": d.get("uuid"), "partuuid": d.get("partuuid"), "by_id": d.get("by_id"), "serial": d.get("serial"),
  "model": d.get("model"), "tran": d.get("tran"), "size_bytes": d.get("part_size_bytes") or d.get("size_bytes"),
  "fs": d.get("fstype"), "device": d.get("part_path"), "mountpoint": mnt, "data_dir": mnt + "/data",
  "bench_dir": mnt + "/.bench", "adopted": True, "prjquota": prj, "quota_bytes": None, "pool": None, "unassigned": False}))' "$mnt" "$prj"
}

# deploy_step_drives — STEP (deploy + update).
deploy_step_drives() {
  drives_discover >/dev/null || { STEP_FAIL_REASON="could not list the drives"; return 1; }
  _drives_show_table
  _drives_choose || return 1
  local n; n="$(printf '%s' "$DRIVES_PLAN" | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)))')"
  if [[ "$n" == 0 ]]; then
    log_warn "No drives selected — this node will hold no Apollo storage (metrics only)."
    printf '{"drives":[],"pools":[],"storage":{"tier":null,"base_bytes":0}}' | node_json_merge deployment >/dev/null || return 1
    state_set storage_tier ""; state_set storage_base_bytes 0
    return 0
  fi

  # One storage tier per node (the API maps exactly one node per tier).
  local tiers tier
  tiers="$(printf '%s' "$DRIVES_PLAN" | python3 -I -c 'import json,sys; print(" ".join(sorted({d["tier"] for d in json.load(sys.stdin)})))')"
  if [[ "$tiers" == *" "* ]]; then
    log_warn "You picked fast (NVMe/SSD) AND standard (HDD) drives. A node serves ONE storage tier."
    select_one tier "Which tier should this node serve?" fast="fast — the NVMe/SSD drives" standard="standard — the hard disks"
  else
    tier="$tiers"
  fi

  local base; base="$(_drives_mount_base)"
  ui_kv "storage tier" "$tier"
  ui_kv "mount base" "$base"
  local -a records=() new_classes=() new_disks=()
  local i disk dt status
  for (( i = 0; i < n; i++ )); do
    disk="$(printf '%s' "$DRIVES_PLAN" | json_get "$i")"
    dt="$(printf '%s' "$disk" | json_get tier)"; status="$(printf '%s' "$disk" | json_get status)"
    if [[ "$dt" != "$tier" ]]; then
      if [[ "$status" == apollo ]]; then
        records+=("$(printf '%s' "$disk" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"label": d["label"], "class": d["class"], "tier": d["tier"], "uuid": d.get("uuid"), "mountpoint": d.get("mountpoint"), "size_bytes": d.get("part_size_bytes"), "unassigned": True, "adopted": True}))')")
        log_info "$(printf '%s' "$disk" | json_get name) ($dt) is left as it is and recorded as unassigned."
      else
        log_info "$(printf '%s' "$disk" | json_get name) ($dt) is not formatted — this node serves the $tier tier."
      fi
      continue
    fi
    if [[ "$status" == apollo ]]; then
      local rec; rec="$(_drives_adopt "$disk" "$base")" || { STEP_FAIL_REASON="adopting $(printf '%s' "$disk" | json_get label) failed"; return 1; }
      records+=("$rec")
    else
      new_disks+=("$disk"); new_classes+=("$(printf '%s' "$disk" | json_get class)")
    fi
  done

  local changed=0
  if ((${#new_disks[@]})); then
    local -a labels=()
    mapfile -t labels < <(_drives_reserve_labels "${new_classes[@]}")
    ((${#labels[@]} == ${#new_disks[@]})) || { STEP_FAIL_REASON="could not allocate drive labels"; return 1; }
    for i in "${!new_disks[@]}"; do
      disk="${new_disks[$i]}"; local label="${labels[$i]}" out part uuid guid mnt
      log_info "Formatting $(printf '%s' "$disk" | json_get path) as $label…"
      out="$(_drives_format "$disk" "$label")" || { STEP_FAIL_REASON="formatting $(printf '%s' "$disk" | json_get path) failed"; return 1; }
      read -r part uuid guid <<<"$out"
      mnt="$base/$label"
      _drives_mount_new "$label" "$uuid" "$mnt" || { STEP_FAIL_REASON="mounting $label failed"; return 1; }
      records+=("$(printf '%s' "$disk" | python3 -I -c '
import json, sys
d = json.load(sys.stdin); lab, part, uuid, guid, mnt = sys.argv[1:6]
print(json.dumps({"label": lab, "class": d["class"], "tier": d["tier"], "uuid": uuid, "partuuid": guid,
  "by_id": d.get("by_id"), "serial": d.get("serial"), "model": d.get("model"), "tran": d.get("tran"),
  "size_bytes": d.get("size_bytes"), "fs": "xfs", "device": part, "mountpoint": mnt, "data_dir": mnt + "/data",
  "bench_dir": mnt + "/.bench", "adopted": False, "prjquota": True, "quota_bytes": None, "pool": None, "unassigned": False}))' \
        "$label" "$part" "$uuid" "$guid" "$mnt")")
      changed=1
    done
  fi

  # Pools: a tier with two or more drives is pooled with mergerfs.
  local pools_json="[]" recs_json
  recs_json="$(printf '%s\n' "${records[@]}" | python3 -I -c 'import json,sys; print(json.dumps([json.loads(l) for l in sys.stdin if l.strip()]))')"
  local assigned; assigned="$(printf '%s' "$recs_json" | python3 -I -c 'import json,sys; print(" ".join(d["mountpoint"] for d in json.load(sys.stdin) if not d.get("unassigned")))')"
  local -a mnts=(); read -r -a mnts <<<"$assigned"
  if ((${#mnts[@]} >= 2)); then
    _drives_pool_ensure "$tier" "$base" "${mnts[@]}" || { STEP_FAIL_REASON="setting up the $tier pool failed"; return 1; }
    pools_json="$DRIVES_POOL_JSON"
    [[ "$DRIVES_POOL_CHANGED" == 1 ]] && changed=1
  fi

  if printf '%s' "$recs_json" | grep -q '"class": "hdd"\|"tran": "sata"'; then system_drivetemp_ensure || true; fi
  local base_bytes; base_bytes="$(printf '%s' "$recs_json" | python3 -I -c 'import json,sys; print(sum(int(d.get("size_bytes") or 0) for d in json.load(sys.stdin) if not d.get("unassigned")))')"
  local pool_path; pool_path="$(printf '%s' "$pools_json" | python3 -I -c 'import json,sys; p=json.load(sys.stdin); print(p[0]["path"] if p else "")')"
  recs_json="$(printf '%s' "$recs_json" | python3 -I -c 'import json,sys; r=json.load(sys.stdin); p=sys.argv[1] or None
for d in r:
    if not d.get("unassigned"): d["pool"] = p
print(json.dumps(r))' "$pool_path")"
  printf '{"drives":%s,"pools":%s,"storage":{"tier":%s,"base_bytes":%s}}' "$recs_json" "$pools_json" \
    "$(json_escape "$tier")" "$base_bytes" | node_json_merge deployment >/dev/null || return 1
  state_set storage_tier "$tier"; state_set storage_base_bytes "$base_bytes"
  [[ $changed == 1 ]] && state_set drives_changed 1
  log_ok "${#mnts[@]} drive(s) ready for the $tier tier ($(fmt_bytes "$base_bytes"))."

  _drives_validate_metrics
}

# _drives_pool_ensure TIER BASE MNT… — create / extend / repair the tier pool.
# Sets DRIVES_POOL_JSON and DRIVES_POOL_CHANGED.
DRIVES_POOL_JSON="[]"; DRIVES_POOL_CHANGED=0
_drives_pool_ensure() {
  local tier="$1" base="$2"; shift 2
  local -a mnts=("$@") want=()
  local m; for m in "${mnts[@]}"; do want+=("$m/data"); done
  DRIVES_POOL_CHANGED=0
  local existing
  existing="$(printf '%s' "$DRIVES_JSON" | python3 -I -c 'import json,sys; D=json.load(sys.stdin); w=set(sys.argv[1:])
print(json.dumps(next((p for p in D["pools"] if w & set(p["branches"])), None)))' "${want[@]}")"
  local pool branches
  if [[ "$existing" != null ]]; then
    pool="$(printf '%s' "$existing" | json_get path)"
    local have; have="$(printf '%s' "$existing" | json_get branches '[]' | python3 -I -c 'import json,sys; print(" ".join(json.load(sys.stdin)))')"
    local -a add=()
    for m in "${want[@]}"; do [[ " $have " == *" $m "* ]] || add+=("$m"); done
    branches="$(tr ' ' ':' <<<"$have")"
    if ((${#add[@]})); then
      local a
      for a in "${add[@]}"; do
        log_info "Adding $a to the live pool $pool (no remount, MinIO keeps running)…"
        if [[ "$(printf '%s' "$existing" | json_get mounted false)" == true ]]; then
          run -- setfattr -n user.mergerfs.branches -v "+>$a" "$pool/.mergerfs" || return 1
        fi
        branches+=":$a"
      done
      DRIVES_POOL_CHANGED=1
    fi
    # Rewrite the line keeping the pool's own options, adding nofail + every requires=.
    local opts; opts="$(printf '%s' "$existing" | json_get options "$DRIVES_POOL_OPTS")"
    opts="$(python3 -I -c '
import sys
opts = [o for o in sys.argv[1].split(",") if o and not o.startswith("x-systemd.requires=")]
if "nofail" not in opts: opts.append("nofail")
opts += ["x-systemd.requires=" + m for m in sys.argv[2:]]
print(",".join(opts))' "$opts" "${mnts[@]}")"
    fstab_upsert "pool-$tier" "$branches  $pool  fuse.mergerfs  $opts  0  0" --replace-target "$pool" || return 1
    if [[ "$(printf '%s' "$existing" | json_get mounted false)" != true ]]; then
      _drives_pool_start "$pool" "${mnts[@]}" || return 1
    fi
  else
    pool="$base/pool-$tier"
    branches="$(IFS=:; echo "${want[*]}")"
    # A single drive already serving MinIO directly becomes a pool: MinIO's data
    # path changes, so stop that tier's MinIO while the pool comes up.
    local svc; [[ "$tier" == fast ]] && svc=minio || svc=minio-standard
    local had_minio; had_minio="$(node_json_get deployment.stack.services '[]' | grep -c "\"$svc\"" || true)"
    if [[ "$had_minio" != 0 ]]; then
      log_warn "This node's $svc reads a single drive today; pooling moves it to $pool."
      ask_yn "Stop $svc briefly to switch it to the pool?" y || { log_info "Keeping a single drive — no pool."; DRIVES_POOL_JSON="[]"; return 0; }
      local f; f="$(mktemp "${TMPDIR:-/tmp}/apollo-scale.XXXXXX")"; printf '{"services":{"%s":0}}' "$svc" >"$f"
      cluster_call scale --in "$f" || { rm -f "$f"; return 1; }
      rm -f "$f"
    fi
    ensure_dir "$pool" 0755 root:root || return 1
    _drives_protect_mountpoint "$pool"
    fstab_upsert "pool-$tier" "$(_drives_pool_line "$branches" "$pool" "$tier" "${mnts[@]}")" || return 1
    _drives_pool_start "$pool" "${mnts[@]}" || return 1
    DRIVES_POOL_CHANGED=1
  fi
  DRIVES_POOL_JSON="$(python3 -I -c '
import json, sys
tier, pool, branches = sys.argv[1], sys.argv[2], sys.argv[3]
unit = sys.argv[4]
print(json.dumps([{"tier": tier, "path": pool, "branches": [b for b in branches.split(":") if b], "unit": unit,
                   "fsname": "apollo-pool-" + tier}]))' "$tier" "$pool" "$branches" "$(_drives_unit_for "$pool")")"
  return 0
}

# _drives_validate_metrics — local (node.json) then pipeline (manager DB).
_drives_validate_metrics() {
  local labels; labels="$(node_json_get deployment.drives '[]' | python3 -I -c 'import json,sys; print(" ".join(d["label"] for d in json.load(sys.stdin) if not d.get("unassigned")))')"
  [[ -n "$labels" ]] || return 0
  log_info "Validating drive metrics (local collection, then what the manager receives)…"
  while true; do
    local local_ok=1 problems=""
    local metrics_now
    if is_test; then
      log_test "measuring the existing drives now (read-only collection; the service is not used)"
      metrics_now="$(_health_drive_metrics)"
      log_test "sample metrics collected from this host (drives not formatted/mounted yet in this run can't be measured):"
      health_show_sample "$metrics_now"
    else
      nodestatus_wait_fresh 10 30 "$(( $(now_epoch) - 1 ))" || true
      metrics_now="$(node_json_get metrics '{}')"
    fi
    problems="$(python3 -I -c '
import json, sys
dep = json.loads(sys.argv[1] or "{}"); m = {d.get("label"): d for d in (json.loads(sys.argv[2] or "{}")).get("disks") or []}
for d in dep.get("drives") or []:
    if d.get("unassigned"): continue
    if str(d.get("uuid") or "").startswith("planned"):
        continue   # --test: formatted in this run, nothing to measure yet
    x = m.get(d["label"])
    if not x: print("%s: not reported by the status service yet" % d["label"])
    elif not x.get("mounted"): print("%s: not mounted at %s" % (d["label"], d.get("mountpoint")))
    elif not x.get("total_bytes"): print("%s: no capacity reading" % d["label"])' "$(node_json_get deployment '{}')" "${metrics_now:-{\}}" 2>&1)"
    if is_test && [[ -n "$problems" ]]; then
      while IFS= read -r l; do log_warn "$l"; done <<<"$problems"
    fi
    # --test only reports (warns above); a real run must pass before continuing.
    if ! is_test; then [[ -z "$problems" ]] || local_ok=0; fi
    is_test && problems=""
    if [[ $local_ok == 1 ]]; then
      local rc=0
      stack_register_node drives || rc=$?
      if [[ $rc -eq 0 ]]; then
        rc=0; health_wait_disk_metrics 60 || rc=$?
        case $rc in
          0) log_ok "The manager receives metrics for: $labels"; return 0 ;;
          3) log_warn "The manager can't check drive metrics yet (no stack/DB) — re-checked after the services start."; return 3 ;;
          *) problems="the manager does not see every drive reported correctly (table above)" ;;
        esac
      elif [[ $rc -eq 255 ]]; then problems="the manager is unreachable — drive metrics can't be validated"
      else problems="registering this node's drives with the manager failed"; fi
    fi
    is_test && { log_test "validation result: ${problems:-ok}"; return 0; }
    local arc=0
    alert_ack crit drive-metrics "Drive metrics are not reaching the manager" \
      "$problems
Without this, the metrics page and the heartbeat can't see these drives.
Note: if one drive is missing, that node's whole node-agent stops (its .bench bind source is gone)." --retry || arc=$?
    [[ $arc -eq 1 ]] && continue
    return 0
  done
}

# update_step_drives — STEP (update): missing drives, then the deploy flow
# (adopts everything recorded, offers new disks), then the opt-in quota remount.
update_step_drives() {
  drives_discover >/dev/null || { STEP_FAIL_REASON="could not list the drives"; return 1; }
  local missing
  missing="$(python3 -I -c '
import json, sys
D = json.loads(sys.argv[1]); rec = json.loads(sys.argv[2] or "[]")
have = set()
for d in D["disks"]:
    have.add(d.get("uuid"))
    for c in d.get("children") or []: have.add(c.get("uuid"))
for r in rec:
    if not r.get("unassigned") and r.get("uuid") and r["uuid"] not in have:
        print("%s|%s|%s" % (r["label"], r.get("mountpoint"), r.get("model") or "?"))' "$DRIVES_JSON" "$(node_json_get deployment.drives '[]')")"
  local label mnt model
  while IFS='|' read -r label mnt model; do
    [[ -n "$label" ]] || continue
    alert_ack crit "drive-missing-$label" "Drive $label ($model) is missing" \
      "It was mounted at $mnt and is not connected now.
Its pool (if any) stays DOWN on purpose, so MinIO never serves a partial view — otherwise the
4am reconciliation would delete the database rows of every file on the missing drive.
Reconnect it and run ./deploy.sh restart. Only remove it if it is permanently lost."
    if ask_yn "Remove $label from this node permanently (its files are lost)?" n &&
       confirm_typed "REMOVE $label" "The files on $label are gone for good; the 4am reconciliation will delete their rows."; then
      local rest; rest="$(node_json_get deployment.drives '[]' | python3 -I -c 'import json,sys; print(json.dumps([d for d in json.load(sys.stdin) if d["label"] != sys.argv[1]]))' "$label")"
      node_json_set deployment.drives "$rest" >/dev/null || return 1
      log_warn "$label removed from the records. Its fstab line and pool branch are rewritten in the next step."
    fi
  done <<<"$missing"
  deploy_step_drives || return $?
  _drives_offer_quota_remount
  return 0
}

# _drives_offer_quota_remount — adopted XFS drives mounted without prjquota
# can't enforce a blob share < 100 % until remounted (brief MinIO stop).
_drives_offer_quota_remount() {
  local blob; blob="$(node_json_get deployment.roles.blob_storage_shard.percent 100)"
  [[ "$blob" =~ ^[0-9]+$ ]] || blob=100
  (( blob < 100 )) || return 0
  local cand; cand="$(node_json_get deployment.drives '[]' | python3 -I -c 'import json,sys; print(" ".join(d["label"] for d in json.load(sys.stdin) if d.get("fs") == "xfs" and not d.get("prjquota") and not d.get("unassigned")))')"
  [[ -n "$cand" ]] || return 0
  log_info "Blob storage is set to $blob% but these XFS drives are mounted without project quotas: $cand"
  ask_yn "Remount them with prjquota now (MinIO and this node's agent stop for about a minute)?" n || {
    log_info "Left as is — enforcement stays 'pending-remount'."; return 0; }
  # shellcheck disable=SC2086  # $cand is a space-separated list of labels
  roles_remount_with_quota $cand
}

# restart_step_mounts — STEP (restart): every recorded drive and pool mounted.
restart_step_mounts() {
  local recs pools missing=""
  recs="$(node_json_get deployment.drives '[]')"; pools="$(node_json_get deployment.pools '[]')"
  local label mnt uuid
  while IFS='|' read -r label mnt uuid; do
    [[ -n "$label" ]] || continue
    if _drives_mounted "$mnt"; then log_ok "$label mounted at $mnt"; continue; fi
    log_warn "$label is not mounted — starting its unit…"
    _drives_start_mount "$mnt" "$uuid" && { log_ok "$label mounted"; continue; }
    missing+="$label ($mnt)"$'\n'
  done < <(printf '%s' "$recs" | python3 -I -c 'import json,sys; [print("%s|%s|%s" % (d["label"], d["mountpoint"], d.get("uuid") or "")) for d in json.load(sys.stdin) if not d.get("unassigned")]')
  local pool brs
  while IFS='|' read -r pool brs; do
    [[ -n "$pool" ]] || continue
    if _drives_mounted "$pool"; then log_ok "pool $pool mounted"; continue; fi
    local -a pm=(); local b
    for b in ${brs//:/ }; do pm+=("$(dirname "$b")"); done
    if _drives_pool_start "$pool" "${pm[@]}"; then log_ok "pool $pool mounted"
    else missing+="pool $pool (a branch drive is missing — MinIO stays down by design)"$'\n'; fi
  done < <(printf '%s' "$pools" | python3 -I -c 'import json,sys; [print("%s|%s" % (p["path"], ":".join(p.get("branches") or []))) for p in json.load(sys.stdin)]')
  if [[ -n "$missing" ]]; then
    alert_ack crit drives-unmounted "Some storage is not mounted" \
      "${missing}Services that use it will not start (by design). Reconnect the drive(s), then run ./deploy.sh restart again."
  fi
  return 0
}

# drives_expected_json — the drives this node should report (heartbeat).
drives_expected_json() { node_json_get deployment.drives '[]'; }

# drift_drives — update drift lines.
drift_drives() {
  local recs; recs="$(node_json_get deployment.drives '[]' 2>/dev/null)"
  [[ "$recs" == "[]" ]] && { echo "ok|drives|no drives recorded"; return 0; }
  drives_discover >/dev/null 2>&1 || { echo "warn|drives|could not list drives"; return 0; }
  python3 -I -c '
import json, sys
D = json.loads(sys.argv[1]); rec = json.loads(sys.argv[2]); fstab = sys.argv[3]
have = {}
for d in D["disks"]:
    for u in [d.get("uuid")] + [c.get("uuid") for c in d.get("children") or []]:
        if u: have[u] = d
for r in rec:
    if r.get("unassigned"): continue
    d = have.get(r.get("uuid"))
    if not d: print("crit|drives|%s is missing (recorded at %s)" % (r["label"], r.get("mountpoint"))); continue
    if not d.get("mountpoint"): print("crit|drives|%s is connected but not mounted" % r["label"])
    line = next((l for l in fstab.splitlines() if not l.strip().startswith("#") and len(l.split()) > 3 and l.split()[1] == r.get("mountpoint")), None)
    if line is None: print("warn|drives|%s has no fstab entry" % r["label"])
    elif "nofail" not in line.split()[3]: print("warn|drives|fstab line for %s lacks nofail (a missing drive would block boot)" % r["label"])
for p in D["pools"]:
    if not p.get("nofail"): print("warn|drives|pool %s fstab line lacks nofail" % p["path"])
    if not p.get("mounted"): print("crit|drives|pool %s is not mounted" % p["path"])
print("ok|drives|%d drive(s) checked" % len([r for r in rec if not r.get("unassigned")]))' "$DRIVES_JSON" "$recs" "$(fstab_text)"
}
