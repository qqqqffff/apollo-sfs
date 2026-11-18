# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/handover.sh — taking over as manager, with data migration (WS5).
#
# N = this node (the new manager), O = the current manager. Sequence:
#   handover_run (membership step)
#     preflight on O → typed HANDOVER → N joins as a WORKER first (a long
#     two-manager window would make every cluster change need both nodes) →
#     static config copied O→N (.env, cluster/, TLS, GeoIP.conf, well-known,
#     auto-blocked.conf) — no downtime yet.
#   … N runs its own steps (status service, manager infra, drives, roles) …
#   handover_finish (services step)
#     maintenance window: O scales the app + postfix to 0 → pg_dump of both DBs
#     (backup) + row counts/checksums → O stops both DBs → the data dirs,
#     e-mail, postfix spool and registry are copied (byte-exact, same image and
#     arch) → verified on N with throw-away Postgres containers → O promotes N
#     → the apollo-manager label moves → registry on N → deploy from N (point
#     of no return once N's api serves) → migrations → health → O demoted →
#     O's DB dirs renamed *.handover-<ts> (never deleted) → router reminder.
# Root-owned files on O are read through a container (`docker run -v …:ro
# postgres:16-alpine tar`), so the ssh user (docker group) never needs sudo.
# ─────────────────────────────────────────────────────────────────────────────

HANDOVER_APP_SERVICES=(api node-metrics-ingest keycloak frontend recognition test-runner postfix)
HANDOVER_STATIC=(env cluster tls geoip_conf wellknown autoblock)
HANDOVER_DATA=(pg_app_data pg_kc_data email postfix registry)
HANDOVER_IMAGE="postgres:16-alpine"     # already on the manager → nothing is pulled
HANDOVER_EMAIL_DIR="/home/apollo/service-worker-email"

# _handover_item ITEM — "kind|source path on O|destination on N" (whitelist).
_handover_item() {
  local repo="${MGR_REPO:-$APOLLO_ROOT}"
  case "$1" in
    env)         printf 'file|%s/.env|%s/.env' "$repo" "$APOLLO_ROOT" ;;
    cluster)     printf 'dir|%s/cluster|%s/cluster' "$repo" "$APOLLO_ROOT" ;;
    tls)         printf 'dir|/etc/ssl/cloudflare|/etc/ssl/cloudflare' ;;
    geoip_conf)  printf 'file|/etc/GeoIP.conf|/etc/GeoIP.conf' ;;
    wellknown)   printf 'dir|/etc/nginx/well-known|/etc/nginx/well-known' ;;
    autoblock)   printf 'file|/etc/nginx/blocklist.d/auto-blocked.conf|/etc/nginx/blocklist.d/auto-blocked.conf' ;;
    pg_app_data) printf 'dir|%s/docker/postgresql-app|%s/docker/postgresql-app' "$repo" "$APOLLO_ROOT" ;;
    pg_kc_data)  printf 'dir|%s/docker/postgresql-keycloak|%s/docker/postgresql-keycloak' "$repo" "$APOLLO_ROOT" ;;
    email)       printf 'dir|%s|%s' "$HANDOVER_EMAIL_DIR" "$HANDOVER_EMAIL_DIR" ;;
    postfix)     printf 'dir|%s/docker/postfix|%s/docker/postfix' "$repo" "$APOLLO_ROOT" ;;
    registry)    printf 'dir|/srv/registry|/srv/registry' ;;
    db_app_dump|db_kc_dump) printf 'dump|-|-' ;;
    *) return 1 ;;
  esac
}

# _handover_pull ITEM — stream ITEM from O and unpack it on N.
_handover_pull() {
  local item="$1" spec kind dest
  spec="$(_handover_item "$item")" || { log_error "unknown handover item $item"; return 1; }
  IFS='|' read -r kind _ dest <<<"$spec"
  log_info "Copying $item → $dest"
  if [[ "$kind" == file ]]; then
    ensure_dir "$(dirname "$dest")" 0755 root:root || return 1
  else
    ensure_dir "$dest" 0755 root:root || return 1
  fi
  local tdir; [[ "$kind" == file ]] && tdir="$(dirname "$dest")" || tdir="$dest"
  mgr handover-export --stream -- "$item" | run --stdin -- tar -x --numeric-owner -p -C "$tdir" ||
    { log_error "copying $item failed"; return 1; }
  [[ "$item" == env ]] && { run -- chown "$REPO_OWNER:$REPO_GROUP" "$dest"; run -- chmod 600 "$dest"; }
  return 0
}

