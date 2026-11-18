# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# flows/restart.sh — `deploy.sh restart`: restart every Docker service running
# on this node, health-check services + drives, and (on workers) heartbeat the
# manager. Only offered when node.json holds a valid deployment.
# ─────────────────────────────────────────────────────────────────────────────

require_valid_deployment() {
  if ! deployment_valid; then
    log_error "'$1' needs a valid deployment recorded in node.json — run ./deploy.sh deploy first."
    exit 5
  fi
  state_set role "$(node_json_get deployment.cluster.role "")"
  state_set server_name "$(node_json_get deployment.cluster.server_name "")"
  state_set node_name "$(node_json_get deployment.node.name "$(this_hostname)")"
  remote_context_load
}

flow_restart() {
  require_valid_deployment restart
  flow_begin restart
  STEP_TOTAL=6
  step summary   "Node summary"                      restart_step_summary
  step mounts    "Drives & pools"                    restart_step_mounts
  step host      "Host services"                     restart_step_host
  step services  "Restart Docker services"           restart_step_services
  step health    "Health check (services & drives)"  restart_step_health
  step heartbeat "Heartbeat"                         restart_step_heartbeat
  flow_end restart
  flow_summary restart
}
