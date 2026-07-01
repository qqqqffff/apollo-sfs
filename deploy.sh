#!/usr/bin/env bash
#
# deploy.sh — build, tag, push, and deploy Apollo SFS's custom images
# (frontend, api, node-agent) to the private registry and the Swarm stack.
#
# WHY THIS EXISTS
#   docker-stack.yml pins each custom image to its OWN tag variable
#   (FRONTEND_TAG, API_TAG, NODE_AGENT_TAG) rather than one shared TAG. If all
#   three shared one tag, redeploying just the frontend under a new tag would
#   also point api/node-agent at that same (never-built, never-pushed) tag, and
#   the deploy fails with "image ...:<tag> could not be accessed on a registry
#   to record its digest."
#
#   This script picks which service(s) actually changed, builds + pushes ONLY
#   those under a fresh tag (git short SHA by default), and for every service
#   you did NOT rebuild it asks the running Swarm what tag it's already on
#   (`docker service inspect`) and redeploys with that unchanged — no separate
#   tracking file, the cluster itself is the source of truth for "what's
#   currently deployed."
#
#   See docs/registry_setup.md for the full manual workflow this wraps.
#
# USAGE
#   ./deploy.sh                                  interactive checklist (TTY only)
#   ./deploy.sh --services frontend,api           non-interactive
#   ./deploy.sh --registry 192.168.68.57:5000 --tag v1.2.0
#   ./deploy.sh --deploy-only                     redeploy with no image changes (reapply stack config)
#   ./deploy.sh --migrate                         also apply pending DB migrations first
#   ./deploy.sh --dry-run                         print the commands without running them
#
# Run this on the manager (it needs the buildx/registry setup from
# docs/registry_setup.md). Requires: docker, docker buildx, git.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

STACK_FILE="docker-stack.yml"
STACK_NAME="apollo-sfs"
DOTENV_FILE=".env"
DEFAULT_REGISTRY="192.168.68.57:5000"
BUILDER_NAME="apollo-builder"

# ── Per-service image config ──────────────────────────────────────────────────
ORDER=(frontend api node-agent)
declare -A IMAGE_REPO=(
  [frontend]="apollo-sfs_frontend"
  [api]="apollo-sfs_api"
  [node-agent]="apollo-sfs-node-agent"
)
declare -A IMAGE_CONTEXT=(
  [frontend]="frontend/"
  [api]="api/"
  [node-agent]="api/"
)
declare -A IMAGE_DOCKERFILE=(
  [node-agent]="api/Dockerfile.node-agent"
)
declare -A IMAGE_PLATFORMS=(
  [frontend]="linux/amd64"
  [api]="linux/amd64,linux/arm64"
  [node-agent]="linux/amd64,linux/arm64"
)
# Swarm service name(s) to query for "what tag is currently deployed" when a
# service isn't rebuilt this run. node-agent runs as two services (fast/standard)
# sharing one tag var, so either one answering is enough.
declare -A SWARM_SERVICES=(
  [frontend]="apollo-sfs_frontend"
  [api]="apollo-sfs_api"
  [node-agent]="apollo-sfs_node-agent-standard apollo-sfs_node-agent-fast"
)

trap 'tput cnorm 2>/dev/null || true' EXIT

# ── CLI args ───────────────────────────────────────────────────────────────────
REGISTRY="${REGISTRY:-}"
TAG="${TAG:-}"
SERVICES_ARG=""
ASSUME_YES=0
DEPLOY_ONLY=0
DRY_RUN=0
RUN_MIGRATIONS=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

  --services frontend,api,node-agent   Skip the interactive checklist; build+deploy these.
  --registry HOST:PORT                 Registry endpoint (default: \$REGISTRY env or ${DEFAULT_REGISTRY})
  --tag TAG                            Tag to build/push (default: short git SHA)
  --deploy-only                        Skip build/push entirely; redeploy every service with
                                        whatever tag is currently running (reapplies stack
                                        config, e.g. env var changes, without an image change)
  --migrate                            Apply pending DB migrations (db/apply-migrations.sh)
                                        against the running apollo-sfs_db-app container before
                                        building/deploying
  -y, --yes                            Skip the confirmation prompt
  -n, --dry-run                        Print the commands without running them
  -h, --help                           Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --services) SERVICES_ARG="$2"; shift 2 ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --deploy-only) DEPLOY_ONLY=1; shift ;;
    --migrate) RUN_MIGRATIONS=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -n|--dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

run() {
  echo "+ $*"
  [[ $DRY_RUN -eq 1 ]] || "$@"
}

