# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/stack.sh — node registry, the generated per-node stack file, stack
# deploys, and DB node registration (WS3b).
#
# The stack is two files (see the docker-stack.yml header):
#   docker-stack.yml                 committed; manager-level services
#   cluster/docker-stack.nodes.yml   generated here from cluster/nodes/*.json
# cluster/ lives on the MANAGER, is gitignored and owned by the repo owner so
# `_remote` ops (running as the ssh user, no sudo) can update it.
# ─────────────────────────────────────────────────────────────────────────────

STACK_NODES_DIR="$CLUSTER_DIR/nodes"
STACK_TAG_VARS=(API_TAG FRONTEND_TAG NODE_AGENT_TAG NODE_METRICS_INGEST_TAG RECOGNITION_TAG TEST_RUNNER_TAG)
STACK_LEGACY_SERVICES=(minio minio-standard node-agent-standard node-agent-fast)
STACK_DISK_STATS_FALLBACK="/srv/apollo-sfs/disk-stats"
STACK_NODES_ONLY=0

# ── small helpers ────────────────────────────────────────────────────────────
_stack_running() {
  local s; s="$(probe docker-stack-services -- docker stack services "$STACK_NAME" --format '{{.Name}}' 2>/dev/null || true)"
  [[ -n "$s" ]]
}

# _stack_nodes_view — a directory holding the node records as THIS run sees
# them: the real cluster/nodes, overlaid (in --test) with records an earlier
# step "wrote" into the sandbox. Prints the path.
_stack_nodes_view() {
  if ! is_test; then mkdir -p "$STACK_NODES_DIR" 2>/dev/null || true; printf '%s' "$STACK_NODES_DIR"; return 0; fi
  local v="$TEST_SANDBOX/nodes-view"
  rm -rf "$v"; mkdir -p "$v"
  if [[ -n "$FIXTURES" ]]; then
    [[ -d "$FIXTURES/cluster-nodes" ]] && cp "$FIXTURES/cluster-nodes/"*.json "$v/" 2>/dev/null
  elif [[ -d "$STACK_NODES_DIR" ]]; then
    cp "$STACK_NODES_DIR/"*.json "$v/" 2>/dev/null
  fi
  [[ -d "$TEST_SANDBOX/fs$STACK_NODES_DIR" ]] && cp "$TEST_SANDBOX/fs$STACK_NODES_DIR/"*.json "$v/" 2>/dev/null
  printf '%s' "$v"
}

# _stack_records_count VIEW — number of node records.
_stack_records_count() { find "$1" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l; }

# _stack_write_record JSON — persist one node record (atomic, backed up).
_stack_write_record() {
  local json="$1" host
  host="$(printf '%s' "$json" | json_get hostname)" || return 1
  [[ "$host" =~ ^[a-z0-9-]+$ ]] || { log_error "refusing record with hostname '$host'"; return 1; }
  ensure_dir "$CLUSTER_DIR" 0755 "$REPO_OWNER" || return 1
  ensure_dir "$STACK_NODES_DIR" 0755 "$REPO_OWNER" || return 1
  printf '%s\n' "$json" | write_file "$STACK_NODES_DIR/$host.json" 0644 "$REPO_OWNER" || return 1
}

# _stack_node_tiers — "hostname tier role" for every swarm node.
_stack_node_tiers() {
  probe docker-node-tiers -- sh -c "docker node ls -q | xargs -r docker node inspect --format '{{.Description.Hostname}} {{index .Spec.Labels \"tier\"}} {{.Spec.Role}}'" 2>/dev/null
}

# stack_seed_if_needed — first adoption: seed records for the legacy per-node
# services (keeping their names + tier constraints) so nothing restarts.
stack_seed_if_needed() {
  local view; view="$(_stack_nodes_view)"
  (( $(_stack_records_count "$view") > 0 )) && return 0
  local svcs; svcs="$(probe docker-service-names -- docker service ls --format '{{.Name}}' 2>/dev/null || true)"
  local legacy_present=0 s
  for s in "${STACK_LEGACY_SERVICES[@]}"; do grep -qx "${STACK_NAME}_$s" <<<"$svcs" && legacy_present=1; done
  [[ $legacy_present == 1 ]] || return 0
  local fast_host="" std_host="" h t r
  while read -r h t r; do
    [[ "$t" == fast && -z "$fast_host" ]] && fast_host="$h"
    [[ "$t" == standard && -z "$std_host" ]] && std_host="$h"
  done < <(_stack_node_tiers)
  log_info "First adoption: recording the existing per-node services (${STACK_LEGACY_SERVICES[*]}) as they are — no restarts."
  local seeds n i
  seeds="$(py stack legacy-seeds ${fast_host:+--fast-host "$fast_host"} ${std_host:+--standard-host "$std_host"})" || return 1
  n="$(printf '%s' "$seeds" | python3 -I -c 'import json,sys; print(len(json.load(sys.stdin)))')"
  for (( i = 0; i < n; i++ )); do
    _stack_write_record "$(printf '%s' "$seeds" | json_get "$i")" || return 1
  done
  return 0
}

