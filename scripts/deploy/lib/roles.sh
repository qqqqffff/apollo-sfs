# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/roles.sh — storage roles, % allocation and XFS project-quota enforcement (WS2).
#
# Only "blob storage shard" (this node's MinIO) exists today. The other three
# roles are recorded with implemented=false and a note, and their share simply
# stays free on the node's drives for the future feature.
#
# Enforcement: the admin sync takes a tier's capacity from MinIO's reported
# disk size, so the blob share is enforced by making MinIO SEE the share — an
# XFS project quota on each drive's data/ directory (statfs on a project-
# inherit dir reports the quota; mergerfs sums the branches). Drives formatted
# by deploy.sh are mounted with prjquota from day one; adopted drives need a
# remount, which `update` offers (opt-in, brief MinIO stop).
# ─────────────────────────────────────────────────────────────────────────────

ROLES_KEYS=(postgres_shard blob_storage_shard database_backup blob_storage_redundancy)
declare -gA ROLES_LABEL=(
  [postgres_shard]="Postgres shard"
  [blob_storage_shard]="Blob storage shard"
  [database_backup]="Database backup"
  [blob_storage_redundancy]="Blob storage redundancy"
)
declare -gA ROLES_NOTE=(
  [blob_storage_shard]="Serves this node's storage tier through MinIO (minio = fast tier, minio-standard = standard tier)."
  [postgres_shard]="Reserved — Postgres sharding is not implemented yet. This share stays free on the node's drives for it."
  [database_backup]="Reserved — database backups to this node are not implemented yet. This share stays free for backup archives."
  [blob_storage_redundancy]="Reserved — blob redundancy (a second copy of another node's blobs) is not implemented yet. This share stays free for it."
)
ROLES_PROJECT_ID=1001       # XFS project id used for <mount>/data on every drive

_roles_implemented() { [[ "$1" == blob_storage_shard ]]; }

# _roles_base — allocation base in bytes (the node's assigned drives).
_roles_base() {
  local b; b="$(state_get storage_base_bytes "")"
  [[ "$b" =~ ^[0-9]+$ && "$b" -gt 0 ]] && { printf '%s' "$b"; return; }
  node_json_get deployment.drives '[]' | python3 -I -c 'import json,sys; print(sum(int(d.get("size_bytes") or 0) for d in json.load(sys.stdin) if not d.get("unassigned")))'
}

# _roles_blob_usage — bytes currently stored in the drives' data/ dirs.
_roles_blob_usage() {
  local total=0 dir used
  while IFS= read -r dir; do
    [[ -n "$dir" ]] || continue
    used="$(probe "df-used-$(probe_key "$dir")" -- df -B1 --output=used "$dir" 2>/dev/null | tail -n1 | tr -d ' ' || true)"
    [[ "$used" =~ ^[0-9]+$ ]] && total=$((total + used))
  done < <(node_json_get deployment.drives '[]' | python3 -I -c 'import json,sys; [print(d["data_dir"]) for d in json.load(sys.stdin) if not d.get("unassigned") and d.get("adopted") and d.get("data_dir")]')
  printf '%s' "$total"
}

