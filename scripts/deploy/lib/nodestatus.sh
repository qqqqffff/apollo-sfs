# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/nodestatus.sh — the apollo-node-status background service (WS1).
#
# The service (scripts/node-status/apollo_metrics.py via apollo_node.py
# `daemon`) rewrites node.json every 5 s with this node's metrics — the same
# numbers the admin metrics page shows — plus component status. deploy.sh's
# health checks and the manager heartbeat read that file.
#
# Root never executes code from the user-writable repo: the python modules are
# COPIED to /opt/apollo-sfs/node-status and the unit runs them from there.
# `update` reinstalls whenever the repo copy's hash differs (out of date).
# ─────────────────────────────────────────────────────────────────────────────

NODESTATUS_INSTALL_DIR="/opt/apollo-sfs/node-status"
NODESTATUS_UNIT="apollo-node-status.service"
NODESTATUS_UNIT_PATH="/etc/systemd/system/$NODESTATUS_UNIT"
NODESTATUS_SRC="$APOLLO_ROOT/scripts/node-status"
NODESTATUS_MODULES=(apollo_node.py apollo_metrics.py)

# _nodestatus_render_unit — the unit file with this repo's paths filled in.
# Always points at the REAL node.json (never the --test sandbox copy).
_nodestatus_render_unit() {
  sed -e "s|@INSTALL_DIR@|$NODESTATUS_INSTALL_DIR|g" \
      -e "s|@NODE_JSON@|$NODE_JSON_REAL|g" \
      -e "s|@REPO@|$APOLLO_ROOT|g" "$NODESTATUS_SRC/apollo-node-status.service"
}

# nodestatus_version — collector version from the repo copy.
nodestatus_version() {
  sed -n 's/^VERSION = "\(.*\)"$/\1/p' "$NODESTATUS_SRC/apollo_metrics.py" | head -n1
}

# nodestatus_repo_hash — sha256 of what an install from this repo would write.
nodestatus_repo_hash() {
  {
    local f
    for f in "${NODESTATUS_MODULES[@]}"; do cat "$NODESTATUS_SRC/$f"; done
    _nodestatus_render_unit
  } | sha256sum | cut -c1-64
}

# _nodestatus_installed_hash — sha256 of the installed copy (rc 1 if absent).
_nodestatus_installed_hash() {
  local f
  for f in "${NODESTATUS_MODULES[@]}"; do [[ -r "$NODESTATUS_INSTALL_DIR/$f" ]] || return 1; done
  [[ -r "$NODESTATUS_UNIT_PATH" ]] || return 1
  {
    for f in "${NODESTATUS_MODULES[@]}"; do cat "$NODESTATUS_INSTALL_DIR/$f"; done
    cat "$NODESTATUS_UNIT_PATH"
  } | sha256sum | cut -c1-64
}

# _nodestatus_install — copy modules, render unit, enable + (re)start.
_nodestatus_install() {
  local f changed=0
  system_tmpfiles_ensure || return 1
  ensure_dir "$NODESTATUS_INSTALL_DIR" 0755 root:root || return 1
  for f in "${NODESTATUS_MODULES[@]}"; do
    write_file "$NODESTATUS_INSTALL_DIR/$f" 0644 root:root <"$NODESTATUS_SRC/$f" || return 1
    [[ $WRITE_CHANGED == 1 ]] && changed=1
  done
  _nodestatus_render_unit | write_file "$NODESTATUS_UNIT_PATH" 0644 root:root || return 1
  [[ $WRITE_CHANGED == 1 ]] && changed=1
  run -- systemctl daemon-reload || return 1
  run -- systemctl enable "$NODESTATUS_UNIT" || return 1
  if [[ $changed == 1 ]]; then
    run -- systemctl restart "$NODESTATUS_UNIT" || return 1
  else
    run -- systemctl start "$NODESTATUS_UNIT" || return 1
  fi
  return 0
}