# stack_render — render cluster/docker-stack.nodes.yml from the records.
# Sets STACK_RENDER_CHANGED. rc 1 on invalid records.
STACK_RENDER_CHANGED=0
stack_render() {
  local view out
  view="$(_stack_nodes_view)"
  if (( $(_stack_records_count "$view") == 0 )); then
    out="$(sed -n '/^services:/,$p' "$APOLLO_ROOT/scripts/deploy/templates/legacy-node-services.yml")"
    out="$out"$'\n\n'"networks:"$'\n'"  app-network:"$'\n'"    driver: overlay"$'\n'"    attachable: true"
  else
    out="$(py stack render --nodes-dir "$view")" || { log_error "node records are invalid (see above)"; return 1; }
  fi
  ensure_dir "$CLUSTER_DIR" 0755 "$REPO_OWNER" || return 1
  printf '%s\n' "$out" | write_file "$NODES_STACK_FILE" 0644 "$REPO_OWNER" || return 1
  STACK_RENDER_CHANGED=$WRITE_CHANGED
  return 0
}

# _stack_nodes_file_for_use — path holding the CURRENT render (sandbox in --test).
_stack_nodes_file_for_use() {
  if is_test && [[ -f "$TEST_SANDBOX/fs$NODES_STACK_FILE" ]]; then printf '%s' "$TEST_SANDBOX/fs$NODES_STACK_FILE"
  else printf '%s' "$NODES_STACK_FILE"; fi
}

# ── DB (psql in the local db-app container) ──────────────────────────────────
_stack_db_container() {
  probe docker-db-app-id -- docker ps -qf "name=${STACK_NAME}_db-app" 2>/dev/null | head -n1
}

