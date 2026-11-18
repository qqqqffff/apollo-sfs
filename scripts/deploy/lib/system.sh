# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/system.sh — host preparation (WS1): preflight + dependencies, the node's
# name, docker's daemon.json, the avahi advertisement other nodes discover,
# drivetemp, tmpfiles. Contract: docs/node_provisioning.md.
# ─────────────────────────────────────────────────────────────────────────────

# Packages every node needs. (The manager step installs manager extras.)
#   parted → partprobe; gdisk → sgdisk; attr → setfattr/getfattr (mergerfs
#   runtime branch control); iputils-ping → the collector's ping sample.
SYSTEM_COMMON_PKGS=(python3 curl ca-certificates mergerfs fuse3 xfsprogs gdisk parted
                    smartmontools avahi-daemon avahi-utils attr util-linux iputils-ping)
SYSTEM_HOSTNAME_RE='^[a-z0-9]([a-z0-9-]{0,39}[a-z0-9])?$'
SYSTEM_TMPFILES_PATH="/etc/tmpfiles.d/apollo-sfs.conf"
SYSTEM_AVAHI_PATH="/etc/avahi/services/apollo-sfs.service"

# _system_pkg_installed PKG — rc 0 if dpkg reports it installed.
_system_pkg_installed() {
  local st
  st="$(probe "dpkg-$(probe_key "$1")" -- dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)"
  [[ "$st" == *"install ok installed"* ]]
}

# system_missing_packages PKG… — print the ones that are not installed.
system_missing_packages() {
  local p
  for p in "$@"; do _system_pkg_installed "$p" || printf '%s\n' "$p"; done
}