_handover_phase() {
  state_set handover_phase "$1"
  printf '{"handover":{"phase":%s,"updated_at":%s}}' "$(json_escape "$1")" "$(json_escape "$(now_iso)")" | node_json_merge deployment >/dev/null || true
}

# _handover_local_facts — JSON describing N for the preflight.
_handover_local_facts() {
  local arch free commit empty=true d
  arch="$(probe uname-m -- uname -m 2>/dev/null || echo unknown)"
  free="$(probe df-avail-repo -- df -B1 --output=avail "$APOLLO_ROOT" 2>/dev/null | tail -n1 | tr -d ' ')"
  commit="$(git -C "$APOLLO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  for d in "$APOLLO_ROOT/docker/postgresql-app" "$APOLLO_ROOT/docker/postgresql-keycloak"; do
    [[ -n "$(probe "ls-$(probe_key "$d")" -- ls -A "$d" 2>/dev/null)" ]] && empty=false
  done
  printf '{"candidate":{"hostname":%s,"arch":%s,"free_bytes":%s,"commit":%s,"targets_empty":%s}}' \
    "$(json_escape "$(node_name)")" "$(json_escape "$arch")" "${free:-0}" "$(json_escape "$commit")" "$empty"
}

# handover_evaluate FACTS_JSON PREFLIGHT_DATA_JSON — print blockers ("B …")
# and warnings ("W …"). Pure (unit-tested).
handover_evaluate() {
  python3 -I -c '
import json, sys
c = json.loads(sys.argv[1])["candidate"]; o = json.loads(sys.argv[2] or "{}")
for b in o.get("blockers") or []: print("B " + b)
for w in o.get("warnings") or []: print("W " + w)
if c.get("arch") not in ("x86_64", "amd64"):
    print("B this node is %s; frontend, recognition, test-runner and node-metrics-ingest are amd64-only images" % c.get("arch"))
if o.get("commit") and c.get("commit") and o["commit"] != c["commit"]:
    print("B this repo is at %s but the manager is at %s — check out the same commit on both" % (c["commit"], o["commit"]))
need = int(o.get("need_bytes") or 0)
if need and int(c.get("free_bytes") or 0) < need * 1.2:
    print("B needs %.1f GB free here (data + dumps + 20%%), only %.1f GB available" % (need * 1.2 / 1e9, int(c.get("free_bytes") or 0) / 1e9))
if not c.get("targets_empty"):
    print("B docker/postgresql-app or docker/postgresql-keycloak on this node is not empty — move it aside first")
' "$1" "$2"
}

# handover_run — membership: preflight, confirm, join as worker, static copy.
# rc 0 ready · 1 failed · 3 the user backed out (caller offers worker instead).
handover_run() {
  ui_section "Taking over as manager — with data migration"
  log_info "  $(state_get manager_hostname "the current manager") keeps running until the maintenance window (in the services step);"
  log_info "  then the app is offline while both databases, e-mail, the postfix spool and the registry are copied."
  local facts f rc=0
  facts="$(_handover_local_facts)"
  f="$(mktemp "${TMPDIR:-/tmp}/apollo-ho.XXXXXX")"; printf '%s' "$facts" >"$f"
  mgr handover-preflight --in "$f" || rc=$?
  rm -f "$f"
  if [[ $rc -ne 0 ]]; then
    is_test || { STEP_FAIL_REASON="the manager's deploy.sh could not run the handover preflight (update it first)"; return 1; }
    MGR_RESPONSE='{"data":{}}'
  fi
  local data; data="$(printf '%s' "$MGR_RESPONSE" | json_get data '{}')"
  local verdict kind msg blockers=0
  verdict="$(handover_evaluate "$facts" "$data")"
  while IFS=' ' read -r kind msg; do
    [[ -n "$kind" ]] || continue
    if [[ "$kind" == B ]]; then log_error "blocker: $msg"; blockers=$((blockers + 1)); else log_warn "$msg"; fi
  done <<<"$verdict"
  if (( blockers > 0 )); then
    STEP_FAIL_REASON="$blockers blocker(s) prevent taking over as manager"
    return 3
  fi
  ui_kv "data to copy" "$(fmt_bytes "$(printf '%s' "$data" | json_get need_bytes 0)")"
  confirm_typed HANDOVER "This node will REPLACE $(state_get manager_hostname "the manager") as manager. Its data is migrated here; the old manager becomes a worker and keeps its copy." || return 3
  if [[ "$(state_get already_worker 0)" != 1 ]]; then
    _cluster_join_worker "$MGR_HOST" || return 1
  fi
  local item
  for item in "${HANDOVER_STATIC[@]}"; do
    _handover_pull "$item" || log_warn "$item was not copied (it may not exist on the old manager)"
  done
  state_set handover 1
  state_set role manager
  state_set force_remote_manager 1
  state_set old_manager_host "$MGR_HOST"
  state_set old_manager_hostname "$(state_get manager_hostname "")"
  printf '{"handover":{"phase":"prepared","from":%s,"from_addr":%s,"started_at":%s}}' \
    "$(json_escape "$(state_get manager_hostname "")")" "$(json_escape "$MGR_HOST")" "$(json_escape "$(now_iso)")" |
    node_json_merge deployment >/dev/null || true
  state_set handover_phase prepared
  log_ok "Prepared. This node now sets up its manager infrastructure; the data moves in the services step."
  return 0
}

