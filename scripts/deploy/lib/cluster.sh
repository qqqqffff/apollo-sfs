# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/cluster.sh — discovery, ssh to the manager, swarm membership, and the
# cluster-level `_remote` ops (WS3a).
#
# Discovery sources, in order:
#   1. `docker info` — is this node already in a swarm, and where is its manager?
#   2. avahi/mDNS `_apollo-sfs._tcp` — every node deploy.sh has provisioned
#      advertises server/node/role/swarm/repo/proto (validated before use: it is
#      unauthenticated network input).
#   3. a TCP 2377 sweep of the local /24 — swarm managers that don't advertise
#      yet (e.g. a manager not yet adopted by deploy.sh 2.0).
#   4. a manual "manager IP" prompt.
# A manager is only trusted once TCP 2377 answers AND its `_remote info` works
# (the avahi `role` can be stale after a demotion).
# ─────────────────────────────────────────────────────────────────────────────

CLUSTER_LABELS_FILE="$CLUSTER_DIR/labels.json"
CLUSTER_DEFAULT_SERVER="apollo-sfs"
CLUSTER_SERVER_RE='^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$'

# ── discovery ────────────────────────────────────────────────────────────────
# _cluster_swarm_json — docker's own view ("{}" when docker is unavailable).
_cluster_swarm_json() {
  local j; j="$(probe docker-swarm-json -- docker info --format '{{json .Swarm}}' 2>/dev/null || true)"
  [[ -n "$j" && "$j" == "{"* ]] || j="{}"
  printf '%s' "$j"
}

# _cluster_tcp_open HOST PORT — rc 0 if a TCP connect succeeds within 1 s.
_cluster_tcp_open() {
  probe "tcp-$(probe_key "$1")-$2" -- timeout 1 bash -c "</dev/tcp/$1/$2" >/dev/null 2>&1
}

# _cluster_scan_2377_raw PREFIX SELF — print IPs in PREFIX.1-254 with 2377 open.
_cluster_scan_2377_raw() {
  local prefix="$1" self="$2"
  seq 1 254 | xargs -P 64 -I{} bash -c "[ '$prefix.{}' = '$self' ] && exit 0; timeout 0.5 bash -c '</dev/tcp/$prefix.{}/2377' 2>/dev/null && echo '$prefix.{}'" 2>/dev/null | sort -t. -k4 -n
}

# cluster_discover — JSON {"self":{…},"nodes":[{hostname, addr, role, server,
# swarm, repo, proto, source}],"managers":[addr…]}; cached for the run.
cluster_discover() {
  # Cached for the run. NOTE: call it in the current shell (not inside $(…))
  # at least once, otherwise the cache is set in a subshell and lost.
  local cached; cached="$(state_get discovery_json "")"
  [[ -n "$cached" ]] && { printf '%s' "$cached"; return 0; }
  local sw avahi="" scan="" ip; sw="$(_cluster_swarm_json)"
  ip="$(state_get lan_ip "$(net_lan_ip 2>/dev/null)")"
  avahi="$(probe avahi-browse -- timeout 10 avahi-browse -rpt _apollo-sfs._tcp 2>/dev/null || true)"
  local have_mgr
  have_mgr="$(printf '%s' "$avahi" | grep -c ';role=manager\|"role=manager"' || true)"
  if [[ "$have_mgr" == 0 && "$(printf '%s' "$sw" | json_get LocalNodeState inactive)" != active && -n "$ip" ]]; then
    log_detail "no advertised manager — probing ${ip%.*}.0/24 for swarm managers (TCP 2377)…"
    scan="$(probe "scan-2377-$(probe_key "${ip%.*}")" -- _cluster_scan_2377_raw "${ip%.*}" "$ip" 2>/dev/null || true)"
  fi
  local out
  out="$(python3 -I -c '
import json, re, sys
sw = json.loads(sys.argv[1] or "{}")
avahi, scan, self_ip = sys.argv[2], sys.argv[3], sys.argv[4]
HOST = re.compile(r"^[a-z0-9-]{1,63}$"); REPO = re.compile(r"^/[A-Za-z0-9._/-]+$")
SERVER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$"); PROTO = re.compile(r"^[0-9]{1,4}$")
IP = re.compile(r"^[0-9]{1,3}(\.[0-9]{1,3}){3}$")
nodes, seen = [], set()
for line in avahi.splitlines():
    if not line.startswith("=;"):
        continue
    f = line.split(";")
    if len(f) < 10 or f[2] != "IPv4":
        continue
    addr = f[7]
    if not IP.match(addr) or addr in seen:
        continue
    txt = dict(t.split("=", 1) for t in re.findall(r"\"([^\"]*)\"", ";".join(f[9:])) if "=" in t)
    n = {"hostname": txt.get("node") if HOST.match(txt.get("node", "")) else None,
         "addr": addr,
         "role": txt.get("role") if txt.get("role") in ("manager", "worker") else None,
         "server": txt.get("server") if SERVER.match(txt.get("server", "")) else None,
         "swarm": txt.get("swarm") if re.match(r"^[A-Za-z0-9]{1,64}$", txt.get("swarm", "")) else None,
         "repo": txt.get("repo") if REPO.match(txt.get("repo", "")) else None,
         "proto": int(txt["proto"]) if PROTO.match(txt.get("proto", "")) else None,
         "source": "avahi"}
    if addr == self_ip:
        continue
    seen.add(addr); nodes.append(n)
for rm in sw.get("RemoteManagers") or []:
    addr = (rm.get("Addr") or "").split(":")[0]
    if IP.match(addr) and addr != self_ip and addr not in seen:
        seen.add(addr); nodes.append({"hostname": None, "addr": addr, "role": "manager", "server": None,
                                      "swarm": None, "repo": None, "proto": None, "source": "docker"})
for addr in scan.split():
    if IP.match(addr) and addr not in seen:
        seen.add(addr); nodes.append({"hostname": None, "addr": addr, "role": "manager", "server": None,
                                      "swarm": None, "repo": None, "proto": None, "source": "scan"})
print(json.dumps({"self": {"state": sw.get("LocalNodeState") or "inactive", "control": bool(sw.get("ControlAvailable")),
                           "node_id": sw.get("NodeID"), "addr": sw.get("NodeAddr"),
                           "cluster_id": (sw.get("Cluster") or {}).get("ID")},
                  "nodes": nodes,
                  "managers": [n["addr"] for n in nodes if n["role"] == "manager"]}))
' "$sw" "$avahi" "$scan" "$ip")" || out='{"self":{},"nodes":[],"managers":[]}'
  state_set discovery_json "$out"
  printf '%s' "$out"
}

