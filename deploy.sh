#!/usr/bin/env bash
#
# deploy.sh — Apollo SFS node manager.
#
#   ./deploy.sh deploy     provision (or adopt) THIS node: name it, join/init
#                          the cluster, set up manager infrastructure, drives,
#                          storage roles, services, health check + heartbeat
#   ./deploy.sh restart    restart this node's Docker services + health check
#                          (+ heartbeat with the manager on workers)
#   ./deploy.sh update     review / update / repair everything deploy set up
#   ./deploy.sh release    build + push images and redeploy the stack (the
#                          original deploy.sh behaviour — manager only)
#   ./deploy.sh            interactive menu
#
#   restart and update are only available once node.json records a valid
#   deployment (written by a successful `deploy`).
#
# GLOBAL FLAGS (anywhere on the command line)
#   --test            walk every screen but change NOTHING on this device:
#                     mutations are printed, file writes are rendered into a
#                     temporary sandbox and shown as diffs. (--dry-run / -n
#                     are aliases, kept from the old script.)
#   --keep-sandbox    (with --test) keep the sandbox directory for inspection
#   --node-json PATH  (with --test) pretend PATH is this node's node.json
#   --fixtures DIR    (with --test) replay read-only probes from DIR
#   --ack=ID[,ID]|all pre-acknowledge alerts (for non-interactive runs)
#   -h, --help
#
# LEGACY: the original flags still work and run `release`:
#   ./deploy.sh --services frontend,api      ./deploy.sh --deploy-only
#   ./deploy.sh --migrate                    ./deploy.sh --registry H:P --tag T
#
# See docs/node_provisioning.md for the full guide, the node.json schema and
# the manager handover runbook.

set -Eeuo pipefail

if ((BASH_VERSINFO[0] < 4)); then
  echo "deploy.sh requires bash >= 4 (this is ${BASH_VERSION})." >&2
  exit 1
fi

APOLLO_ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
export APOLLO_ROOT
ORIG_ARGS=("$@")

usage() {
  sed -n '2,/^# See docs/p' "$APOLLO_ROOT/deploy.sh" | sed 's/^# \{0,1\}//' >&2
}

# ── Global argument parsing ──────────────────────────────────────────────────
TEST_MODE=0
KEEP_SANDBOX=0
TEST_NODE_JSON=""
SUBCMD=""
SUB_ARGS=()
TEST_STATE=()
LEGACY_RELEASE_FLAGS=" --services --registry --tag --deploy-only --migrate -y --yes "
want_help=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --test|--dry-run|-n) TEST_MODE=1; shift ;;
    --keep-sandbox) KEEP_SANDBOX=1; shift ;;
    --node-json) TEST_NODE_JSON="${2:?--node-json needs a path}"; shift 2 ;;
    --node-json=*) TEST_NODE_JSON="${1#*=}"; shift ;;
    --fixtures) export APOLLO_DEPLOY_FIXTURES="${2:?--fixtures needs a directory}"; shift 2 ;;
    --ack=*) ACK_ALERTS="${1#--ack=}"; shift ;;
    --non-interactive) NONINTERACTIVE=1; shift ;;
    --state) TEST_STATE+=("${2:?--state needs KEY=VALUE}"); shift 2 ;;
    -h|--help) want_help=1; shift ;;
    deploy|restart|update|release|_remote|_step|menu)
      if [[ -z "$SUBCMD" ]]; then SUBCMD="$1"; else SUB_ARGS+=("$1"); fi
      shift ;;
    *) SUB_ARGS+=("$1"); shift ;;
  esac
done