# _handover_counts_local DIR — counts from a throw-away Postgres on DIR.
_handover_counts_local() {
  local dir="$1" which="$2"
  local name="apollo-handover-verify-$which"
  run -- docker run -d --name "$name" -v "$dir:/var/lib/postgresql/data" "$HANDOVER_IMAGE" >/dev/null || return 1
  if is_test; then run -- docker rm -f "$name" >/dev/null; printf '{}'; return 0; fi
  local i
  for i in $(seq 1 60); do docker exec "$name" pg_isready -q >/dev/null 2>&1 && break; sleep 2; done
  local out; out="$(docker exec "$name" sh -c "$(_handover_count_sql_cmd "$which")" 2>/dev/null || true)"
  run -- docker rm -f "$name" >/dev/null
  printf '%s' "$out"
}

# _handover_count_sql_cmd app|kc — shell for inside a postgres container that
# prints JSON counts + checksums for the key tables (same on O and N).
_handover_count_sql_cmd() {
  local tables
  if [[ "$1" == app ]]; then tables="users files folders servers nodes drives user_drive_allocations"
  else tables="user_entity client realm"; fi
  local q="SELECT json_build_object("
  local t first=1
  for t in $tables; do
    [[ $first == 1 ]] || q+=","; first=0
    q+="'$t', (SELECT json_build_object('rows', count(*), 'md5', md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), ''))) FROM $t t)"
  done
  q+=")"
  printf 'psql -X -At -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -c %q' "$q"
}