_cluster_show_discovery() {
  local d="$1" rows
  rows="$(printf '%s' "$d" | python3 -I -c '
import json, sys
for n in json.load(sys.stdin)["nodes"]:
    print("%s|%s|%s|%s|%s" % (n.get("hostname") or "?", n["addr"], n.get("role") or "?", n.get("server") or "?", n["source"]))')"
  if [[ -z "$rows" ]]; then log_info "No other Apollo SFS nodes were found on this network."; return 0; fi
  local -a t=("NODE|ADDRESS|ROLE|SERVER|FOUND VIA")
  while IFS= read -r r; do t+=("$r"); done <<<"$rows"
  ui_table "${t[@]}"
}

# ── ssh to the manager ───────────────────────────────────────────────────────
_cluster_owner_home() { getent passwd "$REPO_OWNER" | cut -d: -f6; }

# _cluster_ssh_setup HOST [REPO] — key-based ssh as the repo owner, with the
# host key confirmed by fingerprint. Leaves MGR_* set and a master running.
_cluster_ssh_setup() {
  local host="$1" repo="${2:-}"
  MGR_HOST="$host"
  log_info "This node needs ssh access to the manager ($host). Next you choose the manager's"
  log_info "login USER NAME (not a password) — a password is only asked afterwards, once, to install this node's key."
  ask MGR_USER "Login user name on the manager ($host)" --default "${MGR_USER:-$REPO_OWNER}" \
    --validate _cluster_validate_user
  MGR_REPO="${repo:-${MGR_REPO:-$APOLLO_ROOT}}"
  ssh_prepare
  if mgr_reachable; then ssh_master_start || true; log_ok "ssh to $MGR_USER@$host works."; return 0; fi

  local home key kh
  home="$(_cluster_owner_home)"; key="$home/.ssh/id_ed25519"
  kh="$home/.ssh/known_hosts"; is_test && kh="$SSH_CTL_DIR/known_hosts"
  if ssh_hostkey_changed; then
    log_warn "The manager's ssh host key differs from the one saved for $host (reinstalled or replaced machine?)."
    if ask_yn "Delete the saved fingerprint and verify the new one?" y; then ssh_hostkey_reset; fi
  fi
  if ! probe "ssh-pubkey-$(probe_key "$REPO_OWNER")" -- test -f "$key.pub" >/dev/null 2>&1; then
    log_info "Creating an ssh key for $REPO_OWNER ($key)…"
    run_as_owner -- ssh-keygen -t ed25519 -N '' -C "apollo-sfs@$(node_name)" -f "$key" || return 1
  fi
  if ! probe "ssh-known-$(probe_key "$host")" -- ssh-keygen -F "$host" -f "$kh" >/dev/null 2>&1; then
    local scan fp
    scan="$(probe "ssh-keyscan-$(probe_key "$host")" -- ssh-keyscan -T 5 -t ed25519 "$host" 2>/dev/null || true)"
    [[ -n "$scan" ]] || { STEP_FAIL_REASON="ssh-keyscan got no host key from $host — is sshd running there?"; return 1; }
    fp="$(printf '%s\n' "$scan" | probe --stdin "ssh-fingerprint-$(probe_key "$host")" -- ssh-keygen -lf - 2>/dev/null || true)"
    log_info "The manager's ssh host key fingerprint is:"
    log_info "    ${fp:-unknown}"
    log_info "  (check on the manager: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub)"
    ask_yn "Trust this host key?" n || { STEP_FAIL_REASON="host key not trusted"; return 1; }
    if is_test; then
      printf '%s\n' "$scan" >>"$kh"      # sandbox known_hosts only
      log_test "would append the host key to $home/.ssh/known_hosts"
    else
      printf '%s\n' "$scan" | run_as_owner --stdin -- tee -a "$kh" >/dev/null || return 1
    fi
  fi
  local attempt
  for attempt in 1 2 3; do
    mgr_reachable && break
    if [[ $attempt == 1 ]]; then
      log_info "Installing this node's ssh key on the manager (ssh-copy-id; you'll be asked for $MGR_USER's password)…"
      run_as_owner -- ssh-copy-id -i "$key.pub" "$MGR_USER@$host" && continue
    fi
    is_test && { log_test "would retry ssh (no key installed in test mode)"; break; }
    log_warn "Key-based ssh to $MGR_USER@$host still fails (password logins may be disabled there)."
    log_info "Append this line to ~$MGR_USER/.ssh/authorized_keys on the manager, then press Enter:"
    printf '\n    %s\n\n' "$(cat "$key.pub" 2>/dev/null)" >&2
    ui_pause "Press Enter once the key is installed…"
  done
  if mgr_reachable; then ssh_master_start || true; log_ok "ssh to $MGR_USER@$host works."; return 0; fi
  if is_test; then log_test "ssh to the manager is not set up yet — remote steps are simulated"; return 0; fi
  STEP_FAIL_REASON="could not establish key-based ssh to $MGR_USER@$host (choose 'f' to delete the saved host key and try again)"
  STEP_FIX_FN=ssh_hostkey_reset; STEP_FIX_LABEL="delete the saved ssh host key and reconnect"
  return 1
}

