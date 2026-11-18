# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# flows/update.sh — `deploy.sh update`: drift report, then walk the deploy
# steps with the current values as defaults (keep / change / repair).
# Only offered when node.json holds a valid deployment.
# ─────────────────────────────────────────────────────────────────────────────

flow_update() {
  require_valid_deployment update
  flow_begin update
  STEP_TOTAL=11
  step repo       "Repository"                        update_step_repo
  step drift      "Drift report"                      update_step_drift
  step preflight  "Dependencies"                      deploy_step_preflight
  step identity   "System name"                       deploy_step_identity
  step membership "Cluster membership"                update_step_membership
  step nodestatus "Background status service"         deploy_step_nodestatus
  step manager    "Manager infrastructure"            deploy_step_manager --on manager
  step drives     "Drives"                            update_step_drives
  step roles      "Roles & storage allocation"        deploy_step_roles
  step stack      "Services"                          deploy_step_stack
  step health     "Health check & heartbeat"          deploy_step_health
  flow_end update
  flow_summary update
}

# update_step_repo — offer `git pull --ff-only` (as the repo owner) and
# re-exec when deploy scripts changed (bash reads scripts lazily, so running
# on top of files that change underneath it is unsafe).
update_step_repo() {
  cmd_exists git || return 2
  git -C "$APOLLO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 2
  local branch head dirty
  branch="$(git -C "$APOLLO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  head="$(git -C "$APOLLO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  dirty="$(git -C "$APOLLO_ROOT" status --porcelain --untracked-files=no 2>/dev/null | head -n1)"
  ui_kv "branch" "$branch @ $head${dirty:+ (uncommitted changes)}"
  if [[ -n "$dirty" ]]; then
    log_warn "The working tree has uncommitted changes — skipping git pull."
    return 0
  fi
  ask_yn "Pull the latest commits for '$branch' first (git pull --ff-only)?" n || return 0
  local before after
  before="$(git -C "$APOLLO_ROOT" rev-parse HEAD)"
  run_as_owner -- git -C "$APOLLO_ROOT" pull --ff-only || { STEP_FAIL_REASON="git pull --ff-only failed (diverged branch or no network?)"; return 1; }
  is_test && return 0
  after="$(git -C "$APOLLO_ROOT" rev-parse HEAD)"
  if [[ "$before" != "$after" ]] && git -C "$APOLLO_ROOT" diff --name-only "$before" "$after" -- deploy.sh scripts/ | grep -q .; then
    log_info "deploy.sh itself changed — restarting the update with the new version…"
    flow_abort_trap >/dev/null 2>&1 || true
    exec 0<&3 3<&-
    exec "$APOLLO_ROOT/deploy.sh" update
  fi
  return 0
}

# update_step_drift — read-only report collected from every area's drift_*
# function. Each prints lines "SEVERITY|AREA|MESSAGE" (SEVERITY ok|info|warn|crit).
update_step_drift() {
  local fn line sev area msg n_warn=0 n_crit=0
  local -a rows=("AREA|STATUS|FINDING")
  for fn in drift_system drift_nodestatus drift_cluster drift_manager drift_drives drift_roles drift_stack; do
    declare -F "$fn" >/dev/null || continue
    while IFS='|' read -r sev area msg; do
      [[ -n "$sev" ]] || continue
      case "$sev" in
        warn) n_warn=$((n_warn + 1)) ;;
        crit) n_crit=$((n_crit + 1)) ;;
      esac
      rows+=("$area|$sev|$msg")
    done < <("$fn" 2>/dev/null || true)
  done
  if ((${#rows[@]} == 1)); then
    log_ok "No drift detected."
  else
    ui_table "${rows[@]}"
  fi
  state_set drift_warn "$n_warn"
  state_set drift_crit "$n_crit"
  (( n_crit > 0 )) && log_warn "$n_crit critical finding(s) — the following steps default to repairing them."
  return 0
}