# handover_finish — services step: maintenance window → copy → verify → switch.
handover_finish() {
  local old_host old_name me ts bdir
  old_host="$(state_get old_manager_host "$MGR_HOST")"; old_name="$(state_get old_manager_hostname "")"
  me="$(node_name)"; ts="$(date +%Y%m%d-%H%M%S)"; bdir="$BACKUP_ROOT/handover-$ts"
  ui_section "Handover: maintenance window"
  confirm_typed MAINTENANCE "The app goes OFFLINE now until the switch completes." || { STEP_FAIL_REASON="handover not started"; return 1; }
  local f rc=0
  f="$(mktemp "${TMPDIR:-/tmp}/apollo-ho.XXXXXX")"
  printf '{"on":true}' >"$f"
  mgr handover-maintenance --in "$f" || { rm -f "$f"; STEP_FAIL_REASON="the old manager could not stop the app"; return 1; }
  _handover_phase maintenance

  # Logical dumps first — a safety net independent of the byte copy.
  ensure_dir "$bdir" 0700 root:root || return 1
  local which
  for which in app kc; do
    log_info "Dumping the $which database (pg_dump -Fc) → $bdir/$which.dump"
    mgr handover-export --stream -- "db_${which}_dump" | run --stdin -- cp /dev/stdin "$bdir/$which.dump" || {
      _handover_rollback "$f"; STEP_FAIL_REASON="pg_dump of $which failed"; return 1; }
  done
  mgr handover-counts || { _handover_rollback "$f"; STEP_FAIL_REASON="could not read row counts on the old manager"; return 1; }
  local want; want="$(mgr_data counts '{}')"

  printf '{"services":{"db-app":0,"db-keycloak":0}}' >"$f"
  mgr scale --in "$f" || { _handover_rollback "$f"; STEP_FAIL_REASON="could not stop the old databases"; return 1; }
  _handover_phase copying
  local item
  for item in "${HANDOVER_DATA[@]}"; do
    _handover_pull "$item" || { _handover_rollback "$f"; STEP_FAIL_REASON="copying $item failed"; return 1; }
  done

  ui_section "Handover: verifying the copied databases"
  local got_app got_kc
  got_app="$(_handover_counts_local "$APOLLO_ROOT/docker/postgresql-app" app)" || { _handover_rollback "$f"; return 1; }
  got_kc="$(_handover_counts_local "$APOLLO_ROOT/docker/postgresql-keycloak" kc)" || { _handover_rollback "$f"; return 1; }
  if ! is_test; then
    local cmp; cmp="$(handover_compare_counts "$want" "{\"app\":$got_app,\"kc\":$got_kc}")"
    if [[ -n "$cmp" ]]; then
      log_error "The copied databases differ from the originals:"; printf '%s\n' "$cmp" | sed 's/^/    /' >&2
      _handover_rollback "$f"; STEP_FAIL_REASON="database verification failed — rolled back (nothing changed on $old_name)"; return 1
    fi
  fi
  log_ok "Copied databases match the originals."

  ui_section "Handover: switching the manager"
  printf '{"hostname":%s}' "$(json_escape "$me")" >"$f"
  mgr promote --in "$f" || { _handover_rollback "$f"; STEP_FAIL_REASON="promoting this node failed"; return 1; }
  _handover_phase switching
  state_unset force_remote_manager
  run -- docker node update --label-add apollo-manager=true "$me" >/dev/null || return 1
  [[ -n "$old_name" ]] && run -- docker node update --label-rm apollo-manager "$old_name" >/dev/null
  manager_ensure_registry || log_warn "the registry did not start on this node"
  local reg
  reg="$(state_get lan_ip ""):5000"
  printf '{"cluster":{"registry":%s,"role":"manager","manager":{"hostname":%s,"addr":%s}}}' "$(json_escape "$reg")" \
    "$(json_escape "$me")" "$(json_escape "$(state_get lan_ip ""):2377")" | node_json_merge deployment >/dev/null
  _handover_set_env_registry "$reg"
  local deadline
  log_info "Deploying the stack from this node — services move here now (point of no return once the api serves)."
  rc=0; stack_register_node full || rc=$?
  if [[ $rc -ne 0 ]] || ! _handover_api_up; then
    log_error "The stack did not come up healthy on this node."
    if ask_yn "Roll back to $old_name (labels back, redeploy there)? Writes made here since the switch would be lost." y; then
      run -- docker node update --label-add apollo-manager=true "$old_name" >/dev/null
      run -- docker node update --label-rm apollo-manager "$me" >/dev/null
      stack_deploy && log_warn "Rolled back: services run on $old_name again. This node stays a manager — demote it there: docker node demote $me"
    fi
    STEP_FAIL_REASON="handover switch failed"
    return 1
  fi
  run -- env STACK_NAME="$STACK_NAME" "$APOLLO_ROOT/db/apply-migrations.sh" || log_warn "migrations reported an error — check ./db/apply-migrations.sh"
  [[ -n "$old_name" ]] && run -- docker node demote "$old_name" >/dev/null
  _handover_phase finalizing
  printf '{"suffix":%s}' "$(json_escape "handover-$ts")" >"$f"
  mgr handover-finalize --in "$f" || log_warn "could not rename the old database dirs on $old_name — do it by hand (never start them again)"
  rm -f "$f"
  printf '{"handover":{"phase":"done","at":%s,"from":%s,"to":%s,"backup":%s}}' "$(json_escape "$(now_iso)")" \
    "$(json_escape "$old_name")" "$(json_escape "$me")" "$(json_escape "$bdir")" | node_json_merge deployment >/dev/null || true
  state_set handover 0
  alert_ack info handover-router "This node is now the manager" \
    "1. Point the router's 80/443 forward at $(state_get lan_ip "this node").
2. On $old_name run ./deploy.sh update — it offers to disable its leftover nginx, fail2ban and registry.
3. The dumps taken before the copy are in $bdir."
  return 0
}

_handover_api_up() {
  is_test && return 0
  local i
  for i in $(seq 1 60); do curl -fsS -m 3 -o /dev/null http://127.0.0.1:8080/api/v1/health 2>/dev/null && return 0; sleep 5; done
  return 1
}