# system_install_packages PKG… — apt-get install (asks first). rc 0/1.
system_install_packages() {
  (($#)) || return 0
  log_info "Missing packages: $*"
  ask_yn "Install them now with apt-get?" y || { STEP_FAIL_REASON="required packages are missing: $*"; return 1; }
  run -- env DEBIAN_FRONTEND=noninteractive apt-get update -q || return 1
  run -- env DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" || return 1
  return 0
}

# system_docker_installed — rc 0 if the docker CLI + daemon are usable.
system_docker_installed() {
  probe docker-version -- docker version --format '{{.Server.Version}}' >/dev/null 2>&1
}

# system_tmpfiles_ensure — /run/apollo-sfs (0775 root:docker) for shared locks.
system_tmpfiles_ensure() {
  write_file "$SYSTEM_TMPFILES_PATH" 0644 root:root <"$APOLLO_ROOT/scripts/node-status/apollo-sfs.tmpfiles" || return 1
  if [[ $WRITE_CHANGED == 1 ]] || [[ ! -d /run/apollo-sfs ]]; then
    run -- systemd-tmpfiles --create "$SYSTEM_TMPFILES_PATH" || return 1
  fi
  return 0
}

# _system_os_info — print "arch|os|kernel".
_system_os_info() {
  local arch os kernel
  arch="$(probe uname-m -- uname -m 2>/dev/null || echo unknown)"
  kernel="$(probe uname-r -- uname -r 2>/dev/null || echo unknown)"
  os="$(probe os-release -- cat /etc/os-release 2>/dev/null | sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | head -n1)"
  printf '%s|%s|%s' "$arch" "${os:-unknown}" "$kernel"
}

# deploy_step_preflight — STEP (deploy + update): network facts, dependencies,
# docker, fuse user_allow_other, docker group, tmpfiles.
deploy_step_preflight() {
  local iface ip cidr
  iface="$(net_default_iface)"
  ip="$(net_lan_ip "$iface")"
  cidr="$(net_lan_cidr "$iface")"
  if [[ -z "$iface" || -z "$ip" ]]; then
    STEP_FAIL_REASON="no default route / LAN IPv4 found — connect the node to the LAN first"
    return 1
  fi
  state_set lan_iface "$iface"; state_set lan_ip "$ip"; state_set lan_cidr "$cidr"
  local info arch os kernel
  info="$(_system_os_info)"; IFS='|' read -r arch os kernel <<<"$info"
  ui_kv "network" "$iface  $ip  ($cidr)"
  ui_kv "system" "$os · $arch · kernel $kernel"
  ui_kv "repo owner" "$REPO_OWNER ($APOLLO_ROOT)"

  local -a missing=()
  mapfile -t missing < <(system_missing_packages "${SYSTEM_COMMON_PKGS[@]}")
  if ((${#missing[@]})); then
    system_install_packages "${missing[@]}" || return 1
  else
    log_ok "Required packages are installed."
  fi

  if system_docker_installed; then
    log_ok "Docker $(probe docker-version -- docker version --format '{{.Server.Version}}' 2>/dev/null) is running."
  else
    log_info "Docker is not installed (or the daemon is down)."
    if ask_yn "Install Docker Engine with the official convenience script (get.docker.com)?" y; then
      run -- sh -c 'curl -fsSL https://get.docker.com | sh' || { STEP_FAIL_REASON="Docker installation failed"; return 1; }
      run -- systemctl enable --now docker || return 1
    else
      STEP_FAIL_REASON="Docker is required"; return 1
    fi
  fi

  # mergerfs pools are mounted with allow_other so the MinIO container user can read them.
  local fuse; fuse="$(read_file /etc/fuse.conf 2>/dev/null || true)"
  if ! grep -qE '^[[:space:]]*user_allow_other' <<<"$fuse"; then
    if grep -qE '^[[:space:]]*#[[:space:]]*user_allow_other' <<<"$fuse"; then
      sed -E 's/^[[:space:]]*#[[:space:]]*user_allow_other/user_allow_other/' <<<"$fuse" | write_file /etc/fuse.conf 0644 root:root || return 1
    else
      { [[ -n "$fuse" ]] && printf '%s\n' "$fuse"; echo "user_allow_other"; } | write_file /etc/fuse.conf 0644 root:root || return 1
    fi
  fi

  # The repo owner runs `_remote` ops over ssh — it needs the docker group (and
  # it already has root-equivalent docker access on this node by design).
  if [[ "$REPO_OWNER" != root ]]; then
    local groups; groups="$(probe "id-groups-$(probe_key "$REPO_OWNER")" -- id -nG "$REPO_OWNER" 2>/dev/null || true)"
    if [[ " $groups " != *" docker "* ]]; then
      run -- usermod -aG docker "$REPO_OWNER" || return 1
      log_info "$REPO_OWNER was added to the docker group (takes effect on the next login)."
    fi
  fi

  system_tmpfiles_ensure || return 1

  local pyok; pyok="$(probe python-version -- python3 -c 'import sys; print(int(sys.version_info >= (3, 9)))' 2>/dev/null || echo 0)"
  [[ "$pyok" == 1 ]] || { STEP_FAIL_REASON="python3 >= 3.9 is required"; return 1; }

  printf '{"node":{"arch":%s,"os":%s,"kernel":%s,"ip":%s,"cidr":%s,"iface":%s}}' \
    "$(json_escape "$arch")" "$(json_escape "$os")" "$(json_escape "$kernel")" \
    "$(json_escape "$ip")" "$(json_escape "$cidr")" "$(json_escape "$iface")" | node_json_merge deployment >/dev/null || return 1
  return 0
}

# _system_validate_hostname NAME — format + uniqueness among discovered nodes.
_system_validate_hostname() {
  local n="$1"
  if ! [[ "$n" =~ $SYSTEM_HOSTNAME_RE ]]; then
    log_warn "Use 1–41 lower-case letters, digits and '-' (not starting/ending with '-')."
    return 1
  fi
  local others; others="$(state_get _identity_other_names "")"
  if [[ " $others " == *" $n "* ]]; then
    log_warn "'$n' is already used by another node on this network."
    return 1
  fi
  return 0
}

# _system_in_swarm — rc 0 if this node's docker is part of an active swarm.
_system_in_swarm() {
  local st; st="$(probe docker-swarm-state -- docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || true)"
  [[ "$st" == active ]]
}

# deploy_step_identity — STEP: name this system (hostname). Default keeps the
# current name; a rename inside a swarm needs a docker restart (Docker reads
# the hostname only at start-up), so the user confirms that first.
deploy_step_identity() {
  local current recorded def name=""
  current="$(this_hostname)"
  recorded="$(node_json_get deployment.node.name "" 2>/dev/null)"
  def="${recorded:-$current}"
  [[ "$def" =~ $SYSTEM_HOSTNAME_RE ]] || def="$current"

  # Names already taken by other nodes (discovery is WS3a's; optional here).
  local others=""
  if declare -F cluster_discover >/dev/null; then
    cluster_discover >/dev/null 2>&1 || true   # current shell: caches for the membership step
    local disc; disc="$(state_get discovery_json "")"
    if [[ -n "$disc" ]]; then
      others="$(printf '%s' "$disc" | python3 -I -c '
import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
me = sys.argv[1]
print(" ".join(sorted({n.get("hostname") for n in d.get("nodes", []) if n.get("hostname") and n.get("hostname") != me})))' "$current" 2>/dev/null || true)"
    fi
  fi
  state_set _identity_other_names "$others"
  [[ -n "$others" ]] && ui_kv "other nodes" "$others"

  ask name "System name for this node" --default "$def" --validate _system_validate_hostname \
    --hint "Becomes the hostname, the Swarm node name and the name on the metrics page."

  if [[ "$name" == "$current" ]]; then
    state_set node_name "$name"
    printf '{"node":{"name":%s}}' "$(json_escape "$name")" | node_json_merge deployment >/dev/null || return 1
    return 0
  fi

  local in_swarm=0 role
  _system_in_swarm && in_swarm=1
  if [[ $in_swarm == 1 ]]; then
    role="$(probe docker-swarm-control -- docker info --format '{{.Swarm.ControlAvailable}}' 2>/dev/null || true)"
    log_warn "This node is in a swarm. Swarm only picks up a new hostname after Docker restarts,"
    if [[ "$role" == true ]]; then
      log_warn "and this is the MANAGER: every service will be briefly down while Docker restarts."
    else
      log_warn "which restarts every container on this node."
    fi
    if ! ask_yn "Rename '$current' → '$name' and restart Docker now?" n; then
      log_info "Keeping the current name '$current'."
      state_set node_name "$current"
      printf '{"node":{"name":%s}}' "$(json_escape "$current")" | node_json_merge deployment >/dev/null || return 1
      return 0
    fi
  fi

  run -- hostnamectl set-hostname "$name" || { STEP_FAIL_REASON="hostnamectl failed"; return 1; }
  local hosts; hosts="$(read_file /etc/hosts 2>/dev/null || true)"
  if grep -qE '^127\.0\.1\.1[[:space:]]' <<<"$hosts"; then
    sed -E "s/^127\.0\.1\.1[[:space:]].*/127.0.1.1\t$name/" <<<"$hosts" | write_file /etc/hosts 0644 root:root || return 1
  else
    { printf '%s\n' "$hosts"; printf '127.0.1.1\t%s\n' "$name"; } | write_file /etc/hosts 0644 root:root || return 1
  fi
  if [[ -d /etc/cloud ]]; then
    printf '# Written by deploy.sh — keep the hostname set by `deploy.sh deploy`.\npreserve_hostname: true\n' |
      write_file /etc/cloud/cloud.cfg.d/99-apollo-sfs.cfg 0644 root:root || return 1
  fi
  if [[ $in_swarm == 1 ]]; then
    run -- systemctl restart docker || { STEP_FAIL_REASON="docker restart failed"; return 1; }
    if ! is_test && [[ "$role" == true ]]; then
      local i seen=""
      for i in $(seq 1 30); do
        seen="$(docker node inspect self --format '{{.Description.Hostname}}' 2>/dev/null || true)"
        [[ "$seen" == "$name" ]] && break
        sleep 2
      done
      [[ "$seen" == "$name" ]] || log_warn "Swarm still reports '$seen' for this node — check 'docker node ls'."
    fi
  fi

  local prev; prev="$(node_json_get deployment.node.previous_names '[]' 2>/dev/null)"
  prev="$(python3 -I -c 'import json,sys; p=json.loads(sys.argv[1] or "[]"); c=sys.argv[2]; n=sys.argv[3]
p=[x for x in p if x != n]
if c not in p: p.append(c)
print(json.dumps(p))' "$prev" "$current" "$name")"
  state_set node_name "$name"
  state_set previous_names "$prev"
  printf '{"node":{"name":%s,"previous_names":%s}}' "$(json_escape "$name")" "$prev" | node_json_merge deployment >/dev/null || return 1
  log_ok "This node is now '$name' (previously '$current')."
  return 0
}

# system_daemon_json_ensure_cidr CIDR — trust CIDR as insecure registries so
# the registry can move with the manager. Keeps every other daemon.json key.
system_daemon_json_ensure_cidr() {
  local cidr="$1"
  [[ -n "$cidr" ]] || { log_warn "no LAN CIDR known — skipping daemon.json"; return 0; }
  local current merged
  current="$(read_file /etc/docker/daemon.json 2>/dev/null || true)"
  [[ -n "${current//[[:space:]]/}" ]] || current="{}"
  if ! merged="$(printf '%s' "$current" | python3 -I -c '
import json, sys
cidr = sys.argv[1]
d = json.load(sys.stdin)
if not isinstance(d, dict):
    raise SystemExit("daemon.json is not a JSON object")
regs = d.get("insecure-registries") or []
if cidr not in regs:
    regs.append(cidr)
d["insecure-registries"] = regs
print(json.dumps(d, indent=2))' "$cidr" 2>&1)"; then
    alert_ack warn daemon-json-invalid "/etc/docker/daemon.json could not be parsed" \
      "deploy.sh did not change it. Fix the JSON by hand, then run ./deploy.sh update.
Parser said: $merged"
    return 1
  fi
  if [[ "$merged" == "$(printf '%s' "$current" | python3 -I -c 'import json,sys; print(json.dumps(json.load(sys.stdin), indent=2))' 2>/dev/null)" ]]; then
    log_ok "daemon.json already trusts $cidr for insecure registries."
    return 0
  fi
  # A key that is ALSO passed as a dockerd flag makes dockerd refuse to start.
  local unit; unit="$(probe docker-unit -- systemctl cat docker.service 2>/dev/null || true)"
  if grep -q -- '--insecure-registry' <<<"$unit"; then
    alert_ack warn daemon-json-flag-conflict "docker.service already passes --insecure-registry" \
      "Adding insecure-registries to daemon.json as well would stop dockerd from starting.
Move the flag's value into /etc/docker/daemon.json by hand, then run ./deploy.sh update."
    return 1
  fi
  local tmp; tmp="$(mktemp "${TMPDIR:-/tmp}/apollo-daemon.XXXXXX.json")"
  printf '%s\n' "$merged" >"$tmp"
  if cmd_exists dockerd || [[ -n "$FIXTURES" ]]; then
    if ! probe dockerd-validate -- dockerd --validate --config-file "$tmp" >/dev/null 2>&1; then
      rm -f "$tmp"
      STEP_FAIL_REASON="dockerd --validate rejected the merged daemon.json"
      return 1
    fi
  fi
  rm -f "$tmp"
  printf '%s\n' "$merged" | write_file /etc/docker/daemon.json 0644 root:root || return 1
  # insecure-registries is one of dockerd's live-reloadable options (SIGHUP),
  # so a reload applies it without restarting any container.
  run -- systemctl reload docker || return 1
  if ! is_test; then
    local seen; seen="$(docker info --format '{{json .RegistryConfig.InsecureRegistryCIDRs}}' 2>/dev/null || true)"
    [[ "$seen" == *"$cidr"* ]] || log_warn "docker info does not list $cidr yet — check: docker info | grep -A3 Insecure"
  fi
  log_ok "Registries in $cidr are trusted (daemon.json, reloaded live)."
  return 0
}

_system_xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; s="${s//\"/&quot;}"; s="${s//\'/&apos;}"
  printf '%s' "$s"
}

# system_avahi_advertise — (re)write the _apollo-sfs._tcp advertisement.
system_avahi_advertise() {
  if ! _system_pkg_installed avahi-daemon; then
    log_warn "avahi-daemon is not installed — other nodes will not discover this one automatically."
    return 0
  fi
  local server node role swarm
  server="$(state_get server_name "$(node_json_get deployment.cluster.server_name "" 2>/dev/null)")"
  node="$(node_name)"
  role="$(node_role)"
  swarm="$(state_get swarm_id "$(node_json_get deployment.cluster.swarm_id "" 2>/dev/null)")"
  swarm="${swarm:0:12}"
  sed -e "s|@SERVER@|$(_system_xml_escape "${server:-unnamed}")|g" \
      -e "s|@NODE@|$(_system_xml_escape "$node")|g" \
      -e "s|@ROLE@|$(_system_xml_escape "${role:-unknown}")|g" \
      -e "s|@SWARM@|$(_system_xml_escape "${swarm:-none}")|g" \
      -e "s|@REPO@|$(_system_xml_escape "$APOLLO_ROOT")|g" \
      -e "s|@PROTO@|$PROTO|g" "$APOLLO_ROOT/scripts/deploy/templates/avahi-apollo-sfs.service" |
    write_file "$SYSTEM_AVAHI_PATH" 0644 root:root || return 1
  # avahi-daemon watches /etc/avahi/services and reloads changed files itself.
  return 0
}

# system_drivetemp_ensure — load drivetemp now and at boot (SATA temperatures).
system_drivetemp_ensure() {
  if ! probe drivetemp-loaded -- test -d /sys/module/drivetemp >/dev/null 2>&1; then
    run -- modprobe drivetemp || log_warn "could not load drivetemp — HDD temperatures will be missing"
  fi
  printf 'drivetemp\n' | write_file /etc/modules-load.d/drivetemp.conf 0644 root:root || return 1
  return 0
}

# drift_system — update drift lines.
drift_system() {
  local m
  m="$(system_missing_packages "${SYSTEM_COMMON_PKGS[@]}" | tr '\n' ' ')"
  if [[ -n "${m// /}" ]]; then echo "warn|system|missing packages: $m"; else echo "ok|system|packages present"; fi
  system_docker_installed || echo "crit|system|docker is not running"
  [[ -f "$SYSTEM_TMPFILES_PATH" ]] || echo "warn|system|$SYSTEM_TMPFILES_PATH missing"
  local recorded; recorded="$(node_json_get deployment.node.name "" 2>/dev/null)"
  [[ -z "$recorded" || "$recorded" == "$(this_hostname)" ]] || echo "warn|system|hostname is $(this_hostname) but node.json records $recorded"
  _system_pkg_installed avahi-daemon && [[ ! -f "$SYSTEM_AVAHI_PATH" ]] && echo "warn|system|avahi advertisement missing"
  if [[ "$REPO_OWNER" != root ]]; then
    local groups; groups="$(probe "id-groups-$(probe_key "$REPO_OWNER")" -- id -nG "$REPO_OWNER" 2>/dev/null || true)"
    [[ " $groups " == *" docker "* ]] || echo "warn|system|$REPO_OWNER is not in the docker group"
  fi
  return 0
}