# Old-style invocation (no subcommand, release flags) → release.
if [[ -z "$SUBCMD" && ${#SUB_ARGS[@]} -gt 0 && "$LEGACY_RELEASE_FLAGS" == *" ${SUB_ARGS[0]%%=*} "* ]]; then
  SUBCMD=release
fi
if [[ $want_help == 1 ]]; then
  if [[ "$SUBCMD" == release ]]; then SUB_ARGS=(--help "${SUB_ARGS[@]+"${SUB_ARGS[@]}"}"); else usage; exit 0; fi
fi
if [[ -z "$SUBCMD" && ${#SUB_ARGS[@]} -gt 0 ]]; then
  echo "Unknown argument: ${SUB_ARGS[0]}" >&2
  usage
  exit 2
fi
if [[ $TEST_MODE != 1 && ( -n "$TEST_NODE_JSON" || -n "${APOLLO_DEPLOY_FIXTURES:-}" || ${#TEST_STATE[@]} -gt 0 || "$SUBCMD" == _step ) ]]; then
  echo "--node-json, --fixtures, --state and _step are only allowed together with --test." >&2
  exit 2
fi
if [[ -n "$TEST_NODE_JSON" ]]; then
  [[ -f "$TEST_NODE_JSON" ]] || { echo "--node-json: no such file: $TEST_NODE_JSON" >&2; exit 2; }
  TEST_NODE_JSON="$(readlink -f "$TEST_NODE_JSON")"
fi
export TEST_MODE KEEP_SANDBOX TEST_NODE_JSON

# ── Libraries ────────────────────────────────────────────────────────────────
LIB="$APOLLO_ROOT/scripts/deploy/lib"
# shellcheck source=scripts/deploy/lib/core.sh
source "$LIB/core.sh"
# shellcheck source=scripts/deploy/lib/ui.sh
source "$LIB/ui.sh"
# shellcheck source=scripts/deploy/lib/remote.sh
source "$LIB/remote.sh"
for _lib in system nodestatus cluster handover manager drives roles stack health release; do
  # shellcheck disable=SC1090
  source "$LIB/$_lib.sh"
done
for _flow in deploy restart update; do
  # shellcheck disable=SC1090
  source "$APOLLO_ROOT/scripts/deploy/flows/$_flow.sh"
done
unset _lib _flow

_on_exit() {
  local rc=$?
  flow_abort_trap "$rc" || true
  ssh_master_stop || true
  core_cleanup || true
  [[ -t 2 ]] && { tput cnorm >&2 2>/dev/null || true; }
  exit "$rc"
}

# ── _remote: manager-side RPC endpoint (stdin = JSON request) ───────────────
if [[ "$SUBCMD" == _remote ]]; then
  RUN_OP=_remote
  NONINTERACTIVE=1
  if [[ -t 0 ]]; then REMOTE_REQ="{}"; else REMOTE_REQ="$(cat)"; fi
  [[ -n "${REMOTE_REQ//[[:space:]]/}" ]] || REMOTE_REQ="{}"
  exec 3</dev/null 0</dev/null
  core_init
  trap 'core_cleanup' EXIT
  rc=0
  remote_main "${SUB_ARGS[@]+"${SUB_ARGS[@]}"}" || rc=$?
  exit "$rc"
fi

# ── Interactive commands ─────────────────────────────────────────────────────
if [[ $TEST_MODE != 1 && "$SUBCMD" =~ ^(deploy|restart|update)$ ]]; then
  if is_wsl; then
    die "This looks like WSL — a WSL host is never an Apollo SFS node. Use --test to walk the flow here."
  fi
  has_systemd || die "systemd must be PID 1 on an Apollo SFS node."
  need_root "${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}"
fi

ui_init
core_init
trap _on_exit EXIT
trap 'exit 130' INT TERM

ui_banner() {
  local title="$1"
  printf '\n%s%sApollo SFS — %s%s   %s(deploy.sh %s · %s)%s\n' "$C_BOLD" "$C_CYAN" "$title" "$C_RESET" "$C_DIM" \
    "$SCRIPT_VERSION" "$(this_hostname 2>/dev/null || hostname)" "$C_RESET" >&2
  if is_test; then
    printf '%s%s[TEST MODE] Nothing will be changed on this device — mutations are printed, files are rendered into %s%s\n' \
      "$C_MAGENTA" "$C_BOLD" "$TEST_SANDBOX" "$C_RESET" >&2
  fi
}

run_menu() {
  local -a dis=()
  local summary="no recorded deployment"
  if deployment_valid --quiet; then
    summary="$(node_json_get deployment.cluster.role "?") of \"$(node_json_get deployment.cluster.server_name "?")\" — last $(node_json_get deployment.last_success.op "?") $(node_json_get deployment.last_success.at "")"
  else
    dis+=(--disable "restart=needs a valid deployment (run deploy first)" --disable "update=needs a valid deployment (run deploy first)")
  fi
  ui_banner "node manager"
  ui_kv "this node" "$(this_hostname) — $summary"
  local choice
  select_one choice "What would you like to do?" "${dis[@]+"${dis[@]}"}" --default deploy \
    deploy="deploy   — provision or adopt this node" \
    restart="restart  — restart this node's services + health check" \
    update="update   — review, update and repair this node" \
    release="release  — build + push images and redeploy the stack (manager)" \
    quit="quit"
  [[ "$choice" == quit ]] && exit 0
  SUBCMD="$choice"
  if [[ $TEST_MODE != 1 && "$SUBCMD" =~ ^(deploy|restart|update)$ && $EUID -ne 0 ]]; then
    log_info "This needs root — re-running as: sudo ./deploy.sh $SUBCMD"
    exec 0<&3 3<&-
    need_root "$SUBCMD"
  fi
}

[[ -z "$SUBCMD" || "$SUBCMD" == menu ]] && run_menu

# Hidden, --test only (test harness): run ONE step function in isolation.
#   ./deploy.sh --test [--node-json F] [--state role=manager]… _step FN [ARGS…]
# Run-state is seeded from node.json (role/server/node name, manager context)
# and then from each --state KEY=VALUE.
run_single_step() {
  local fn="${1:?_step needs a function name}"; shift
  RUN_OP="${APOLLO_TEST_RUN_OP:-deploy}"
  if node_json_exists; then
    state_set role "$(node_json_get deployment.cluster.role "")"
    state_set server_name "$(node_json_get deployment.cluster.server_name "")"
    state_set node_name "$(node_json_get deployment.node.name "")"
    remote_context_load
  fi
  local kv
  for kv in "${TEST_STATE[@]+"${TEST_STATE[@]}"}"; do state_set "${kv%%=*}" "${kv#*=}"; done
  ui_banner "step $fn"
  STEP_TOTAL=1
  step "$fn" "$fn" "$fn" "$@"
  local id; for id in "${!STEP_RESULTS[@]}"; do printf 'STEP_RESULT %s=%s\n' "$id" "${STEP_RESULTS[$id]}" >&2; done
}

case "$SUBCMD" in
  deploy)  ui_banner "deploy";  with_lock deploy -- flow_deploy ;;
  restart) ui_banner "restart"; with_lock deploy -- flow_restart ;;
  update)  ui_banner "update";  with_lock deploy -- flow_update ;;
  release) RUN_OP=release; release_main "${SUB_ARGS[@]+"${SUB_ARGS[@]}"}" ;;
  _step)   run_single_step "${SUB_ARGS[@]+"${SUB_ARGS[@]}"}" ;;
  *) usage; exit 2 ;;
esac