# _nodestatus_validate — proof the service works: active, node.json advancing
# on two consecutive ticks, fresh (< 10 s), and our deployment block preserved
# (deployment.run.run_id still equals this run's id after the daemon wrote).
_nodestatus_validate() {
  local i active=""
  for i in $(seq 1 15); do
    active="$(probe nodestatus-active -- systemctl is-active "$NODESTATUS_UNIT" 2>/dev/null || true)"
    [[ "$active" == active ]] && break
    sleep 1
  done
  if [[ "$active" != active ]]; then
    STEP_FAIL_REASON="$NODESTATUS_UNIT is '${active:-unknown}' — see: journalctl -u $NODESTATUS_UNIT -n 50"
    return 1
  fi
  local e0 e1 e2
  e0="$(node_json_get last_updated_epoch 0)"; [[ "$e0" =~ ^[0-9]+$ ]] || e0=0
  if ! nodestatus_wait_fresh 10 20 "$e0"; then
    STEP_FAIL_REASON="node.json was not rewritten within 20 s of starting the service"
    return 1
  fi
  e1="$(node_json_get last_updated_epoch 0)"
  if ! nodestatus_wait_fresh 10 20 "$e1"; then
    STEP_FAIL_REASON="node.json stopped advancing after the first tick"
    return 1
  fi
  e2="$(node_json_get last_updated_epoch 0)"
  log_ok "node.json advancing ($e1 → $e2), last update $(( $(now_epoch) - e2 ))s ago"
  local rid; rid="$(node_json_get deployment.run.run_id "")"
  if [[ "$rid" != "$RUN_ID" ]]; then
    STEP_FAIL_REASON="the service rewrote node.json without preserving deployment.run (found '$rid', expected '$RUN_ID')"
    return 1
  fi
  local alerts; alerts="$(node_json_get status.alerts '[]')"
  if [[ "$alerts" != "[]" ]]; then
    log_detail "status alerts right now (expected until drives/services are set up): $(printf '%s' "$alerts" | py json get --file - --key 0.id --default '?')…"
  fi
  return 0
}

# _nodestatus_preview — --test: one read-only collection, summarised.
_nodestatus_preview() {
  local -a hr=()
  if [[ -n "$FIXTURES" ]]; then
    if [[ -d "$FIXTURES/hostroot" ]]; then hr=(--host-root "$FIXTURES/hostroot")
    else log_test "metrics preview skipped (fixture run without a hostroot tree)"; return 0; fi
  fi
  local out
  if ! out="$(py collect --once --node-json "$NODE_JSON" --repo "$APOLLO_ROOT" "${hr[@]+"${hr[@]}"}" 2>/dev/null)"; then
    log_warn "metrics preview failed (the real service would log to journalctl)"
    return 0
  fi
  log_test "preview of what the service would write every 5 s:"
  ui_kv "cpu" "$(printf '%s' "$out" | json_get metrics.cpu.percent '?')% of $(printf '%s' "$out" | json_get metrics.cpu.cores '?') cores, temp $(printf '%s' "$out" | json_get metrics.cpu.temp_celsius 'n/a')°C"
  ui_kv "memory" "$(fmt_bytes "$(printf '%s' "$out" | json_get metrics.memory.used_bytes 0)") / $(fmt_bytes "$(printf '%s' "$out" | json_get metrics.memory.total_bytes 0)")"
  ui_kv "network" "$(printf '%s' "$out" | json_get metrics.network.interfaces '[]')"
  ui_kv "drives" "$(printf '%s' "$out" | json_get metrics.drive_capacity.disk_count 0) recorded"
  ui_kv "docker" "$(printf '%s' "$out" | json_get metrics.docker.daemon '?')"
  health_show_sample "$(printf '%s' "$out" | json_get metrics '{}')"
  ui_kv "alerts" "$(printf '%s' "$out" | json_get status.alerts '[]' | head -c 300)"
  return 0
}

# deploy_step_nodestatus — STEP (deploy + update): install/upgrade, enable,
# validate. --test: show the plan and a live read-only preview instead.
deploy_step_nodestatus() {
  if ! cmd_exists python3 && ! is_test; then
    STEP_FAIL_REASON="python3 is required for the status service (preflight should have installed it)"
    return 1
  fi
  local want have active
  want="$(nodestatus_repo_hash)"
  have="$(probe nodestatus-installed-hash -- _nodestatus_installed_hash 2>/dev/null || true)"
  active="$(probe nodestatus-active -- systemctl is-active "$NODESTATUS_UNIT" 2>/dev/null || true)"
  ui_kv "service" "$NODESTATUS_UNIT (${active:-not installed})"
  ui_kv "writes" "$NODE_JSON_REAL every 5 s"
  ui_kv "code" "$NODESTATUS_INSTALL_DIR (copied from the repo; version $(nodestatus_version))"
  if [[ -n "$have" && "$have" == "$want" && "$active" == active ]]; then
    log_ok "Installed, running and up to date."
  else
    if [[ -z "$have" ]]; then log_info "Installing the status service…"
    elif [[ "$have" != "$want" ]]; then log_info "The installed copy is out of date — upgrading."
    else log_info "Installed but not running — starting it."; fi
    _nodestatus_install || { STEP_FAIL_REASON="${STEP_FAIL_REASON:-installing $NODESTATUS_UNIT failed}"; return 1; }
  fi
  if is_test; then
    _nodestatus_preview
  else
    _nodestatus_validate || return 1
  fi
  printf '{"components":{"node_status":{"sha256":%s,"version":%s,"installed_at":%s,"unit":%s}}}' \
    "$(json_escape "$want")" "$(json_escape "$(nodestatus_version)")" "$(json_escape "$(now_iso)")" \
    "$(json_escape "$NODESTATUS_UNIT")" | node_json_merge deployment >/dev/null || return 1
  return 0
}