# ── Interactive checklist ─────────────────────────────────────────────────────
# ↑/↓ (or j/k) move, space toggles the highlighted item, enter confirms (must
# have at least one selected), q cancels. Populates SELECTED (parallel to
# OPTIONS) in place.
declare -a OPTIONS=("migrate" "${ORDER[@]}")
declare -a OPTION_LABELS=("Run DB migrations (db/apply-migrations.sh)" "${ORDER[@]}")
declare -a SELECTED=(0 0 0 0)
CURSOR=0

select_services() {
  local total_lines=$(( ${#OPTIONS[@]} + 3 ))
  local key rest notice=""

  draw() {
    local i mark
    printf '\r\033[2K%s\n' "Select images to build + push, then deploy:"
    printf '\r\033[2K%s\n' "  up/down (or j/k) move   ·   space toggle   ·   enter confirm   ·   q quit"
    for i in "${!OPTIONS[@]}"; do
      mark=" "; [[ ${SELECTED[$i]} -eq 1 ]] && mark="x"
      if [[ $i -eq $CURSOR ]]; then
        printf '\r\033[2K\033[1;36m> [%s] %s\033[0m\n' "$mark" "${OPTION_LABELS[$i]}"
      else
        printf '\r\033[2K  [%s] %s\n' "$mark" "${OPTION_LABELS[$i]}"
      fi
    done
    printf '\r\033[2K%s\n' "$notice"
  }

  tput civis 2>/dev/null || true
  draw
  while true; do
    IFS= read -rsn1 key
    if [[ $key == $'\x1b' ]]; then
      read -rsn2 -t 0.1 rest || rest=""
      key+="$rest"
    fi
    notice=""
    case "$key" in
      $'\x1b[A'|k|K) CURSOR=$(( (CURSOR - 1 + ${#OPTIONS[@]}) % ${#OPTIONS[@]} )) ;;
      $'\x1b[B'|j|J) CURSOR=$(( (CURSOR + 1) % ${#OPTIONS[@]} )) ;;
      ' ') SELECTED[$CURSOR]=$(( 1 - SELECTED[$CURSOR] )) ;;
      q|Q) tput cnorm 2>/dev/null || true; echo "Cancelled." >&2; exit 1 ;;
      ""|$'\n'|$'\r')
        local sum=0 s
        for s in "${SELECTED[@]}"; do sum=$((sum+s)); done
        if [[ $sum -eq 0 ]]; then
          notice="  (select at least one option first)"
        else
          break
        fi
        ;;
    esac
    printf '\033[%dA' "$total_lines"
    draw
  done
  tput cnorm 2>/dev/null || true
}

# ── Preflight ──────────────────────────────────────────────────────────────────
command -v docker >/dev/null || { echo "docker not found in PATH" >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "docker buildx not available" >&2; exit 1; }

if [[ ! -f "$DOTENV_FILE" ]]; then
  echo "Missing $DOTENV_FILE — see README.md 'Environment file'." >&2
  exit 1
fi

echo "── Loading $DOTENV_FILE ──"
set -a
# shellcheck disable=SC1090
source "$DOTENV_FILE"
set +a

: "${REGISTRY:=$DEFAULT_REGISTRY}"
: "${TAG:=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)}"
if [[ -z "$TAG" ]]; then
  echo "Could not determine a tag automatically (not a git repo?). Pass --tag." >&2
  exit 1
fi
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null || true)" ]]; then
  echo "Warning: working tree has uncommitted changes — the pushed image won't exactly match a commit." >&2
fi

# ── Choose which services to build + deploy ───────────────────────────────────
SELECTED_SERVICES=()
if [[ $DEPLOY_ONLY -eq 1 ]]; then
  : # nothing to build; every service's tag is resolved live below
elif [[ -n "$SERVICES_ARG" ]]; then
  IFS=',' read -ra SELECTED_SERVICES <<< "$SERVICES_ARG"
elif [[ -t 0 && -t 1 ]]; then
  select_services
  [[ ${SELECTED[0]} -eq 1 ]] && RUN_MIGRATIONS=1
  for i in "${!ORDER[@]}"; do
    [[ ${SELECTED[$((i+1))]} -eq 1 ]] && SELECTED_SERVICES+=("${ORDER[$i]}")
  done
else
  echo "Not an interactive terminal — pass --services frontend,api,node-agent (or --deploy-only)." >&2
  exit 1
fi

for s in ${SELECTED_SERVICES[@]+"${SELECTED_SERVICES[@]}"}; do
  [[ -n "${IMAGE_REPO[$s]:-}" ]] || { echo "Unknown service: $s (expected one of: ${ORDER[*]})" >&2; exit 1; }
done

is_selected() {
  local x
  for x in ${SELECTED_SERVICES[@]+"${SELECTED_SERVICES[@]}"}; do
    [[ "$x" == "$1" ]] && return 0
  done
  return 1
}

# ── Resolve each service's tag: freshly built ones use $TAG; untouched ones ───
# ask the running Swarm what's already deployed, so they redeploy unchanged
# instead of pointing at a tag that was never pushed for them.
resolve_deployed_tag() {
  local svc="$1" name image
  for name in ${SWARM_SERVICES[$svc]}; do
    image="$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$name" 2>/dev/null)" || continue
    image="${image%%@*}"          # strip a resolved-digest suffix, if present
    [[ -n "$image" ]] && { echo "${image##*:}"; return 0; }
  done
  return 1
}

declare -A RESOLVED_TAG=()
declare -A STATUS=()
for svc in "${ORDER[@]}"; do
  if is_selected "$svc"; then
    RESOLVED_TAG[$svc]="$TAG"
    STATUS[$svc]="build + push"
  elif current="$(resolve_deployed_tag "$svc")"; then
    RESOLVED_TAG[$svc]="$current"
    STATUS[$svc]="currently deployed (unchanged)"
  else
    RESOLVED_TAG[$svc]=""
    STATUS[$svc]="NOT DEPLOYED"
  fi
done

missing=()
for svc in "${ORDER[@]}"; do
  [[ -z "${RESOLVED_TAG[$svc]}" ]] && missing+=("$svc")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "No running version found for: ${missing[*]}." >&2
  echo "Include them in --services (or the checklist) so they get built on this first deploy." >&2
  exit 1
fi

# ── Confirm ────────────────────────────────────────────────────────────────────
echo
echo "Registry: $REGISTRY"
[[ $DEPLOY_ONLY -eq 1 ]] && echo "Mode:     deploy-only (no images will be built)"
[[ $RUN_MIGRATIONS -eq 1 ]] && echo "Migrate:  db/apply-migrations.sh will run against apollo-sfs_db-app first"
echo
printf '  %-12s %-10s %s\n' "SERVICE" "TAG" "ACTION"
for svc in "${ORDER[@]}"; do
  printf '  %-12s %-10s %s\n' "$svc" "${RESOLVED_TAG[$svc]}" "${STATUS[$svc]}"
done
echo

if [[ $ASSUME_YES -ne 1 ]]; then
  read -rp "Proceed? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

# ── Apply DB migrations ───────────────────────────────────────────────────────
# Runs before build/deploy, matching the manual "migrate DB → rebuild images →
# redeploy" order in docs/storage_node_setup.md — migrations are idempotent
# but should still land before new code that may depend on them.
# db/apply-migrations.sh finds the running apollo-sfs_db-app Swarm container itself.
if [[ $RUN_MIGRATIONS -eq 1 ]]; then
  echo "── Applying DB migrations ──"
  STACK_NAME="$STACK_NAME" run "$REPO_ROOT/db/apply-migrations.sh"
fi

# ── Build + push selected images ──────────────────────────────────────────────
ensure_builder() {
  if docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    run docker buildx use "$BUILDER_NAME"
    return
  fi
  echo "Builder '$BUILDER_NAME' not found — creating it (see docs/registry_setup.md)."
  local toml
  toml="$(mktemp)"
  cat > "$toml" <<EOF
[registry."${REGISTRY}"]
  http = true
  insecure = true
EOF
  run docker buildx create --name "$BUILDER_NAME" --driver docker-container \
    --driver-opt network=host --config "$toml" --bootstrap --use
}

if [[ ${#SELECTED_SERVICES[@]} -gt 0 ]]; then
  ensure_builder

  for svc in "${SELECTED_SERVICES[@]}"; do
    repo="${IMAGE_REPO[$svc]}"
    context="${IMAGE_CONTEXT[$svc]}"
    platforms="${IMAGE_PLATFORMS[$svc]}"
    dockerfile="${IMAGE_DOCKERFILE[$svc]:-}"
    image_ref="${REGISTRY}/${repo}:${TAG}"

    echo "── Building $svc -> $image_ref ($platforms) ──"
    build_args=(buildx build --platform "$platforms" -t "$image_ref")
    [[ -n "$dockerfile" ]] && build_args+=(-f "$dockerfile")
    build_args+=("$context" --push)
    run docker "${build_args[@]}"
  done
fi

# ── Deploy ─────────────────────────────────────────────────────────────────────
export REGISTRY
export API_TAG="${RESOLVED_TAG[api]}"
export FRONTEND_TAG="${RESOLVED_TAG[frontend]}"
export NODE_AGENT_TAG="${RESOLVED_TAG[node-agent]}"

echo "── Deploying $STACK_NAME ──"
run docker stack deploy -c "$STACK_FILE" "$STACK_NAME"

echo
echo "Rollout:"
run docker stack services "$STACK_NAME"