_cluster_validate_user() { [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { log_warn "not a valid user name"; return 1; }; }
_cluster_validate_server() {
  [[ "$1" =~ $CLUSTER_SERVER_RE ]] || { log_warn "Use 1–64 letters, digits, space, '.', '_' or '-'."; return 1; }
}
_cluster_validate_ip() {
  [[ -z "$1" || "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { log_warn "Enter an IPv4 address (or leave empty)."; return 1; }
}

# _cluster_load_info — `mgr info` → run-state. rc 0 / 1 / 6 / 255.
_cluster_load_info() {
  local rc=0
  mgr info --quiet || rc=$?
  [[ $rc -eq 0 ]] || return $rc
  state_set server_name "$(mgr_data server_name "$(state_get server_name "")")"
  state_set manager_hostname "$(mgr_data swarm.manager.hostname "")"
  state_set stack_running "$([[ "$(mgr_data stack_running false)" == true ]] && echo 1 || echo 0)"
  state_set mgr_registry "$(mgr_data registry "")"
  state_set mgr_tiers "$(mgr_data tiers '{}')"
  local their mine
  their="$(mgr_data repo.commit "")"; mine="$(git -C "$APOLLO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  state_set mgr_commit "$their"
  if [[ -n "$their" && -n "$mine" && "$their" != "$mine" ]]; then
    log_warn "The manager's repo is at $their, this node's at $mine — keep them on the same commit."
  fi
  return 0
}

# ── membership paths ─────────────────────────────────────────────────────────
_cluster_set_labels_self() {   # on a manager: apollo-manager + apollo-server
  local server="$1" self cur
  self="$(node_name)"
  cur="$(probe docker-node-labels-self -- docker node inspect self --format '{{json .Spec.Labels}}' 2>/dev/null || echo '{}')"
  [[ -n "$cur" && "$cur" != null ]] || cur='{}'
  local -a args=()
  local others; others="$(probe docker-nodes-apollo-manager -- docker node ls --filter node.label=apollo-manager=true --format '{{.Hostname}}' 2>/dev/null || true)"
  if [[ "$(printf '%s' "$cur" | json_get apollo-manager "")" != true ]]; then
    if [[ -z "$others" ]]; then args+=(--label-add apollo-manager=true)
    else log_warn "apollo-manager=true is already on: $others (left unchanged — a handover moves it)"; fi
  fi
  [[ "$(printf '%s' "$cur" | json_get apollo-server "")" == "$server" ]] || args+=(--label-add "apollo-server=$server")
  ((${#args[@]})) || return 0
  run -- docker node update "${args[@]}" "$self" >/dev/null
}

_cluster_record() {   # merge deployment.cluster from run-state
  local role="$1" registry
  registry="$(state_get mgr_registry "")"
  [[ -n "$registry" ]] || registry="$(state_get manager_host "$(state_get lan_ip "")"):5000"
  printf '{"cluster":{"server_name":%s,"role":%s,"swarm_node_id":%s,"swarm_id":%s,"manager":{"hostname":%s,"addr":%s},"ssh_user":%s,"repo_path":%s,"registry":%s}}' \
    "$(json_escape "$(state_get server_name "")")" "$(json_escape "$role")" \
    "$(json_escape "$(state_get swarm_node_id "")")" "$(json_escape "$(state_get swarm_id "")")" \
    "$(json_escape "$(state_get manager_hostname "")")" "$(json_escape "$(state_get manager_host ""):2377")" \
    "$(json_escape "${MGR_USER:-$REPO_OWNER}")" "$(json_escape "${MGR_REPO:-$APOLLO_ROOT}")" \
    "$(json_escape "$registry")" | node_json_merge deployment >/dev/null
}

# _cluster_as_manager_existing — this node already manages a swarm (adoption).
_cluster_as_manager_existing() {
  local d="$1" sw srv def
  sw="$(printf '%s' "$d" | json_get self '{}')"
  log_ok "This node already manages swarm $(printf '%s' "$sw" | json_get cluster_id '?' | cut -c1-12)."
  local nodes; nodes="$(probe docker-node-ls -- docker node ls --format '{{.Hostname}}|{{.Status}}|{{.Availability}}|{{.ManagerStatus}}' 2>/dev/null || true)"
  if [[ -n "$nodes" ]]; then
    local -a t=("NODE|STATUS|AVAILABILITY|MANAGER")
    while IFS='|' read -r h s a m; do [[ -n "$h" ]] && t+=("$h|$s|$a|${m:--}"); done <<<"$nodes"
    ui_table "${t[@]}"
  fi
  srv="$(probe docker-node-label-server -- docker node inspect self --format '{{index .Spec.Labels "apollo-server"}}' 2>/dev/null || true)"
  [[ "$srv" == "<no value>" ]] && srv=""
  def="${srv:-$(node_json_get deployment.cluster.server_name "$CLUSTER_DEFAULT_SERVER")}"
  local name; ask name "Server name (this cluster)" --default "$def" --validate _cluster_validate_server
  state_set server_name "$name"
  state_set role manager
  state_set swarm_node_id "$(printf '%s' "$sw" | json_get node_id "")"
  state_set swarm_id "$(printf '%s' "$sw" | json_get cluster_id "")"
  state_set manager_host "$(state_get lan_ip "$(printf '%s' "$sw" | json_get addr "")")"
  state_set manager_hostname "$(node_name)"
  state_set stack_running "$(_stack_running && echo 1 || echo 0)"
  _cluster_set_labels_self "$name" || return 1
  return 0
}

# _cluster_init_new — no manager found: initialise a new server here.
_cluster_init_new() {
  log_info "No Apollo SFS manager was found — this node will initialise a new server and become its manager."
  local name; ask name "Name for the new server" --default "$CLUSTER_DEFAULT_SERVER" --validate _cluster_validate_server
  local ip; ip="$(state_get lan_ip "")"
  [[ -n "$ip" ]] || { STEP_FAIL_REASON="no LAN IP known (preflight)"; return 1; }
  run -- docker swarm init --advertise-addr "$ip" >/dev/null || { STEP_FAIL_REASON="docker swarm init failed"; return 1; }
  local nid cid
  if is_test; then nid="planned-node-id"; cid="planned-swarm-id"
  else
    nid="$(docker info --format '{{.Swarm.NodeID}}' 2>/dev/null)"
    cid="$(docker info --format '{{.Swarm.Cluster.ID}}' 2>/dev/null)"
  fi
  run -- docker node update --label-add apollo-manager=true --label-add "apollo-server=$name" "${nid}" >/dev/null || return 1
  state_set server_name "$name"; state_set role manager; state_set fresh_cluster 1
  state_set swarm_node_id "$nid"; state_set swarm_id "$cid"
  state_set manager_host "$ip"; state_set manager_hostname "$(node_name)"; state_set stack_running 0
  log_ok "Initialised server \"$name\" with this node as its manager ($ip)."
  return 0
}

# _cluster_join_worker HOST — join the manager's swarm as a worker.
_cluster_join_worker() {
  local host="$1" rc=0 tok addr f
  f="$(mktemp "${TMPDIR:-/tmp}/apollo-jt.XXXXXX")"; printf '{"role":"worker"}' >"$f"
  mgr join-token --in "$f" || rc=$?
  rm -f "$f"
  if [[ $rc -ne 0 ]]; then
    is_test || { STEP_FAIL_REASON="could not get a join token from the manager"; return 1; }
    tok="SWMTKN-test-token"; addr="$host:2377"
  else
    tok="$(mgr_data token "")"; addr="$(mgr_data addr "$host:2377")"
  fi
  redact_add "$tok"
  local ip; ip="$(state_get lan_ip "")"
  run --redact "$tok" -- docker swarm join --advertise-addr "$ip" --token "$tok" "$addr" >/dev/null ||
    { STEP_FAIL_REASON="docker swarm join failed"; return 1; }
  state_set role worker
  if is_test; then state_set swarm_node_id planned-node-id
  else state_set swarm_node_id "$(docker info --format '{{.Swarm.NodeID}}' 2>/dev/null)"; fi
  state_set swarm_id "$(mgr_data swarm.id "")"
  log_ok "Joined server \"$(state_get server_name "?")\" as a worker."
  return 0
}

# _cluster_with_manager HOST REPO — confirm, ssh, info, then worker or takeover.
_cluster_with_manager() {
  local host="$1" repo="$2" srv="$3" mname="$4"
  log_info "Found server \"${srv:-unnamed}\" managed by ${mname:-?} ($host)."
  ask_yn "Join this server?" y || return 3
  _cluster_ssh_setup "$host" "$repo" || return 1
  local rc=0; _cluster_load_info || rc=$?
  if [[ $rc -eq 6 ]]; then STEP_FAIL_REASON="the manager runs an incompatible deploy.sh (protocol mismatch) — update it first"; return 1; fi
  if [[ $rc -ne 0 ]] && ! is_test; then STEP_FAIL_REASON="the manager's deploy.sh did not answer (run ./deploy.sh deploy on the manager first)"; return 1; fi
  [[ -n "$(state_get server_name "")" ]] || state_set server_name "${srv:-$CLUSTER_DEFAULT_SERVER}"
  [[ -n "$(state_get manager_hostname "")" ]] || state_set manager_hostname "$mname"
  state_set manager_host "$host"
  local how
  select_one how "Join \"$(state_get server_name)\" as:" --default worker \
    worker="a worker (storage/compute node; the current manager stays manager)" \
    manager="the new MANAGER — replaces $(state_get manager_hostname "the current manager"), which becomes a worker (data is migrated)"
  if [[ "$how" == manager ]]; then
    local hrc=0; handover_run || hrc=$?
    case $hrc in
      0) return 0 ;;
      3) ask_yn "Join as a worker instead?" y || return 3 ;;
      *) return 1 ;;
    esac
  fi
  _cluster_join_worker "$host"
}

# deploy_step_membership — STEP.
deploy_step_membership() {
  cluster_discover >/dev/null   # in THIS shell, so the cache persists
  local d; d="$(state_get discovery_json "{}")"
  _cluster_show_discovery "$d"
  local st ctl
  st="$(printf '%s' "$d" | json_get self.state inactive)"
  ctl="$(printf '%s' "$d" | json_get self.control false)"
  local rc=0
  if [[ "$st" == active && "$ctl" == true ]]; then
    _cluster_as_manager_existing "$d" || rc=$?
  elif [[ "$st" == active ]]; then
    rc=0; _cluster_as_worker_existing "$d" || rc=$?
  else
    _cluster_not_in_swarm "$d" || rc=$?
  fi
  [[ $rc -eq 0 ]] || return "$rc"
  _cluster_record "$(state_get role)" || return 1
  system_avahi_advertise || log_warn "could not write the avahi advertisement"
  system_daemon_json_ensure_cidr "$(state_get lan_cidr "")" || log_warn "daemon.json was not updated (registry pulls may fail after a manager move)"
  return 0
}

# _cluster_as_worker_existing — already a worker: keep, take over, or leave.
_cluster_as_worker_existing() {
  local d="$1" mgr_addr
  mgr_addr="$(printf '%s' "$d" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(next((n["addr"] for n in d["nodes"] if n["source"]=="docker"), (d["managers"] or [""])[0]))')"
  local srv mname repo
  read -r srv mname repo < <(printf '%s' "$d" | python3 -I -c '
import json, sys
d = json.load(sys.stdin); a = sys.argv[1]
n = next((x for x in d["nodes"] if x["addr"] == a and x["source"] == "avahi"), {})
print((n.get("server") or "-").replace(" ", "_"), n.get("hostname") or "-", n.get("repo") or "-")' "$mgr_addr")
  [[ "$srv" == - ]] && srv=""; [[ "$mname" == - ]] && mname=""; [[ "$repo" == - ]] && repo=""
  srv="${srv//_/ }"
  log_info "This node is already a worker of the swarm managed at $mgr_addr${mname:+ ($mname)}."
  local how
  select_one how "Cluster membership:" --default keep \
    keep="keep — stay a worker of this server" \
    manager="take over as MANAGER (the current manager becomes a worker; data is migrated)" \
    leave="leave this swarm and join/initialise another one"
  case "$how" in
    keep)
      _cluster_ssh_setup "$mgr_addr" "$repo" || return 1
      _cluster_load_info || is_test || log_warn "the manager's deploy.sh did not answer — run ./deploy.sh deploy on the manager first"
      [[ -n "$(state_get server_name "")" ]] || state_set server_name "${srv:-$CLUSTER_DEFAULT_SERVER}"
      [[ -n "$(state_get manager_hostname "")" ]] || state_set manager_hostname "$mname"
      state_set manager_host "$mgr_addr"; state_set role worker
      state_set swarm_node_id "$(printf '%s' "$d" | json_get self.node_id "")"
      state_set swarm_id "$(printf '%s' "$d" | json_get self.cluster_id "")"
      return 0 ;;
    manager)
      _cluster_ssh_setup "$mgr_addr" "$repo" || return 1
      _cluster_load_info || { STEP_FAIL_REASON="the manager's deploy.sh must answer before a handover"; return 1; }
      state_set manager_host "$mgr_addr"
      state_set already_worker 1
      handover_run; return $? ;;
    leave)
      confirm_typed LEAVE "This node will leave its swarm; its containers stop until it joins again." || return 3
      run -- docker swarm leave >/dev/null || { STEP_FAIL_REASON="docker swarm leave failed"; return 1; }
      log_info "Left the swarm. (On the manager, remove the stale entry: docker node rm $(node_name))"
      state_unset discovery_json
      cluster_discover >/dev/null
      _cluster_not_in_swarm "$(state_get discovery_json "{}")"; return $? ;;
  esac
}

# _cluster_not_in_swarm — join a discovered manager or initialise a new server.
_cluster_not_in_swarm() {
  local d="$1" mgrs n
  mgrs="$(printf '%s' "$d" | python3 -I -c '
import json, sys
for n in json.load(sys.stdin)["nodes"]:
    if n.get("role") == "manager":
        print("%s|%s|%s|%s" % (n["addr"], n.get("hostname") or "", (n.get("server") or ""), n.get("repo") or ""))')"
  local -a confirmed=() line addr
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    addr="${line%%|*}"
    if _cluster_tcp_open "$addr" 2377; then confirmed+=("$line"); else log_detail "$addr advertises a manager but 2377 is closed (stale?)"; fi
  done <<<"$mgrs"
  if ((${#confirmed[@]} == 0)); then
    local manual
    ask manual "Manager IP to join (empty = initialise a NEW server on this node)" --allow-empty --validate _cluster_validate_ip
    if [[ -z "$manual" ]]; then _cluster_init_new; return $?; fi
    _cluster_tcp_open "$manual" 2377 || log_warn "$manual does not answer on TCP 2377 — trying anyway."
    confirmed=("$manual|||")
  fi
  local pick="${confirmed[0]}"
  if ((${#confirmed[@]} > 1)); then
    local -a opts=() i
    for i in "${!confirmed[@]}"; do
      IFS='|' read -r a h s _ <<<"${confirmed[$i]}"
      opts+=("$i=${s:-unnamed server} — manager ${h:-?} ($a)")
    done
    local idx; select_one idx "Several managers answered — which server?" "${opts[@]}"
    pick="${confirmed[$idx]}"
  fi
  local a h s r; IFS='|' read -r a h s r <<<"$pick"
  local rc=0; _cluster_with_manager "$a" "$r" "$s" "$h" || rc=$?
  if [[ $rc -eq 3 ]]; then
    ask_yn "Initialise a NEW, separate server on this node instead?" n || { STEP_FAIL_REASON="cancelled"; return 1; }
    _cluster_init_new; return $?
  fi
  return "$rc"
}

# _cluster_offer_demoted_cleanup — this node used to be the manager (a handover
# moved the role away): its nginx, fail2ban and registry serve nothing now.
_cluster_offer_demoted_cleanup() {
  log_info "This node was the manager and is now a worker — its nginx, fail2ban and image registry no longer serve anything."
  ask_yn "Stop and disable them (configuration and data are kept)?" y || return 0
  run -- systemctl disable --now nginx || true
  run -- systemctl disable --now fail2ban || true
  if [[ "$(probe registry-running -- docker inspect -f '{{.State.Running}}' registry 2>/dev/null)" == true ]]; then
    run -- docker update --restart=no registry >/dev/null || true
    run -- docker stop registry >/dev/null || true
  fi
  return 0
}

# update_step_membership — STEP (update): keep / take over / re-join, plus
# refreshing ssh, avahi and daemon.json.
update_step_membership() {
  local role; role="$(node_role)"
  cluster_discover >/dev/null   # in THIS shell, so the cache persists
  local d; d="$(state_get discovery_json "{}")"
  local st ctl
  st="$(printf '%s' "$d" | json_get self.state inactive)"; ctl="$(printf '%s' "$d" | json_get self.control false)"
  ui_kv "recorded" "$role of \"$(state_get server_name "?")\" (manager $(node_json_get deployment.cluster.manager.hostname "?"))"
  ui_kv "docker says" "swarm $st$([[ "$ctl" == true ]] && echo ', manager')"
  if [[ "$st" != active ]]; then
    alert_ack warn not-in-swarm "This node is not in a swarm any more" \
      "node.json records it as a $role, but docker reports swarm state '$st'.
The membership step will now run as in a fresh deploy (join or initialise)."
    deploy_step_membership; return $?
  fi
  if [[ "$ctl" == true && "$role" != manager ]] || [[ "$ctl" != true && "$role" == manager ]]; then
    log_warn "The recorded role ($role) differs from docker's view (manager=$ctl) — a handover happened elsewhere?"
  fi
  [[ "$ctl" != true && "$role" == manager ]] && _cluster_offer_demoted_cleanup
  if [[ "$ctl" == true ]]; then
    _cluster_as_manager_existing "$d" || return 1
  else
    _cluster_as_worker_existing "$d" || return $?
  fi
  _cluster_record "$(state_get role)" || return 1
  system_avahi_advertise || log_warn "could not refresh the avahi advertisement"
  system_daemon_json_ensure_cidr "$(state_get lan_cidr "$(node_json_get deployment.node.cidr "")")" || true
  return 0
}

# ── manager-side ops ─────────────────────────────────────────────────────────
remote_op_info() {
  local sw nodes svcs view tiers labels
  sw="$(_cluster_swarm_json)"
  nodes="$(probe docker-nodes-json -- sh -c "docker node ls -q | xargs -r docker node inspect --format '{{json .}}'" 2>/dev/null || true)"
  view="$(_stack_nodes_view)"
  tiers='{"fast":null,"standard":null}'
  if (( $(_stack_records_count "$view") > 0 )); then
    tiers="$(py stack tiers --nodes-dir "$view" 2>/dev/null || echo "$tiers")"
  else
    local fh sh
    fh="$(probe docker-svc-node-minio -- docker service ps "${STACK_NAME}_minio" --filter desired-state=running --format '{{.Node}}' 2>/dev/null | head -n1)"
    sh="$(probe docker-svc-node-minio-standard -- docker service ps "${STACK_NAME}_minio-standard" --filter desired-state=running --format '{{.Node}}' 2>/dev/null | head -n1)"
    tiers="{\"fast\":$([[ -n "$fh" ]] && json_escape "$fh" || echo null),\"standard\":$([[ -n "$sh" ]] && json_escape "$sh" || echo null)}"
  fi
  labels="$(read_file "$CLUSTER_LABELS_FILE" 2>/dev/null || echo '{}')"
  python3 -I -c '
import json, sys
sw = json.loads(sys.argv[1] or "{}")
nodes = []
for line in sys.argv[2].splitlines():
    try:
        n = json.loads(line)
    except ValueError:
        continue
    spec, st, mgr = n.get("Spec") or {}, n.get("Status") or {}, n.get("ManagerStatus") or {}
    nodes.append({"hostname": (n.get("Description") or {}).get("Hostname"), "id": n.get("ID"),
                  "role": spec.get("Role"), "state": st.get("State"), "availability": spec.get("Availability"),
                  "addr": st.get("Addr"), "labels": spec.get("Labels") or {}, "reachability": mgr.get("Reachability"),
                  "leader": bool(mgr.get("Leader"))})
me = next((n for n in nodes if n["id"] == sw.get("NodeID")), {})
server = next((n["labels"].get("apollo-server") for n in nodes if n["labels"].get("apollo-server")), None) or sys.argv[6] or None
taken = set(json.loads(sys.argv[4] or "{}").keys())
print(json.dumps({
  "proto_min": int(sys.argv[7]), "proto_max": int(sys.argv[8]), "script_version": sys.argv[9],
  "server_name": server,
  "swarm": {"id": (sw.get("Cluster") or {}).get("ID"),
            "manager": {"hostname": me.get("hostname"), "addr": (sw.get("NodeAddr") or "") + ":2377", "node_id": sw.get("NodeID")}},
  "repo": {"path": sys.argv[10], "commit": sys.argv[11], "dirty": sys.argv[12] == "1"},
  "registry": sys.argv[5] or ((sw.get("NodeAddr") or "") + ":5000"),
  "nodes": nodes, "tiers": json.loads(sys.argv[3]), "labels_taken": sorted(taken),
  "stack_running": sys.argv[13] == "1"}))
' "$sw" "$nodes" "$tiers" "$labels" "$(node_json_get deployment.cluster.registry "" 2>/dev/null)" \
    "$(node_json_get deployment.cluster.server_name "" 2>/dev/null)" "$PROTO_MIN" "$PROTO" "$SCRIPT_VERSION" \
    "$APOLLO_ROOT" "$(git -C "$APOLLO_ROOT" rev-parse --short HEAD 2>/dev/null || true)" \
    "$([[ -n "$(git -C "$APOLLO_ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ]] && echo 1 || echo 0)" \
    "$(_stack_running && echo 1 || echo 0)"
}

remote_op_join_token() {
  local role; role="$(remote_req role worker)"
  [[ "$role" == worker || "$role" == manager ]] || { remote_fail bad_request "role must be worker or manager"; return 1; }
  local tok addr
  tok="$(probe "docker-join-token-$role" -- docker swarm join-token -q "$role" 2>/dev/null || true)"
  [[ -n "$tok" ]] || { remote_fail no_token "could not read the $role join token (is this the manager?)"; return 1; }
  addr="$(probe docker-node-addr -- docker info --format '{{.Swarm.NodeAddr}}' 2>/dev/null || true)"
  printf '{"token":%s,"addr":%s}' "$(json_escape "$tok")" "$(json_escape "${addr}:2377")"
}

# remote_op_reserve_labels — allocate cluster-unique drive labels <class>-NN.
remote_op_reserve_labels() { with_lock cluster:labels --wait 60 -- _cluster_reserve_locked; }
_cluster_reserve_locked() {
  local host classes current view out
  host="$(remote_req hostname "")"
  [[ "$host" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || { remote_fail bad_request "invalid hostname"; return 1; }
  classes="$(remote_req classes '[]')"
  current="$(read_file "$CLUSTER_LABELS_FILE" 2>/dev/null || echo '{}')"
  view="$(_stack_nodes_view)"
  out="$(python3 -I -c '
import glob, json, os, re, sys
host, classes, current, view = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3] or "{}"), sys.argv[4]
used = {}
for f in glob.glob(os.path.join(view, "*.json")):
    try:
        r = json.load(open(f))
    except ValueError:
        continue
    for m in r.get("disk_mounts") or []:
        used[m["label"]] = r.get("hostname")
for lab, h in current.items():
    used.setdefault(lab, h)
mine_consumed = {m for m, h in used.items() if h == host and m in {x["label"] for f in glob.glob(os.path.join(view, host + ".json")) for x in (json.load(open(f)).get("disk_mounts") or [])}}
spare = sorted(l for l, h in current.items() if h == host and l not in mine_consumed)
out = []
for cls in classes:
    if cls not in ("nvme", "ssd", "hdd"):
        raise SystemExit("bad class %r" % cls)
    reuse = next((l for l in spare if l.startswith(cls + "-") and l not in out), None)
    if reuse:
        out.append(reuse); continue
    n = 1
    while "%s-%02d" % (cls, n) in used or "%s-%02d" % (cls, n) in out:
        n += 1
    lab = "%s-%02d" % (cls, n)
    out.append(lab); current[lab] = host; used[lab] = host
print(json.dumps({"labels": out, "registry": current}))
' "$host" "$classes" "$current" "$view")" || { remote_fail bad_request "could not allocate labels"; return 1; }
  ensure_dir "$CLUSTER_DIR" 0755 "$REPO_OWNER" >/dev/null || true
  printf '%s' "$out" | json_get registry | write_file "$CLUSTER_LABELS_FILE" 0644 "$REPO_OWNER" >/dev/null || return 1
  printf '{"labels":%s}' "$(printf '%s' "$out" | json_get labels)"
}

remote_op_scale() {
  local spec; spec="$(remote_req services '{}')"
  local pairs; pairs="$(printf '%s' "$spec" | python3 -I -c '
import json, re, sys
for k, v in (json.load(sys.stdin) or {}).items():
    if re.match(r"^[a-z0-9][a-z0-9-]*$", k) and isinstance(v, int) and 0 <= v <= 10:
        print(k, v)')"
  [[ -n "$pairs" ]] || { remote_fail bad_request "services must map stack service names to replica counts"; return 1; }
  local out="[" first=1 name want have
  while read -r name want; do
    have="$(probe "docker-svc-replicas-$name" -- docker service inspect "${STACK_NAME}_$name" --format '{{.Spec.Mode.Replicated.Replicas}}' 2>/dev/null || true)"
    [[ -n "$have" ]] || { log_warn "service ${STACK_NAME}_$name not found — skipped"; continue; }
    if [[ "$have" != "$want" ]]; then
      run -- docker service scale --detach=false "${STACK_NAME}_$name=$want" >/dev/null || { remote_fail scale_failed "scaling $name failed"; return 1; }
    fi
    [[ $first == 1 ]] || out+=","; first=0
    out+="{\"service\":$(json_escape "$name"),\"from\":${have:-null},\"to\":$want}"
  done <<<"$pairs"
  printf '{"scaled":%s]}' "$out"
}

remote_op_promote() {
  local host; host="$(remote_req hostname "")"
  [[ "$host" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || { remote_fail bad_request "invalid hostname"; return 1; }
  run -- docker node promote "$host" >/dev/null || { remote_fail promote_failed "docker node promote $host failed"; return 1; }
  local state=planned i
  if ! is_test; then
    for i in $(seq 1 30); do
      state="$(docker node inspect "$host" --format '{{.ManagerStatus.Reachability}}' 2>/dev/null || true)"
      [[ "$state" == reachable ]] && break
      sleep 2
    done
    [[ "$state" == reachable ]] || { remote_fail promote_timeout "$host did not become a reachable manager"; return 1; }
  fi
  printf '{"state":%s}' "$(json_escape "$state")"
}

# drift_cluster — update drift lines.
drift_cluster() {
  local sw st ctl role
  sw="$(_cluster_swarm_json)"
  st="$(printf '%s' "$sw" | json_get LocalNodeState inactive)"
  ctl="$(printf '%s' "$sw" | json_get ControlAvailable false)"
  role="$(node_role)"
  [[ "$st" == active ]] || { echo "crit|cluster|not in a swarm (docker reports '$st')"; return 0; }
  if [[ "$role" == manager && "$ctl" != true ]]; then echo "warn|cluster|recorded as manager but docker says worker"
  elif [[ "$role" == worker && "$ctl" == true ]]; then echo "warn|cluster|recorded as worker but docker says manager"
  else echo "ok|cluster|$role, swarm active"; fi
  [[ -f /etc/avahi/services/apollo-sfs.service ]] || echo "warn|cluster|avahi advertisement missing"
  if [[ "$role" == worker ]]; then
    remote_context_load
    if [[ -n "$FIXTURES" ]] || mgr_reachable; then echo "ok|cluster|manager reachable over ssh"
    else echo "crit|cluster|manager ${MGR_HOST:-?} unreachable over ssh"; fi
  fi
  local cidr; cidr="$(node_json_get deployment.node.cidr "" 2>/dev/null)"
  if [[ -n "$cidr" ]] && ! read_file /etc/docker/daemon.json 2>/dev/null | grep -qF "$cidr"; then
    echo "warn|cluster|daemon.json does not trust $cidr for registries"
  fi
  return 0
}
