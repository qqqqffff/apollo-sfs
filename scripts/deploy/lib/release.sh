# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/release.sh — build, tag, push and deploy Apollo SFS's custom images
# (frontend, api, node-agent, recognition, test-runner) to the private registry
# and the Swarm stack. This is the original deploy.sh flow (WS4), unchanged in
# behaviour except where noted:
#
# WHY PER-IMAGE TAGS
#   docker-stack*.yml pin each custom image to its OWN tag variable (FRONTEND_TAG,
#   API_TAG, NODE_AGENT_TAG, …). Only the services you select are built + pushed
#   under a fresh tag (git short SHA by default); every other service redeploys
#   on the tag the running Swarm reports (`docker service inspect`) — the
#   cluster itself is the source of truth for "what's deployed".
#
# CHANGES vs the pre-2.0 script
#   * --dry-run / -n now mean the global --test (mutations printed, nothing run).
#   * REGISTRY precedence is CLI > environment > node.json > .env > default
#     (the old script let a REGISTRY in .env silently override --registry).
#   * node-agent's tag is read from any apollo-sfs_node-agent-* service (one
#     per node now), and both stack files are deployed via stack_preflight +
#     stack_deploy (docker-stack.yml + cluster/docker-stack.nodes.yml).
#   * arm64 emulation (binfmt) is ensured before multi-arch builds — it is
#     lost on every reboot.
#   * --no-deploy builds and pushes only (used when bootstrapping a server).
# ─────────────────────────────────────────────────────────────────────────────

REL_DEFAULT_REGISTRY="192.168.68.57:5000"
REL_BUILDER="apollo-builder"
# node-metrics-ingest is bundled with node-agent (they share a wire protocol),
# so it has no checklist entry of its own.
REL_ORDER=(frontend api node-agent recognition test-runner)
declare -gA REL_REPO=(
  [frontend]="apollo-sfs_frontend" [api]="apollo-sfs_api" [node-agent]="apollo-sfs-node-agent"
  [node-metrics-ingest]="apollo-sfs_node-metrics-ingest" [recognition]="apollo-sfs_recognition"
  [test-runner]="apollo-sfs_test-runner"
)
declare -gA REL_CONTEXT=(
  [frontend]="frontend/" [api]="api/" [node-agent]="api/" [node-metrics-ingest]="api/"
  [recognition]="recognition/" [test-runner]="."
)
declare -gA REL_DOCKERFILE=(
  [node-agent]="api/Dockerfile.node-agent" [node-metrics-ingest]="api/Dockerfile.node-metrics-ingest"
  [recognition]="recognition/Dockerfile" [test-runner]="test-runner/Dockerfile"
)
declare -gA REL_PLATFORMS=(
  [frontend]="linux/amd64" [api]="linux/amd64,linux/arm64" [node-agent]="linux/amd64,linux/arm64"
  [node-metrics-ingest]="linux/amd64" [recognition]="linux/amd64" [test-runner]="linux/amd64"
)
declare -gA REL_TAGVAR=(
  [frontend]=FRONTEND_TAG [api]=API_TAG [node-agent]=NODE_AGENT_TAG
  [node-metrics-ingest]=NODE_METRICS_INGEST_TAG [recognition]=RECOGNITION_TAG [test-runner]=TEST_RUNNER_TAG
)
declare -gA REL_BUNDLE=([node-agent]="node-metrics-ingest")
REL_ALL=("${REL_ORDER[@]}" node-metrics-ingest)

_rel_usage() {
  cat >&2 <<EOF
Usage: ./deploy.sh release [options]      (the old flags work without 'release' too)

  --services frontend,api,node-agent   Skip the interactive checklist; build+deploy these.
  --registry HOST:PORT                 Registry endpoint (default: \$REGISTRY, node.json, .env, ${REL_DEFAULT_REGISTRY})
  --tag TAG                            Tag to build/push (default: short git SHA)
  --deploy-only                        Skip build/push; redeploy every service on the tag it runs
                                       (reapplies stack config, e.g. env var changes)
  --migrate                            Apply pending DB migrations (db/apply-migrations.sh) first
  --no-deploy                          Build and push only
  -y, --yes                            Skip the confirmation prompt
  --test (or --dry-run, -n)            Print the commands without running them
  -h, --help                           Show this help
EOF
}