# stack_db_query SQL [k=v]… — read-only query with psql variables (use :'k'
# in SQL); prints rows (-At). STACK_QUERY_KEY names the probe fixture.
stack_db_query() {
  local sql="$1"; shift
  local cid; cid="$(_stack_db_container)"
  [[ -n "$cid" ]] || return 3
  local -a vars=()
  while [[ $# -gt 0 ]]; do vars+=(-v "$1"); shift; done
  printf '%s\n' "$sql" | probe --stdin "psql-${STACK_QUERY_KEY:-$(probe_key "${sql:0:40}")}" -- docker exec -i "$cid" \
    psql -X -At -q -v ON_ERROR_STOP=1 -U "${POSTGRES_APP_USER:-postgres}" -d "${POSTGRES_APP_DB:-postgres}" "${vars[@]}" -f -
}
# _stack_db_read SQL [KEY] — read-only query without variables (-c).
_stack_db_read() {
  local sql="$1" key="${2:-}"
  local cid; cid="$(_stack_db_container)"
  [[ -n "$cid" ]] || return 3
  probe "psql-${key:-$(probe_key "${sql:0:40}")}" -- docker exec "$cid" \
    psql -X -At -v ON_ERROR_STOP=1 -U "${POSTGRES_APP_USER:-postgres}" -d "${POSTGRES_APP_DB:-postgres}" -c "$sql"
}

# _stack_db_register HOST ROLE ADDR PREV_CSV SERVER_NAME — upsert the nodes row
# (mirrors api/db/nodes.go UpsertNode, but never touches minio_endpoint, which
# the admin sync owns) and name the server. Values travel as psql variables
# (:'name' quoting) — never interpolated into the SQL text.
_stack_db_register() {
  local host="$1" role="$2" addr="$3" prev="$4" server="$5"
  local cid; cid="$(_stack_db_container)"
  if [[ -z "$cid" ]]; then
    log_warn "db-app is not running on this manager — skipping DB registration (metrics from $host are dropped until it is)."
    printf '{"registered":false,"reason":"db-app not running"}'
    return 0
  fi
  local nserv; nserv="$(_stack_db_read "SELECT count(*) FROM servers WHERE is_active" servers-count 2>/dev/null || echo 0)"
  if [[ "${nserv//[^0-9]/}" == 0 || -z "${nserv//[^0-9]/}" ]]; then
    log_warn "No server row in the app DB yet (the API creates LOCAL-0001 on first boot) — skipping node registration."
    printf '{"registered":false,"reason":"no server row"}'
    return 0
  fi
  local sql
  read -r -d '' sql <<'SQL' || true
UPDATE nodes SET hostname = :'host'
 WHERE server_id = (SELECT id FROM servers WHERE is_active ORDER BY created_at LIMIT 1)
   AND hostname = ANY (string_to_array(:'prev', ','))
   AND NOT EXISTS (SELECT 1 FROM nodes n2 WHERE n2.hostname = :'host'
                     AND n2.server_id = (SELECT id FROM servers WHERE is_active ORDER BY created_at LIMIT 1));
INSERT INTO nodes (server_id, hostname, role, address, is_active)
SELECT id, :'host', :'role', :'addr', true FROM servers WHERE is_active ORDER BY created_at LIMIT 1
ON CONFLICT (server_id, hostname) DO UPDATE SET role = EXCLUDED.role, address = EXCLUDED.address, is_active = true;
UPDATE servers SET name = :'server'
 WHERE id = (SELECT id FROM servers WHERE is_active ORDER BY created_at LIMIT 1) AND :'server' <> '';
SQL
  printf '%s\n' "$sql" | run --stdin -- docker exec -i "$cid" psql -X -q -v ON_ERROR_STOP=1 \
    -U "${POSTGRES_APP_USER:-postgres}" -d "${POSTGRES_APP_DB:-postgres}" \
    -v "host=$host" -v "role=$role" -v "addr=$addr" -v "prev=$prev" -v "server=$server" -f - >/dev/null || {
      log_error "DB registration of $host failed"; printf '{"registered":false,"reason":"psql failed"}'; return 0; }
  printf '{"registered":true}'
}

# ── labels ───────────────────────────────────────────────────────────────────
# _stack_apply_labels HOST TIER ROLE ROLES_CSV — tier=<tier>, one
# apollo-role-<role>=true label per enabled role (others removed),
# apollo-manager=true when ROLE is manager. Prints a JSON object of labels.
_stack_apply_labels() {
  local host="$1" tier="$2" role="$3" roles="$4"
  local cur; cur="$(probe "docker-node-labels-$(probe_key "$host")" -- docker node inspect "$host" --format '{{json .Spec.Labels}}' 2>/dev/null || echo '{}')"
  [[ -n "$cur" && "$cur" != null ]] || cur='{}'
  local -a args=()
  local want=() k
  [[ -n "$tier" ]] && want+=("tier=$tier")
  [[ "$role" == manager ]] && want+=("apollo-manager=true")
  local r
  for r in postgres_shard blob_storage_shard database_backup blob_storage_redundancy; do
    k="apollo-role-${r//_/-}"
    if [[ ",$roles," == *",$r,"* ]]; then want+=("$k=true")
    elif [[ "$(printf '%s' "$cur" | json_get "$k" "")" != "" ]]; then args+=(--label-rm "$k"); fi
  done
  local kv
  for kv in "${want[@]+"${want[@]}"}"; do
    [[ "$(printf '%s' "$cur" | json_get "${kv%%=*}" "")" == "${kv#*=}" ]] || args+=(--label-add "$kv")
  done
  if ((${#args[@]})); then run -- docker node update "${args[@]}" "$host" >/dev/null || return 1; fi
  local out="{" first=1
  for kv in "${want[@]+"${want[@]}"}"; do
    [[ $first == 1 ]] || out+=","; first=0
    out+="$(json_escape "${kv%%=*}"):$(json_escape "${kv#*=}")"
  done
  printf '%s}' "$out"
}

# ── preflight + deploy ───────────────────────────────────────────────────────
# _stack_export_env — everything docker-stack*.yml interpolates.
_stack_export_env() {
  manager_env_load || { log_error ".env is missing on the manager ($DOTENV_FILE)"; return 1; }
  REGISTRY="${REGISTRY_OVERRIDE:-$(manager_registry_addr)}"; export REGISTRY
  local src="" label="" drives
  drives="$(node_json_get deployment.drives '[]' 2>/dev/null)"
  read -r src label < <(printf '%s' "$drives" | python3 -I -c '
import json, sys
try:
    ds = [d for d in json.load(sys.stdin) if isinstance(d, dict) and d.get("mountpoint")]
except ValueError:
    ds = []
pick = next((d for d in ds if d.get("tier") == "standard"), ds[0] if ds else None)
print((pick["mountpoint"] + " " + pick["label"]) if pick else "")' 2>/dev/null)
  if [[ -z "$src" ]]; then
    # Legacy manager without a node.json drive list: keep today's mount if it
    # exists here, else a placeholder dir so the api task can still schedule.
    if probe disk-stats-legacy -- test -d /srv/minio/hdd-01 >/dev/null 2>&1; then src=/srv/minio/hdd-01; label=hdd-01
    else src="$STACK_DISK_STATS_FALLBACK"; label=none; ensure_dir "$src" 0755 root:root || return 1; fi
  fi
  export APOLLO_DISK_STATS_SOURCE="$src" APOLLO_DISK_STATS_LABEL="$label"
  local v missing=()
  for v in "${STACK_TAG_VARS[@]}"; do [[ -n "${!v:-}" ]] || missing+=("$v"); done
  if ((${#missing[@]})); then
    release_resolve_tags >/dev/null || true
    missing=()
    for v in "${STACK_TAG_VARS[@]}"; do [[ -n "${!v:-}" ]] || missing+=("$v"); done
    if ((${#missing[@]})); then
      log_error "No image tag known for: ${missing[*]} — build them first: ./deploy.sh release --services …"
      return 1
    fi
  fi
  return 0
}

# _stack_manager_bind_sources — host paths the manager-level services mount.
_stack_manager_bind_sources() {
  sed -n 's/^[[:space:]]*- \(\${[A-Z_]*:-[^}]*}\|\/[^:]*\):\/.*/\1/p' "$STACK_FILE" | while IFS= read -r p; do
    if [[ "$p" == '${'* ]]; then
      local var="${p#\$\{}"; var="${var%%:-*}"
      printf '%s\n' "${!var:-${p#*:-}}" | sed 's/}$//'
    else
      printf '%s\n' "$p"
    fi
  done | sort -u
}

# _stack_unmigrated_constraints — manager-level services still placed by the
# pre-2.0 `node.labels.tier == standard` constraint (deploying moves them).
_stack_unmigrated_constraints() {
  local svc c
  for svc in frontend api keycloak postfix ddns db-app db-keycloak recognition test-runner node-metrics-ingest; do
    c="$(probe "docker-svc-constraints-$svc" -- docker service inspect "${STACK_NAME}_$svc" --format '{{json .Spec.TaskTemplate.Placement.Constraints}}' 2>/dev/null || true)"
    [[ "$c" == *"node.labels.tier"* ]] && printf '%s\n' "$svc"
  done
  return 0
}

# stack_preflight — checks before ANY stack deploy. Sets STACK_NODES_ONLY=1
# when the user postpones the one-time constraint migration ("later").
stack_preflight() {
  STACK_NODES_ONLY=0
  local labelled managers
  labelled="$(probe docker-nodes-apollo-manager -- docker node ls --filter node.label=apollo-manager=true --format '{{.Hostname}}' 2>/dev/null || true)"
  managers="$(probe docker-nodes-managers -- docker node ls --filter role=manager --format '{{.Hostname}}' 2>/dev/null || true)"
  local nl; nl="$(grep -c . <<<"$labelled" || true)"
  if [[ "$nl" == 0 ]]; then
    if [[ "$(grep -c . <<<"$managers" || true)" == 1 ]]; then
      log_info "Labelling the swarm manager $(tr -d '\n' <<<"$managers") apollo-manager=true (manager-level services are pinned to it)."
      run -- docker node update --label-add apollo-manager=true "$(tr -d '\n' <<<"$managers")" >/dev/null || return 1
      labelled="$managers"
    else
      log_error "No node carries apollo-manager=true and there is not exactly one manager — label the manager first."
      return 1
    fi
  elif [[ "$nl" != 1 ]]; then
    log_error "More than one node carries apollo-manager=true ($(tr '\n' ' ' <<<"$labelled")) — keep it on exactly one."
    return 1
  fi
  if ! grep -qx "$(head -n1 <<<"$labelled")" <<<"$managers"; then
    log_error "$(head -n1 <<<"$labelled") carries apollo-manager=true but is not a swarm manager."
    return 1
  fi
  _stack_export_env || return 1
  local missing; missing="$(manager_env_missing_required | tr '\n' ' ')"
  if [[ -n "${missing// /}" ]]; then
    log_error "Required .env values are empty: $missing (run ./deploy.sh update on the manager)."
    return 1
  fi
  local p absent=()
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    probe "bind-source-$(probe_key "${p/#$APOLLO_ROOT/repo}")" -- test -e "$p" >/dev/null 2>&1 || absent+=("$p")
  done < <(_stack_manager_bind_sources)
  if ((${#absent[@]})); then
    log_error "Bind-mount sources missing on the manager (Swarm will not create them): ${absent[*]}"
    log_info "  ./deploy.sh update (manager infrastructure step) creates them."
    return 1
  fi
  [[ -f "$(_stack_nodes_file_for_use)" ]] || { stack_seed_if_needed && stack_render; } || return 1
  local -a unmigrated=()
  mapfile -t unmigrated < <(_stack_unmigrated_constraints)
  if ((${#unmigrated[@]})); then
    log_warn "One-time change: ${#unmigrated[@]} manager-level services move from 'node.labels.tier == standard'"
    log_warn "to 'node.labels.apollo-manager == true' — each restarts ONCE: ${unmigrated[*]}"
    if ! ask_yn "Apply that now? (no = later: deploy only the per-node services this time)" n; then
      STACK_NODES_ONLY=1
      log_info "Deferred — the next deploy (or ./deploy.sh release) will offer it again."
    fi
  fi
  return 0
}

# stack_deploy [--resolve-image always|changed|never] [--nodes-only]
# shellcheck disable=SC2120  # release.sh passes --resolve-image always
stack_deploy() {
  local mode=changed nodes_only="$STACK_NODES_ONLY"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --resolve-image) mode="$2"; shift 2 ;;
      --nodes-only) nodes_only=1; shift ;;
      *) log_error "stack_deploy: unknown option $1"; return 2 ;;
    esac
  done
  _stack_export_env || return 1
  local nodes_file; nodes_file="$(_stack_nodes_file_for_use)"
  [[ -f "$nodes_file" ]] || { stack_seed_if_needed && stack_render; nodes_file="$(_stack_nodes_file_for_use)"; }
  local -a files=()
  [[ $nodes_only == 1 ]] || files+=(-c "$STACK_FILE")
  files+=(-c "$nodes_file")
  if probe docker-stack-config-supported -- docker stack config --help >/dev/null 2>&1; then
    if ! probe docker-stack-config -- docker stack config "${files[@]}" >/dev/null 2>"${TMPDIR:-/tmp}/apollo-stack-config.$$"; then
      log_error "docker stack config rejected the stack files:"
      sed 's/^/    /' "${TMPDIR:-/tmp}/apollo-stack-config.$$" >&2
      rm -f "${TMPDIR:-/tmp}/apollo-stack-config.$$"
      return 1
    fi
    rm -f "${TMPDIR:-/tmp}/apollo-stack-config.$$"
  fi
  # Print the real paths (what runs on the device), not the --test sandbox copy.
  local -a shown=()
  [[ $nodes_only == 1 ]] || shown+=(-c "$STACK_FILE")
  shown+=(-c "$NODES_STACK_FILE")
  if is_test; then
    run -- docker stack deploy --resolve-image "$mode" "${shown[@]}" "$STACK_NAME"
  else
    run -- docker stack deploy --resolve-image "$mode" "${files[@]}" "$STACK_NAME" || return 1
  fi
  return 0
}

# stack_wait_converged [--timeout S] [SERVICE…] — replicas n/n and no
# rejected/failed current tasks (all stack services when none given).
stack_wait_converged() {
  local timeout=240
  [[ "${1:-}" == --timeout ]] && { timeout="$2"; shift 2; }
  local -a want=("$@")
  if is_test; then log_test "would wait for ${want[*]:-all stack services} to converge"; return 0; fi
  local deadline=$(( $(now_epoch) + timeout )) bad
  while (( $(now_epoch) <= deadline )); do
    bad="$(docker stack services "$STACK_NAME" --format '{{.Name}} {{.Replicas}}' 2>/dev/null | awk -v want=" ${want[*]} " '
      { split($2, r, "/"); n = $1; sub(/^[^_]*_/, "", n)
        if (want != "  " && index(want, " " n " ") == 0) next
        if (r[1] != r[2]) print $1 " " $2 }')"
    if [[ -z "$bad" ]]; then return 0; fi
    sleep 3
  done
  log_error "Services not converged after ${timeout}s:"
  printf '%s\n' "$bad" | sed 's/^/    /' >&2
  docker stack ps "$STACK_NAME" --no-trunc --filter desired-state=running --format '{{.Name}} {{.CurrentState}} {{.Error}}' 2>/dev/null |
    grep -iE 'rejected|failed|pending' | head -n 10 | sed 's/^/    /' >&2
  return 1
}

# ── registration (client + manager op) ───────────────────────────────────────
# _stack_build_request PHASE FILE — the register-node body from node.json.
_stack_build_request() {
  local phase="$1" f="$2" dep prev
  dep="$(node_json_get deployment '{}')"
  prev="$(state_get previous_names "$(node_json_get deployment.node.previous_names '[]')")"
  printf '{"hostname":%s,"previous_names":%s,"phase":%s,"deployment":%s}\n' \
    "$(json_escape "$(node_name)")" "${prev:-[]}" "$(json_escape "$phase")" "${dep:-{\}}" >"$f"
}

# stack_register_node PHASE — send this node's deployment to the manager.
stack_register_node() {
  local phase="${1:-full}" f rc=0
  f="$(mktemp "${TMPDIR:-/tmp}/apollo-register.XXXXXX")"
  _stack_build_request "$phase" "$f"
  cluster_call register-node --in "$f" || rc=$?
  rm -f "$f"
  [[ $rc -eq 0 ]] || return "$rc"
  local w; w="$(mgr_data warnings '[]')"
  [[ "$w" == "[]" ]] || printf '%s' "$w" | python3 -I -c 'import json,sys; [print(x) for x in json.load(sys.stdin)]' |
    while IFS= read -r line; do log_warn "$line"; done
  ui_kv "labels" "$(mgr_data labels '{}')"
  ui_kv "db" "$(mgr_data db '{}')"
  ui_kv "services" "$(mgr_data stack.node_services '[]')"
  printf '{"stack":{"services":%s,"registered_at":%s,"phase":%s}}' "$(mgr_data stack.node_services '[]')" \
    "$(json_escape "$(now_iso)")" "$(json_escape "$phase")" | node_json_merge deployment >/dev/null || true
  return 0
}

# remote_op_register_node — manager side of stack_register_node.
remote_op_register_node() { with_lock cluster:stack --wait 600 -- _stack_register_locked; }

_stack_register_locked() {
  local host phase reqf errf
  host="$(remote_req hostname "")"
  phase="$(remote_req phase full)"
  [[ "$host" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || { remote_fail bad_request "invalid hostname '$host'"; return 1; }
  [[ "$phase" == drives || "$phase" == full ]] || { remote_fail bad_request "invalid phase '$phase'"; return 1; }
  stack_seed_if_needed || { remote_fail seed_failed "could not seed the node registry"; return 1; }
  reqf="$(remote_req_to_file)"; errf="$(mktemp "${TMPDIR:-/tmp}/apollo-merge.XXXXXX")"
  local view rec
  view="$(_stack_nodes_view)"
  if ! rec="$(py stack merge-record --nodes-dir "$view" --hostname "$host" --request "$reqf" 2>"$errf")"; then
    local why; why="$(grep -v '^warning:' "$errf" | sed 's/^stack: //' | head -n3)"
    rm -f "$reqf" "$errf"
    remote_fail register_conflict "${why:-merge-record failed}"
    return 1
  fi
  local warnings; warnings="$(sed -n 's/^warning: //p' "$errf" | python3 -I -c 'import json,sys; print(json.dumps([l.rstrip("\n") for l in sys.stdin]))')"
  rm -f "$reqf" "$errf"
  _stack_write_record "$rec" || { remote_fail write_failed "could not write the node record"; return 1; }
  local renamed; renamed="$(printf '%s' "$rec" | json_get renamed_from "")"
  [[ -n "$renamed" && "$renamed" != "$host" && -f "$STACK_NODES_DIR/$renamed.json" ]] &&
    run -- mv "$STACK_NODES_DIR/$renamed.json" "$CLUSTER_DIR/.backups/$renamed.json.renamed-$(date +%s)" 2>/dev/null

  local tier role roles addr prev server
  tier="$(printf '%s' "$rec" | json_get tier "")"
  role="$(printf '%s' "$rec" | json_get role worker)"
  addr="$(printf '%s' "$rec" | json_get address "")"
  roles="$(remote_req deployment.roles '{}' | python3 -I -c 'import json,sys
try: r = json.load(sys.stdin)
except ValueError: r = {}
print(",".join(k for k, v in (r or {}).items() if isinstance(v, dict) and v.get("enabled")))')"
  prev="$(remote_req previous_names '[]' | python3 -I -c 'import json,sys; print(",".join(json.load(sys.stdin) or []))' 2>/dev/null)"
  server="$(remote_req deployment.cluster.server_name "")"
  [[ -n "$server" ]] || server="$(node_json_get deployment.cluster.server_name "" 2>/dev/null)"
  local labels db
  labels="$(_stack_apply_labels "$host" "$tier" "$role" "$roles")" || { remote_fail labels_failed "could not label $host"; return 1; }
  manager_env_load >/dev/null 2>&1 || true
  db="$(_stack_db_register "$host" "$role" "$addr" "$prev" "$server")"

  stack_render || { remote_fail render_failed "rendering the nodes file failed"; return 1; }
  local deployed=false
  if [[ $STACK_RENDER_CHANGED == 1 ]] || ! _stack_running || [[ "$(remote_req force_deploy false)" == true ]]; then
    if stack_preflight && stack_deploy; then
      deployed=true
      local svcs; svcs="$(py stack services --nodes-dir "$(_stack_nodes_view)" --hostname "$host" | tr -d '[]"' | tr ',' ' ')"
      # shellcheck disable=SC2086
      stack_wait_converged --timeout 240 $svcs || log_warn "the services for $host have not converged yet"
    else
      remote_fail deploy_failed "stack deploy failed (see the log above)"
      return 1
    fi
  else
    log_info "Node services unchanged — nothing to deploy."
  fi
  printf '{"hostname":%s,"labels":%s,"db":%s,"stack":{"deployed":%s,"nodes_file_changed":%s,"node_services":%s},"warnings":%s}' \
    "$(json_escape "$host")" "$labels" "$db" "$deployed" \
    "$([[ $STACK_RENDER_CHANGED == 1 ]] && echo true || echo false)" \
    "$(py stack services --nodes-dir "$(_stack_nodes_view)" --hostname "$host")" "${warnings:-[]}"
}

# ── the deploy step ──────────────────────────────────────────────────────────
# _stack_out_of_date — print "service deployed_tag" for custom images whose
# running tag differs from this checkout's short HEAD.
_stack_out_of_date() {
  local head; head="$(git -C "$APOLLO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  [[ -n "$head" ]] || return 0
  local svc img tag
  for svc in api frontend recognition test-runner node-metrics-ingest; do
    img="$(probe "docker-svc-image-$svc" -- docker service inspect "${STACK_NAME}_$svc" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null || true)"
    [[ -n "$img" ]] || continue
    img="${img%%@*}"; tag="${img##*:}"
    [[ "$tag" == "$head" ]] || printf '%s %s\n' "$svc" "$tag"
  done
}

# deploy_step_stack — STEP: register this node (deploying its services) and,
# on the manager, bootstrap a fresh server / finish a handover / offer a release.
deploy_step_stack() {
  if [[ "$(state_get handover 0)" == 1 ]]; then
    handover_finish; return $?
  fi
  local role; role="$(node_role)"
  if [[ "$role" == worker ]]; then
    local rc=0
    stack_register_node full || rc=$?
    case $rc in
      0) return 0 ;;
      255) STEP_FAIL_REASON="the manager is unreachable over ssh — its services for this node were not deployed"; return 1 ;;
      *) STEP_FAIL_REASON="the manager refused the registration (see above)"; return 1 ;;
    esac
  fi
  if [[ "$role" != manager ]]; then STEP_FAIL_REASON="this node's role is unknown (membership step failed?)"; return 1; fi

  local fresh=0
  [[ "$(state_get fresh_cluster 0)" == 1 ]] && fresh=1
  _stack_running || fresh=1
  if [[ $fresh == 1 ]]; then
    log_info "No apollo-sfs stack is running yet — bootstrapping a new server."
    if ! release_resolve_tags >/dev/null 2>&1; then
      log_info "Images have not been built for this registry yet."
      if ask_yn "Build and push all images now (./deploy.sh release — takes a while, arm64 via QEMU)?" y; then
        ( release_main --services frontend,api,node-agent,recognition,test-runner --yes --no-deploy ) || {
          STEP_FAIL_REASON="building/pushing the images failed"; return 1; }
      else
        STEP_FAIL_REASON="the stack can't start without images"; return 1
      fi
    fi
  fi
  local rc=0
  stack_register_node full || rc=$?
  [[ $rc -eq 0 ]] || { STEP_FAIL_REASON="deploying the stack failed (see above)"; return 1; }
  if [[ $fresh == 1 ]]; then
    manager_fresh_extras || { STEP_FAIL_REASON="post-bootstrap setup failed"; return 1; }
  fi
  local stale; stale="$(_stack_out_of_date)"
  if [[ -n "$stale" ]]; then
    log_info "Running images that differ from this checkout ($(git -C "$APOLLO_ROOT" rev-parse --short HEAD 2>/dev/null)):"
    printf '%s\n' "$stale" | sed 's/^/    /' >&2
    if ask_yn "Rebuild and redeploy them now with ./deploy.sh release?" n; then
      local list; list="$(awk '{print $1}' <<<"$stale" | sed 's/node-metrics-ingest/node-agent/' | sort -u | paste -sd, -)"
      ( release_main --services "$list" --yes ) || log_warn "release failed — run ./deploy.sh release later"
    fi
  fi
  return 0
}

# ── restart ──────────────────────────────────────────────────────────────────
STACK_RESTART_ORDER=(db-app db-keycloak minio minio-standard keycloak node-metrics-ingest api frontend)

# _stack_services_on_node HOST — stack services with a running task on HOST,
# in restart order (dependencies first, node-agents last).
_stack_services_on_node() {
  local host="$1" names
  names="$(probe "docker-node-ps-$(probe_key "$host")" -- docker node ps "$host" --filter desired-state=running --format '{{.Name}}' 2>/dev/null |
    sed -E 's/\.[0-9]+$//; s/\.[a-z0-9]{25}$//' | grep "^${STACK_NAME}_" | sed "s/^${STACK_NAME}_//" | sort -u)"
  local s
  for s in "${STACK_RESTART_ORDER[@]}"; do grep -qx "$s" <<<"$names" && printf '%s\n' "$s"; done
  grep -vxF -f <(printf '%s\n' "${STACK_RESTART_ORDER[@]}") <<<"$names" | grep -v '^node-agent' | grep . || true
  grep '^node-agent' <<<"$names" || true
}

# _stack_force_restart SERVICE… — force-update each, waiting for convergence.
_stack_force_restart() {
  local s failed=()
  for s in "$@"; do
    [[ -n "$s" ]] || continue
    log_info "Restarting ${STACK_NAME}_$s…"
    if run -- docker service update --force --detach=false --quiet "${STACK_NAME}_$s" >/dev/null; then
      log_ok "$s"
    else
      failed+=("$s")
    fi
  done
  ((${#failed[@]} == 0)) || { log_error "did not converge: ${failed[*]}"; return 1; }
  return 0
}

# restart_step_services — STEP (restart).
restart_step_services() {
  local role host; role="$(node_role)"; host="$(node_name)"
  if [[ "$role" == manager ]]; then
    manager_ensure_binfmt || log_warn "binfmt (arm64 builds) could not be ensured"
    manager_ensure_registry || log_warn "the registry container is not running"
    local -a svcs=()
    mapfile -t svcs < <(_stack_services_on_node "$host")
    if ((${#svcs[@]} == 0)); then
      STEP_FAIL_REASON="no apollo-sfs tasks are running on this manager — use ./deploy.sh update to redeploy"
      return 1
    fi
    ui_kv "services" "${svcs[*]}"
    _stack_force_restart "${svcs[@]}" || { STEP_FAIL_REASON="some services did not restart cleanly"; return 1; }
    return 0
  fi
  local f rc=0
  f="$(mktemp "${TMPDIR:-/tmp}/apollo-restart.XXXXXX")"
  printf '{"hostname":%s}' "$(json_escape "$host")" >"$f"
  cluster_call restart-node-services --in "$f" || rc=$?
  rm -f "$f"
  if [[ $rc -eq 0 ]]; then
    ui_kv "restarted" "$(mgr_data services '[]')"
    return 0
  fi
  if [[ $rc -eq 255 ]]; then
    log_warn "The manager is unreachable, so it can't restart this node's services."
    if ask_yn "Restart the local Docker daemon instead? (the swarm agent restarts this node's tasks)" y; then
      run -- systemctl restart docker || { STEP_FAIL_REASON="docker restart failed"; return 1; }
      alert_ack warn heartbeat-unreachable "Restarted locally — the manager could not be reached" \
        "Docker on this worker was restarted; its tasks come back from the swarm agent's local state.
The heartbeat with the manager could not be performed. Check the manager, then run ./deploy.sh restart again."
      return 0
    fi
  fi
  STEP_FAIL_REASON="the manager could not restart this node's services"
  return 1
}

# remote_op_restart_node_services — manager side: restart HOST's services.
remote_op_restart_node_services() {
  local host; host="$(remote_req hostname "")"
  [[ "$host" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || { remote_fail bad_request "invalid hostname"; return 1; }
  local -a svcs=()
  mapfile -t svcs < <(_stack_services_on_node "$host")
  local out="[" first=1 s ok
  for s in "${svcs[@]}"; do
    [[ -n "$s" ]] || continue
    ok=true
    run -- docker service update --force --detach=false --quiet "${STACK_NAME}_$s" >/dev/null || ok=false
    [[ $first == 1 ]] || out+=","; first=0
    out+="{\"name\":$(json_escape "$s"),\"ok\":$ok}"
  done
  printf '{"services":%s]}' "$out"
}

# drift_stack — update drift lines.
drift_stack() {
  [[ "$(node_role)" == manager ]] || return 0
  local view; view="$(_stack_nodes_view)"
  if (( $(_stack_records_count "$view") == 0 )); then
    echo "warn|stack|no node records yet (first adoption will seed them)"
  elif [[ -f "$NODES_STACK_FILE" ]]; then
    local fresh; fresh="$(py stack render --nodes-dir "$view" 2>/dev/null)"
    [[ "$fresh" == "$(cat "$NODES_STACK_FILE")" ]] || echo "warn|stack|cluster/docker-stack.nodes.yml is out of date with the node records"
  else
    echo "warn|stack|cluster/docker-stack.nodes.yml is missing"
  fi
  local -a unmig=(); mapfile -t unmig < <(_stack_unmigrated_constraints)
  ((${#unmig[@]})) && echo "warn|stack|${#unmig[@]} services still use the pre-2.0 tier constraint (one-time migration pending)"
  local stale; stale="$(_stack_out_of_date | awk '{print $1}' | paste -sd' ' -)"
  [[ -n "$stale" ]] && echo "info|stack|images differ from HEAD: $stale (./deploy.sh release)"
  return 0
}