_handover_set_env_registry() {
  local reg="$1" cur
  cur="$(read_file "$DOTENV_FILE" 2>/dev/null || true)"
  [[ -n "$cur" ]] || return 0
  printf '%s\n' "$cur" | sed -E "s|^REGISTRY=.*|REGISTRY='$reg'|" | write_file "$DOTENV_FILE" 0600 "$REPO_OWNER:$REPO_GROUP" --env
}

_handover_rollback() {
  local f="$1"
  log_warn "Rolling back: restarting the app on $(state_get old_manager_hostname "the old manager")…"
  printf '{}' >"$f"
  mgr handover-rollback --in "$f" || log_error "rollback failed — on the old manager run: ./deploy.sh restart"
  rm -f "$f"
  _handover_phase rolled-back
}

# handover_compare_counts WANT GOT — print mismatches (empty = equal). Pure.
handover_compare_counts() {
  python3 -I -c '
import json, sys
want, got = json.loads(sys.argv[1] or "{}"), json.loads(sys.argv[2] or "{}")
for db, tables in want.items():
    for t, v in (tables or {}).items():
        g = (got.get(db) or {}).get(t)
        if g != v:
            print("%s.%s: original %s, copy %s" % (db, t, v, g))' "$1" "$2"
}

# ── manager-side ops (run on O as the ssh user; no sudo) ─────────────────────
_handover_db_container() { probe "docker-${1}-id" -- docker ps -qf "name=${STACK_NAME}_$1" 2>/dev/null | head -n1; }

remote_op_handover_preflight() {
  manager_env_load >/dev/null 2>&1 || true
  local need=0 item spec kind src sz
  for item in "${HANDOVER_DATA[@]}"; do
    spec="$(_handover_item "$item")"; IFS='|' read -r kind src _ <<<"$spec"
    sz="$(probe "du-$(probe_key "$item")" -- docker run --rm -v "$src:/d:ro" "$HANDOVER_IMAGE" du -sb /d 2>/dev/null | awk '{print $1}')"
    [[ "$sz" =~ ^[0-9]+$ ]] && need=$((need + sz))
  done
  need=$((need * 3 / 2))   # + the pg_dump files (compressed, well under half)
  local blockers=() warnings=()
  _stack_running || blockers+=("the apollo-sfs stack is not running on this manager")
  [[ -n "$(_handover_db_container db-app)" ]] || warnings+=("db-app is not running here — only the files will be copied")
  local bad; bad="$(probe docker-stack-services-replicas -- docker stack services "$STACK_NAME" --format '{{.Name}} {{.Replicas}}' 2>/dev/null | awk '{split($2,r,"/"); if (r[1]!=r[2]) printf "%s ", $1}')"
  [[ -n "$bad" ]] && warnings+=("not all services are healthy here: $bad")
  python3 -I -c 'import json,sys; print(json.dumps({"need_bytes": int(sys.argv[1]), "commit": sys.argv[2], "arch": sys.argv[3],
    "blockers": [x for x in sys.argv[4].split("\n") if x], "warnings": [x for x in sys.argv[5].split("\n") if x]}))' \
    "$need" "$(git -C "$APOLLO_ROOT" rev-parse --short HEAD 2>/dev/null || true)" "$(uname -m)" \
    "$(printf '%s\n' "${blockers[@]+"${blockers[@]}"}")" "$(printf '%s\n' "${warnings[@]+"${warnings[@]}"}")"
}

remote_op_handover_counts() {
  manager_env_load >/dev/null 2>&1 || true
  local app kc ca ck
  ca="$(_handover_db_container db-app)"; ck="$(_handover_db_container db-keycloak)"
  [[ -n "$ca" && -n "$ck" ]] || { remote_fail no_db "db-app/db-keycloak are not running"; return 1; }
  app="$(probe psql-handover-counts-app -- docker exec -e POSTGRES_USER="$POSTGRES_APP_USER" -e POSTGRES_DB="$POSTGRES_APP_DB" "$ca" sh -c "$(_handover_count_sql_cmd app)" 2>/dev/null)"
  kc="$(probe psql-handover-counts-kc -- docker exec -e POSTGRES_USER="$POSTGRES_KC_USER" -e POSTGRES_DB="$POSTGRES_KC_DB" "$ck" sh -c "$(_handover_count_sql_cmd kc)" 2>/dev/null)"
  printf '{"counts":{"app":%s,"kc":%s}}' "${app:-{\}}" "${kc:-{\}}"
}