# _rel_tag_of SERVICE — the tag the running swarm uses for SERVICE (rc 1 if none).
_rel_tag_of() {
  local svc="$1" names name image
  if [[ "$svc" == node-agent ]]; then
    names="$(probe docker-service-names -- docker service ls --format '{{.Name}}' 2>/dev/null | grep "^${STACK_NAME}_node-agent-" || true)"
  else
    names="${STACK_NAME}_$svc"
  fi
  for name in $names; do
    image="$(probe "docker-svc-image-${name#"${STACK_NAME}_"}" -- docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$name" 2>/dev/null)" || continue
    image="${image%%@*}"
    [[ -n "$image" ]] && { printf '%s' "${image##*:}"; return 0; }
  done
  return 1
}

# release_resolve_tags — export every *_TAG not already set from the running
# swarm. rc 1 (missing names on stderr) when some image was never deployed.
release_resolve_tags() {
  local svc var tag missing=()
  for svc in "${REL_ALL[@]}"; do
    var="${REL_TAGVAR[$svc]}"
    [[ -n "${!var:-}" ]] && continue
    if tag="$(_rel_tag_of "$svc")"; then export "$var=$tag"; else missing+=("$svc"); fi
  done
  ((${#missing[@]} == 0)) || { printf 'no running image for: %s\n' "${missing[*]}" >&2; return 1; }
  return 0
}

_rel_check_mem_limit() {
  local var="$1" val="${!1-}"
  [[ -z "$val" ]] && return 0
  if [[ "$val" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    log_error "$var=\"$val\" has no unit — Docker reads that as $val BYTES, not GB. Use e.g. \"${val}G\" in .env."
    return 1
  fi
  [[ "$val" =~ ^[0-9]+(\.[0-9]+)?[bBkKmMgGtT][bB]?$ ]] || { log_error "$var=\"$val\" is not a valid Docker memory size (e.g. \"8G\")."; return 1; }
}

_rel_ensure_builder() {
  if probe "buildx-inspect-$REL_BUILDER" -- docker buildx inspect "$REL_BUILDER" >/dev/null 2>&1; then
    run -- docker buildx use "$REL_BUILDER"
    return
  fi
  log_info "Builder '$REL_BUILDER' not found — creating it (see docs/registry_setup.md)."
  local toml; toml="$(mktemp "${TMPDIR:-/tmp}/apollo-buildkitd.XXXXXX.toml")"
  printf '[registry."%s"]\n  http = true\n  insecure = true\n' "$REGISTRY" >"$toml"
  run -- docker buildx create --name "$REL_BUILDER" --driver docker-container \
    --driver-opt network=host --config "$toml" --bootstrap --use
}

# release_main ARGS… — the release flow.
release_main() {
  local registry_cli="" tag="" services_arg="" assume_yes=0 deploy_only=0 migrate=0 no_deploy=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --services) services_arg="${2:?--services needs a list}"; shift 2 ;;
      --services=*) services_arg="${1#*=}"; shift ;;
      --registry) registry_cli="${2:?--registry needs HOST:PORT}"; shift 2 ;;
      --registry=*) registry_cli="${1#*=}"; shift ;;
      --tag) tag="${2:?--tag needs a value}"; shift 2 ;;
      --tag=*) tag="${1#*=}"; shift ;;
      --deploy-only) deploy_only=1; shift ;;
      --migrate) migrate=1; shift ;;
      --no-deploy) no_deploy=1; shift ;;
      -y|--yes) assume_yes=1; shift ;;
      -h|--help) _rel_usage; return 0 ;;
      *) log_error "Unknown option: $1"; _rel_usage; return 2 ;;
    esac
  done
  # Precedence: CLI > environment > node.json > .env > default. Capture the
  # environment BEFORE .env is sourced (the old script let .env win).
  local registry_env="${REGISTRY:-}" tag_env="${TAG:-}"
  cmd_exists docker || { log_error "docker not found in PATH"; return 1; }
  probe buildx-version -- docker buildx version >/dev/null 2>&1 || { log_error "docker buildx not available"; return 1; }
  manager_env_load || { log_error "Missing $DOTENV_FILE — run ./deploy.sh deploy on the manager first."; return 1; }
  REGISTRY="${registry_cli:-${registry_env:-$(node_json_get deployment.cluster.registry "" 2>/dev/null)}}"
  [[ -n "$REGISTRY" ]] || REGISTRY="$(_mgr_env_effective | json_get values.REGISTRY "")"
  REGISTRY="${REGISTRY:-$REL_DEFAULT_REGISTRY}"
  export REGISTRY
  tag="${tag:-$tag_env}"
  [[ -n "$tag" ]] || tag="$(git -C "$APOLLO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
  if [[ -z "$tag" && $deploy_only -ne 1 ]]; then log_error "Could not determine a tag automatically (not a git repo?). Pass --tag."; return 1; fi
  local branch; branch="$(git -C "$APOLLO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -n "$(git -C "$APOLLO_ROOT" status --porcelain --untracked-files=no 2>/dev/null || true)" ]]; then
    log_warn "Working tree has uncommitted changes — the pushed image won't exactly match a commit."
  fi
  _rel_check_mem_limit RECOGNITION_MEM_LIMIT || return 1

  local -a selected=()
  if [[ $deploy_only -eq 1 ]]; then
    :
  elif [[ -n "$services_arg" ]]; then
    IFS=',' read -ra selected <<<"$services_arg"
  else
    local -a picked=()
    local -a opts=("migrate=Run DB migrations (db/apply-migrations.sh)")
    local s; for s in "${REL_ORDER[@]}"; do opts+=("$s=$s"); done
    checklist picked "Select images to build + push, then deploy:" --min 1 --all-key "${opts[@]}"
    for s in "${picked[@]}"; do
      if [[ "$s" == migrate ]]; then migrate=1; else selected+=("$s"); fi
    done
    [[ $CHECKLIST_ALL == 1 ]] && assume_yes=1
  fi
  # Pull in bundled services (node-agent → node-metrics-ingest).
  local svc b
  for svc in "${selected[@]+"${selected[@]}"}"; do
    b="${REL_BUNDLE[$svc]:-}"
    [[ -n "$b" && " ${selected[*]} " != *" $b "* ]] && selected+=("$b")
  done
  for svc in "${selected[@]+"${selected[@]}"}"; do
    [[ -n "${REL_REPO[$svc]:-}" ]] || { log_error "Unknown service: $svc (expected one of: ${REL_ORDER[*]})"; return 1; }
  done

  declare -A rtag=() rstatus=()
  local var missing=()
  for svc in "${REL_ALL[@]}"; do
    var="${REL_TAGVAR[$svc]}"
    if [[ " ${selected[*]+"${selected[*]}"} " == *" $svc "* ]]; then
      rtag[$svc]="$tag"; rstatus[$svc]="build + push"
    elif t="$(_rel_tag_of "$svc")"; then
      rtag[$svc]="$t"; rstatus[$svc]="currently deployed (unchanged)"
    else
      rtag[$svc]=""; rstatus[$svc]="NOT DEPLOYED"; missing+=("$svc")
    fi
  done
  if ((${#missing[@]})) && [[ $no_deploy -ne 1 ]]; then
    log_error "No running version found for: ${missing[*]}."
    log_info "Include them in --services (node-metrics-ingest rides along with node-agent) so they get built on this first deploy."
    return 1
  fi

  printf '\n' >&2
  ui_kv "registry" "$REGISTRY"
  [[ $deploy_only -eq 1 ]] && ui_kv "mode" "deploy-only (no images will be built)"
  [[ $no_deploy -eq 1 ]] && ui_kv "mode" "build + push only (no deploy)"
  [[ $migrate -eq 1 ]] && ui_kv "migrate" "db/apply-migrations.sh runs against ${STACK_NAME}_db-app first"
  local -a rows=("SERVICE|TAG|ACTION")
  for svc in "${REL_ALL[@]}"; do rows+=("$svc|${rtag[$svc]:--}|${rstatus[$svc]}"); done
  ui_table "${rows[@]}"
  if [[ $assume_yes -ne 1 ]]; then ask_yn "Proceed?" n || { log_info "Aborted."; return 1; }; fi

  if [[ $migrate -eq 1 ]]; then
    log_info "── Applying DB migrations ──"
    run -- env STACK_NAME="$STACK_NAME" "$APOLLO_ROOT/db/apply-migrations.sh" || return 1
  fi

  if ((${#selected[@]})); then
    [[ " ${selected[*]} " == *" api "* || " ${selected[*]} " == *" node-agent "* ]] && { manager_ensure_binfmt || log_warn "arm64 emulation missing — arm64 builds may fail"; }
    _rel_ensure_builder || return 1
    local ctx plat df ref
    for svc in "${selected[@]}"; do
      ctx="${REL_CONTEXT[$svc]}"; plat="${REL_PLATFORMS[$svc]}"; df="${REL_DOCKERFILE[$svc]:-}"
      ref="${REGISTRY}/${REL_REPO[$svc]}:${tag}"
      log_info "── Building $svc -> $ref ($plat) ──"
      local -a bargs=(buildx build --platform "$plat" -t "$ref")
      [[ -n "$df" ]] && bargs+=(-f "$APOLLO_ROOT/$df")
      [[ "$svc" == frontend ]] && bargs+=(--build-arg "VITE_MS_CLIENT_ID=${VITE_MS_CLIENT_ID:-}")
      [[ "$svc" == api ]] && bargs+=(--build-arg "APP_VERSION=${tag}" --build-arg "APP_GIT_BRANCH=${branch:-}")
      bargs+=("$APOLLO_ROOT/$ctx" --push)
      run -- docker "${bargs[@]}" || { log_error "building $svc failed"; return 1; }
    done
  fi
  [[ $no_deploy -eq 1 ]] && { log_ok "Images pushed."; return 0; }

  for svc in "${REL_ALL[@]}"; do export "${REL_TAGVAR[$svc]}=${rtag[$svc]}"; done
  log_info "── Deploying $STACK_NAME ──"
  stack_preflight || return 1
  stack_deploy --resolve-image always || return 1
  printf '\nRollout:\n' >&2
  probe docker-stack-services-table -- docker stack services "$STACK_NAME" >&2 || true
  return 0
}
