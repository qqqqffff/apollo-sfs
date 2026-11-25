# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# flows/deploy.sh — `deploy.sh deploy`: provision (or adopt) this node.
# The step functions live in the libs (see the ownership notes in each lib).
# ─────────────────────────────────────────────────────────────────────────────

flow_deploy() {
  if deployment_valid --quiet; then
    log_warn "This node already has a valid deployment (node.json revision $(node_json_get deployment.last_success.revision 0))."
    log_info "  'update' reviews and changes it in place; 'deploy' walks every step again (existing drives/data are adopted, never formatted)."
    ask_yn "Run the full deploy anyway?" n || { log_info "Nothing done. Try: ./deploy.sh update"; return 0; }
  fi
  flow_begin deploy
  STEP_TOTAL=9
  step preflight  "Preflight & dependencies"          deploy_step_preflight
  step identity   "System name"                       deploy_step_identity
  step membership "Cluster discovery & membership"    deploy_step_membership
  step nodestatus "Background status service"         deploy_step_nodestatus
  step manager    "Manager infrastructure"            deploy_step_manager --on manager
  step drives     "Drives"                            deploy_step_drives
  step roles      "Roles & storage allocation"        deploy_step_roles
  step stack      "Services"                          deploy_step_stack
  step health     "Health check & heartbeat"          deploy_step_health
  flow_end deploy
  flow_summary deploy
}

# flow_summary OP — closing table of step results + anything deferred.
flow_summary() {
  local op="$1" id
  ui_section "Summary — $op"
  local -a rows=("STEP|RESULT")
  for id in preflight repo drift identity membership nodestatus manager drives mounts host roles stack services health heartbeat summary; do
    [[ -n "${STEP_RESULTS[$id]+x}" ]] && rows+=("$id|${STEP_RESULTS[$id]}")
  done
  ui_table "${rows[@]}"
  if ((${#DEFERRED_STEPS[@]})); then
    log_warn "Deferred: ${DEFERRED_STEPS[*]} — re-checked by the health step; see above."
  fi
  if ((${#ALERTS_ACKED[@]})); then
    log_warn "${#ALERTS_ACKED[@]} alert(s) were acknowledged during this run (recorded in node.json → deployment.health.acknowledged_alerts)."
  fi
  if is_test; then
    log_test "No changes were made. Rendered files: $TEST_SANDBOX/fs (removed on exit unless --keep-sandbox)."
  else
    log_ok "node.json: $NODE_JSON"
  fi
}