# nodestatus_wait_fresh [MAX_AGE=10] [TIMEOUT=20] [SINCE_EPOCH] — wait until
# node.json's last_updated_epoch is <= MAX_AGE s old (and > SINCE_EPOCH when
# given, i.e. a tick that happened after a change we made). rc 0 / 1 timeout.
# --test: the sandbox copy never advances, so this only reports on the live file.
nodestatus_wait_fresh() {
  local max="${1:-10}" timeout="${2:-20}" since="${3:-0}" e
  if is_test; then
    [[ -n "$FIXTURES" || ! -f "$NODE_JSON_REAL" ]] && return 0
    e="$(py json get --file "$NODE_JSON_REAL" --key last_updated_epoch --default 0 2>/dev/null)"
    [[ "$e" =~ ^[0-9]+$ ]] || e=0
    (( $(now_epoch) - e <= max )) || log_test "the live node.json is $(( $(now_epoch) - e ))s old (is the service running?)"
    return 0
  fi
  local deadline=$(( $(now_epoch) + timeout ))
  while (( $(now_epoch) <= deadline )); do
    e="$(node_json_get last_updated_epoch 0 2>/dev/null)"
    [[ "$e" =~ ^[0-9]+$ ]] || e=0
    if (( e > since && $(now_epoch) - e <= max )); then return 0; fi
    sleep 1
  done
  return 1
}

# restart_step_host — STEP (restart): restart the status service and avahi,
# then wait for a fresh node.json.
restart_step_host() {
  local start; start="$(now_epoch)"
  if probe nodestatus-unit-present -- systemctl cat "$NODESTATUS_UNIT" >/dev/null 2>&1; then
    run -- systemctl restart "$NODESTATUS_UNIT" || { STEP_FAIL_REASON="could not restart $NODESTATUS_UNIT"; return 1; }
  else
    log_warn "$NODESTATUS_UNIT is not installed — run ./deploy.sh update to repair it."
    return 1
  fi
  if probe avahi-unit-present -- systemctl cat avahi-daemon.service >/dev/null 2>&1; then
    run -- systemctl restart avahi-daemon.service || log_warn "avahi-daemon did not restart (discovery only)"
  fi
  if ! nodestatus_wait_fresh 10 25 "$start"; then
    STEP_FAIL_REASON="node.json was not refreshed within 25 s of restarting $NODESTATUS_UNIT"
    return 1
  fi
  return 0
}

# drift_nodestatus — update drift lines.
drift_nodestatus() {
  local want have active e age
  want="$(nodestatus_repo_hash)"
  have="$(probe nodestatus-installed-hash -- _nodestatus_installed_hash 2>/dev/null || true)"
  active="$(probe nodestatus-active -- systemctl is-active "$NODESTATUS_UNIT" 2>/dev/null || true)"
  if [[ -z "$have" ]]; then echo "crit|nodestatus|$NODESTATUS_UNIT is not installed"; return 0; fi
  [[ "$have" == "$want" ]] || echo "warn|nodestatus|installed collector differs from the repo (out of date)"
  [[ "$active" == active ]] || echo "crit|nodestatus|$NODESTATUS_UNIT is ${active:-not active}"
  e="$(node_json_get last_updated_epoch 0 2>/dev/null)"; [[ "$e" =~ ^[0-9]+$ ]] || e=0
  age=$(( $(now_epoch) - e ))
  if (( e == 0 )); then echo "warn|nodestatus|node.json has never been written by the service"
  elif (( age > 15 )); then echo "warn|nodestatus|node.json last updated ${age}s ago"
  else echo "ok|nodestatus|service active, node.json ${age}s old"; fi
  return 0
}