remote_op_handover_maintenance() {
  local on; on="$(remote_req on true)"
  local state="$CLUSTER_DIR/handover-replicas.json"
  if [[ "$on" == true ]]; then
    local out="{" first=1 s r
    for s in "${HANDOVER_APP_SERVICES[@]}"; do
      r="$(probe "docker-svc-replicas-$s" -- docker service inspect "${STACK_NAME}_$s" --format '{{.Spec.Mode.Replicated.Replicas}}' 2>/dev/null || true)"
      [[ "$r" =~ ^[0-9]+$ ]] || continue
      [[ $first == 1 ]] || out+=","; first=0
      out+="$(json_escape "$s"):$r"
      run -- docker service scale --detach=false "${STACK_NAME}_$s=0" >/dev/null || { remote_fail scale_failed "could not stop $s"; return 1; }
    done
    out+="}"
    ensure_dir "$CLUSTER_DIR" 0755 "$REPO_OWNER" >/dev/null
    printf '%s\n' "$out" | write_file "$state" 0644 "$REPO_OWNER" >/dev/null || return 1
    printf '{"stopped":%s}' "$out"
  else
    _handover_restore_replicas
  fi
}

_handover_restore_replicas() {
  local state="$CLUSTER_DIR/handover-replicas.json" recorded s r
  recorded="$(read_file "$state" 2>/dev/null || echo '{}')"
  for s in db-app db-keycloak "${HANDOVER_APP_SERVICES[@]}"; do
    r="$(printf '%s' "$recorded" | json_get "$s" 1)"
    run -- docker service scale --detach=false "${STACK_NAME}_$s=$r" >/dev/null || log_warn "could not restart $s"
  done
  printf '{"restored":%s}' "$recorded"
}

remote_op_handover_rollback() { _handover_restore_replicas; }

# remote_op_handover_export ITEM — STREAM op: raw tar / pg_dump on stdout.
remote_op_handover_export() {
  local item="${1:-}" spec kind src
  spec="$(_handover_item "$item")" || { log_error "refusing unknown export item '$item'"; return 2; }
  IFS='|' read -r kind src _ <<<"$spec"
  if is_test; then log_test "would stream $item ($kind $src)"; return 0; fi
  manager_env_load >/dev/null 2>&1 || true
  case "$kind" in
    dump)
      local svc user db
      if [[ "$item" == db_app_dump ]]; then svc="db-app"; user="$POSTGRES_APP_USER"; db="$POSTGRES_APP_DB"
      else svc="db-keycloak"; user="$POSTGRES_KC_USER"; db="$POSTGRES_KC_DB"; fi
      docker exec "$(_handover_db_container "$svc")" pg_dump -Fc -U "$user" "$db" ;;
    file)
      [[ -e "$src" ]] || { log_warn "$src does not exist here"; tar -cf - -T /dev/null; return 0; }
      docker run --rm -v "$(dirname "$src"):/src:ro" "$HANDOVER_IMAGE" tar -C /src -cf - "$(basename "$src")" ;;
    dir)
      [[ -e "$src" ]] || { log_warn "$src does not exist here"; tar -cf - -T /dev/null; return 0; }
      docker run --rm -v "$src:/src:ro" "$HANDOVER_IMAGE" tar -C /src -cf - . ;;
  esac
}

# remote_op_handover_finalize — rename the old DB dirs so a stale database can
# never start here again (renamed, never deleted). Runs after demotion, so it
# only uses local docker.
remote_op_handover_finalize() {
  local suffix; suffix="$(remote_req suffix "handover-$(date +%Y%m%d-%H%M%S)")"
  [[ "$suffix" =~ ^[A-Za-z0-9._-]+$ ]] || { remote_fail bad_request "invalid suffix"; return 1; }
  run -- docker run --rm -v "$APOLLO_ROOT/docker:/d" "$HANDOVER_IMAGE" sh -c \
    "for x in postgresql-app postgresql-keycloak; do [ -d /d/\$x ] && mv /d/\$x /d/\$x.$suffix; done; true" >/dev/null ||
    { remote_fail finalize_failed "renaming the old database dirs failed"; return 1; }
  printf '{"renamed_suffix":%s}' "$(json_escape "$suffix")"
}