# deploy_step_roles — STEP (deploy + update).
deploy_step_roles() {
  local base tier
  base="$(_roles_base)"; tier="$(state_get storage_tier "$(node_json_get deployment.storage.tier "")")"
  if [[ ! "$base" =~ ^[0-9]+$ || "$base" -eq 0 ]]; then
    log_info "This node has no Apollo drives, so there is no storage to allocate to roles."
    printf '{"roles":{}}' | node_json_merge deployment >/dev/null
    return 2
  fi
  ui_kv "storage" "$(fmt_bytes "$base") on the $tier tier"

  # Blob storage needs a tier that no other node serves (one MinIO endpoint per tier).
  local -a dis=()
  if [[ -z "$tier" ]]; then
    dis+=(--disable "blob_storage_shard=this node has no storage tier")
  else
    local holder="" rc=0
    cluster_call info --quiet || rc=$?
    [[ $rc -eq 0 ]] && holder="$(mgr_data "tiers.$tier" "")"
    if [[ -n "$holder" ]] && ! node_is_self "$holder"; then
      dis+=(--disable "blob_storage_shard=the $tier tier is already served by $holder (one blob node per tier)")
    elif [[ -n "$holder" && "$holder" != "$(node_name)" ]]; then
      log_info "The $tier tier's blob storage is served by this node under its old name '$holder'."
      log_info "It carries over to '$(node_name)': same drives, same data, same MinIO service — only the name changes."
    fi
  fi

  local cur; cur="$(node_json_get deployment.roles '{}' 2>/dev/null)"
  local -a pre=() opts=()
  local k
  for k in "${ROLES_KEYS[@]}"; do
    local lab="${ROLES_LABEL[$k]}"
    _roles_implemented "$k" || lab+=" (reserved — not implemented yet)"
    opts+=("$k=$lab")
    [[ "$(printf '%s' "$cur" | json_get "$k.enabled" false)" == true ]] && pre+=(--preselect "$k")
  done
  if ((${#pre[@]} == 0)) && [[ ${#dis[@]} -eq 0 ]]; then pre=(--preselect blob_storage_shard); fi

  while true; do
    local -a picked=()
    checklist picked "Roles for this node (select at least one):" --min 1 "${pre[@]+"${pre[@]}"}" "${dis[@]+"${dis[@]}"}" "${opts[@]}"
    local -a ordered=()
    for k in "${ROLES_KEYS[@]}"; do [[ " ${picked[*]} " == *" $k "* ]] && ordered+=("$k"); done
    declare -A pct=()
    local rem=100 i pend v def usage
    usage=0; [[ " ${ordered[*]} " == *" blob_storage_shard "* ]] && usage="$(_roles_blob_usage)"
    for i in "${!ordered[@]}"; do
      k="${ordered[$i]}"
      pend=$(( ${#ordered[@]} - i - 1 ))
      def="$(printf '%s' "$cur" | json_get "$k.percent" "")"
      [[ "$def" =~ ^[0-9]+$ ]] && (( def >= 1 && def <= rem - pend )) || def=""
      (( ${#ordered[@]} == 1 )) && [[ -z "$def" ]] && def=100
      while true; do
        if [[ -n "$def" ]]; then ask_percent v "${ROLES_LABEL[$k]}" --remaining "$rem" --pending "$pend" --base "$base" --default "$def"
        else ask_percent v "${ROLES_LABEL[$k]}" --remaining "$rem" --pending "$pend" --base "$base"; fi
        if [[ "$k" == blob_storage_shard && "$usage" -gt 0 ]]; then
          local share; share=$(( base / 100 * v ))
          if (( share < usage + usage / 20 )); then
            log_warn "The drives already hold $(fmt_bytes "$usage") of blobs; $v% is $(fmt_bytes "$share") — leave at least 5% headroom."
            def=""; continue
          fi
        fi
        break
      done
      pct[$k]="$v"
      rem=$(( rem - v ))
    done

    local -a rows=("ROLE|SHARE|SIZE|STATUS")
    for k in "${ordered[@]}"; do
      rows+=("${ROLES_LABEL[$k]}|${pct[$k]}%|$(fmt_bytes $(( base / 100 * pct[$k] )))|$(_roles_implemented "$k" && echo active || echo 'reserved (not implemented yet)')")
    done
    (( rem > 0 )) && rows+=("unallocated|$rem%|$(fmt_bytes $(( base / 100 * rem )))|free")
    ui_table "${rows[@]}"
    ask_yn "Apply this allocation?" y && break
    pre=(); for k in "${ordered[@]}"; do pre+=(--preselect "$k"); done
  done

  # Record every role (enabled or not) so the plan is complete in node.json.
  local json="{" first=1 enf bytes en p
  for k in "${ROLES_KEYS[@]}"; do
    en=false; p=0; bytes=0; enf=none
    if [[ -n "${pct[$k]+x}" ]]; then
      en=true; p="${pct[$k]}"; bytes=$(( base / 100 * p ))
      if _roles_implemented "$k"; then enf="$(_roles_enforce_blob "$p")"; else enf=recorded; fi
    fi
    [[ $first == 1 ]] || json+=","; first=0
    json+="$(json_escape "$k"):{\"enabled\":$en,\"implemented\":$(_roles_implemented "$k" && echo true || echo false),\"percent\":$p,\"bytes\":$bytes,\"enforcement\":$(json_escape "$enf"),\"note\":$(json_escape "${ROLES_NOTE[$k]}")}"
  done
  json+="}"
  printf '{"roles":%s}' "$json" | node_json_merge deployment >/dev/null || return 1
  return 0
}

# _roles_enforce_blob PCT — apply the blob share to every assigned drive.
# Prints the overall enforcement: none | prjquota | pending-remount | recorded.
_roles_enforce_blob() {
  local pct="$1"
  if (( pct >= 100 )); then
    log_info "Blob storage gets the whole drives — no quota needed."
    printf none; return 0
  fi
  local overall=prjquota label fs prj mnt size
  while IFS='|' read -r label fs prj mnt size; do
    [[ -n "$label" ]] || continue
    if [[ "$fs" == xfs && "$prj" == True ]]; then
      _roles_apply_quota "$mnt" $(( size / 100 * pct )) || overall=recorded
    elif [[ "$fs" == xfs ]]; then
      log_info "$label (adopted) is mounted without project quotas — the $pct% share is recorded; './deploy.sh update' can remount it to enforce it."
      [[ "$overall" == prjquota ]] && overall=pending-remount
    else
      log_info "$label is $fs — project quotas need XFS, so the $pct% share is recorded only."
      overall=recorded
    fi
  done < <(node_json_get deployment.drives '[]' | python3 -I -c 'import json,sys; [print("%s|%s|%s|%s|%s" % (d["label"], d.get("fs"), d.get("prjquota"), d["mountpoint"], int(d.get("size_bytes") or 0))) for d in json.load(sys.stdin) if not d.get("unassigned")]')
  printf '%s' "$overall"
}

# _roles_apply_quota MNT BYTES — project quota on MNT/data (online).
_roles_apply_quota() {
  local mnt="$1" bytes="$2" kib=$(( $2 / 1024 ))
  log_info "Limiting blob data on $mnt to $(fmt_bytes "$bytes") (XFS project quota)…"
  run -- xfs_quota -x -c "project -s -p $mnt/data $ROLES_PROJECT_ID" "$mnt" >/dev/null || return 1
  run -- xfs_quota -x -c "limit -p bhard=${kib}k $ROLES_PROJECT_ID" "$mnt" >/dev/null || return 1
  return 0
}

# roles_remount_with_quota LABEL… — opt-in (update): remount adopted XFS
# drives with prjquota. Every container holding the mount must stop first,
# otherwise the kernel keeps the old superblock (and its options).
roles_remount_with_quota() {
  local -a labels=("$@") svcs=()
  local tier svc; tier="$(node_json_get deployment.storage.tier "")"
  [[ "$tier" == fast ]] && svc=minio || svc=minio-standard
  svcs+=("$svc")
  local agent; agent="$(node_json_get deployment.stack.services '[]' | python3 -I -c 'import json,sys; print(next((s for s in json.load(sys.stdin) if s.startswith("node-agent")), ""))')"
  [[ -n "$agent" ]] && svcs+=("$agent")
  [[ "$(node_role)" == manager ]] && svcs+=(api)
  log_warn "Stopping ${svcs[*]} while the drives are remounted…"
  local f; f="$(mktemp "${TMPDIR:-/tmp}/apollo-scale.XXXXXX")"
  printf '{"services":{%s}}' "$(printf '"%s":0,' "${svcs[@]}" | sed 's/,$//')" >"$f"
  cluster_call scale --in "$f" || { rm -f "$f"; log_error "could not stop the services — nothing was remounted"; return 1; }
  local pool; pool="$(node_json_get deployment.pools.0.path "")"
  [[ -n "$pool" ]] && run -- systemctl stop "$(_drives_unit_for "$pool")"
  local label mnt fixed tmp ok=1
  for label in "${labels[@]}"; do
    mnt="$(node_json_get deployment.drives '[]' | python3 -I -c 'import json,sys; print(next(d["mountpoint"] for d in json.load(sys.stdin) if d["label"] == sys.argv[1]))' "$label")"
    run -- systemctl stop "$(_drives_unit_for "$mnt")" || { ok=0; continue; }
    tmp="$(mktemp "${TMPDIR:-/tmp}/apollo-fstab.XXXXXX")"; fstab_text >"$tmp"
    fixed="$(py disks fstab-fix --fstab "$tmp" --target "$mnt" --add prjquota,nofail,x-systemd.device-timeout=10)"; rm -f "$tmp"
    [[ -n "$fixed" ]] && fstab_upsert "mount-$(probe_key "$label")" "$fixed" --replace-target "$mnt"
    _drives_start_mount "$mnt" "" || ok=0
  done
  if [[ -n "$pool" ]]; then
    local -a pm=(); mapfile -t pm < <(node_json_get deployment.drives '[]' | python3 -I -c 'import json,sys; [print(d["mountpoint"]) for d in json.load(sys.stdin) if not d.get("unassigned")]')
    _drives_pool_start "$pool" "${pm[@]}" || ok=0
  fi
  printf '{"services":{%s}}' "$(printf '"%s":1,' "${svcs[@]}" | sed 's/,$//')" >"$f"
  cluster_call scale --in "$f" || log_error "could not restart ${svcs[*]} — run ./deploy.sh restart"
  rm -f "$f"
  [[ $ok == 1 ]] || { log_error "some drives did not come back with prjquota — check 'findmnt' and run ./deploy.sh restart"; return 1; }
  local rest; rest="$(node_json_get deployment.drives '[]' | python3 -I -c 'import json,sys; r=json.load(sys.stdin)
for d in r:
    if d["label"] in sys.argv[1:]: d["prjquota"] = True
print(json.dumps(r))' "${labels[@]}")"
  node_json_set deployment.drives "$rest" >/dev/null || return 1
  local pct; pct="$(node_json_get deployment.roles.blob_storage_shard.percent 100)"
  local enf; enf="$(_roles_enforce_blob "$pct")"
  node_json_set deployment.roles.blob_storage_shard.enforcement "\"$enf\"" >/dev/null || true
  log_ok "Quota enforcement: $enf"
  return 0
}

# drift_roles — update drift lines.
drift_roles() {
  local roles; roles="$(node_json_get deployment.roles '{}' 2>/dev/null)"
  [[ "$roles" == "{}" ]] && { echo "info|roles|no roles recorded"; return 0; }
  local enf; enf="$(printf '%s' "$roles" | json_get blob_storage_shard.enforcement none)"
  [[ "$enf" == pending-remount ]] && echo "info|roles|blob share not enforced yet (adopted drives need a prjquota remount)"
  [[ "$(state_get drives_changed 0)" == 1 ]] && echo "warn|roles|drives changed — re-check the allocation"
  echo "ok|roles|$(printf '%s' "$roles" | python3 -I -c 'import json,sys; r=json.load(sys.stdin); print(", ".join("%s %s%%" % (k, v.get("percent")) for k, v in r.items() if v.get("enabled")))')"
}
