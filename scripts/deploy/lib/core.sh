# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/lib/core.sh — shared foundation for deploy.sh (the "WS0
# contract"). Sourced by deploy.sh, never executed directly.
#
# Everything that can change the machine goes through ONE of these, so --test
# can guarantee nothing is committed to the device:
#   probe   KEY -- CMD…      read-only; always runs (fixture-replaceable)
#   run     [opts] -- CMD…   mutation; printed (not run) in --test
#   write_file DEST …        file write; rendered into the sandbox + diffed in --test
#   fstab_upsert MARKER LINE fstab edit (via write_file) + daemon-reload (via run)
#   node_json_merge/set      node.json edits (sandbox copy in --test)
#
# CONVENTIONS every lib must follow
#   * Human-facing output goes to STDERR (log_* / ui_*); STDOUT is reserved
#     for data returned to a caller via $(…).
#   * Step functions (see `step`) run inside `fn || rc=$?`, where bash disables
#     `set -e` — so they MUST check return codes explicitly (`cmd || return 1`).
#   * Never read from stdin for user input — use the ui.sh helpers (fd 3).
#     deploy.sh points fd 0 at /dev/null so subprocesses can't eat answers.
#   * Never call `sudo`, `mount -a`, or write files directly; use the helpers.
# ─────────────────────────────────────────────────────────────────────────────

[[ -n "${_APOLLO_CORE_LOADED:-}" ]] && return 0
_APOLLO_CORE_LOADED=1

: "${APOLLO_ROOT:?APOLLO_ROOT must be set before sourcing core.sh}"

# `producer | write_file …` must run write_file in THIS shell so WRITE_CHANGED
# (and run-state) set inside it are visible to the caller. Scripts run without
# job control, so lastpipe applies.
shopt -s lastpipe

# ── Globals (contract) ───────────────────────────────────────────────────────
SCRIPT_VERSION="2.0.0"
PROTO=1                      # _remote wire-protocol version spoken by this copy
PROTO_MIN=1                  # oldest peer protocol we still accept
STACK_NAME="${STACK_NAME:-apollo-sfs}"
TEST_MODE="${TEST_MODE:-0}"
TEST_SANDBOX="${TEST_SANDBOX:-}"
KEEP_SANDBOX="${KEEP_SANDBOX:-0}"
NODE_JSON="${NODE_JSON:-$APOLLO_ROOT/node.json}"
NODE_JSON_REAL="$APOLLO_ROOT/node.json"   # never written in --test
LOCK_DIR="${LOCK_DIR:-/run/apollo-sfs}"
FIXTURES="${APOLLO_DEPLOY_FIXTURES:-}"
FIXTURES_STRICT="${APOLLO_FIXTURES_STRICT:-0}"
UI_FD=3
NONINTERACTIVE="${NONINTERACTIVE:-0}"
ACK_ALERTS="${ACK_ALERTS:-}"             # "id1,id2" or "all" — pre-acknowledged alerts
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
RUN_OP="${RUN_OP:-}"                     # deploy | restart | update | release | _remote
APOLLO_PY="$APOLLO_ROOT/scripts/node-status/apollo_node.py"
CLUSTER_DIR="$APOLLO_ROOT/cluster"
STACK_FILE="$APOLLO_ROOT/docker-stack.yml"
NODES_STACK_FILE="$CLUSTER_DIR/docker-stack.nodes.yml"
DOTENV_FILE="$APOLLO_ROOT/.env"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/apollo-sfs}"
BACKUP_DIR="$BACKUP_ROOT/$RUN_ID"
LOG_DIR="${LOG_DIR:-/var/log/apollo-sfs}"
LOG_FILE="${LOG_FILE:-}"
REPO_OWNER="${REPO_OWNER:-$(stat -c %U "$APOLLO_ROOT" 2>/dev/null || echo root)}"
REPO_GROUP="${REPO_GROUP:-$(stat -c %G "$APOLLO_ROOT" 2>/dev/null || echo root)}"
MINIO_UID=1000               # uid:gid the MinIO container writes data/ as
MINIO_GID=1000

declare -gA APOLLO_STATE=()  # run-state store (state_set/state_get)
declare -ga REDACT_VALUES=() # secrets masked out of every log line / diff
declare -ga ALERTS_ACKED=()  # "ts|level|id|title" — flushed into node.json by flow_end
declare -ga DEFERRED_STEPS=()
declare -gA STEP_RESULTS=()
WRITE_CHANGED=0
STEP_INDEX=0
STEP_TOTAL=0
CURRENT_STEP=""
STEP_FAIL_REASON=""
STEP_FIX_FN=""; STEP_FIX_LABEL=""

# ── Colours / logging ────────────────────────────────────────────────────────
if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_MAGENTA=$'\033[35m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""
  C_BLUE=""; C_MAGENTA=""; C_CYAN=""
fi

# redact_add VALUE… — mask these strings in all subsequent output.
redact_add() {
  local v
  for v in "$@"; do
    [[ ${#v} -ge 4 ]] && REDACT_VALUES+=("$v")
  done
  return 0
}

# mask STRING — print STRING with every registered secret replaced by ****.
mask() {
  local s="$1" v
  for v in "${REDACT_VALUES[@]+"${REDACT_VALUES[@]}"}"; do
    s="${s//"$v"/****}"
  done
  printf '%s' "$s"
}

_log_file_write() {
  [[ -n "$LOG_FILE" ]] || return 0
  printf '%s %s\n' "$(date '+%F %T')" "$(mask "$*")" >>"$LOG_FILE" 2>/dev/null || true
}

log_info()   { printf '%s\n' "$(mask "$*")" >&2; _log_file_write "INFO  $*"; }
log_detail() { printf '%s  %s%s\n' "$C_DIM" "$(mask "$*")" "$C_RESET" >&2; _log_file_write "      $*"; }
log_ok()     { printf '%s✔%s %s\n' "$C_GREEN" "$C_RESET" "$(mask "$*")" >&2; _log_file_write "OK    $*"; }
log_warn()   { printf '%s⚠ %s%s\n' "$C_YELLOW" "$(mask "$*")" "$C_RESET" >&2; _log_file_write "WARN  $*"; }
log_error()  { printf '%s✖ %s%s\n' "$C_RED" "$(mask "$*")" "$C_RESET" >&2; _log_file_write "ERROR $*"; }
log_test()   { printf '%s[test]%s %s\n' "$C_MAGENTA" "$C_RESET" "$(mask "$*")" >&2; _log_file_write "TEST  $*"; }
die()        { log_error "$*"; exit 1; }

# ── Small predicates / helpers ───────────────────────────────────────────────
_stub()         { log_warn "[not implemented yet] $1 (${2:-WS?})"; }   # placeholder used by unfinished libs
is_test()       { [[ "$TEST_MODE" == 1 ]]; }
cmd_exists()    { command -v "$1" >/dev/null 2>&1; }
is_wsl()        { [[ -e /proc/sys/fs/binfmt_misc/WSLInterop ]] || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; }
has_systemd()   { [[ "$(ps -p 1 -o comm= 2>/dev/null)" == systemd ]]; }
now_iso()       { date -u +%Y-%m-%dT%H:%M:%SZ; }
this_hostname() { probe hostname -- hostname; }   # use instead of `hostname` (fixture-replayable)
node_name()     { state_get node_name 2>/dev/null || this_hostname; }   # this node's (planned) name during a run
now_epoch()     { date +%s; }

# json_escape STRING — print STRING as a JSON string literal (with quotes).
json_escape() {
  local s="$1" out="" i c o
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      '"')  out+='\"' ;;
      '\')  out+='\\' ;;
      $'\n') out+='\n' ;;
      $'\r') out+='\r' ;;
      $'\t') out+='\t' ;;
      *)
        printf -v o '%d' "'$c" 2>/dev/null || o=32
        if (( o >= 0 && o < 32 )); then printf -v c '\\u%04x' "$o"; fi
        out+="$c" ;;
    esac
  done
  printf '"%s"' "$out"
}

# py ARGS… — run the stdlib python helper in isolated, no-bytecode mode.
py() {
  APOLLO_TEST="$TEST_MODE" APOLLO_TEST_SANDBOX="$TEST_SANDBOX" \
    python3 -I -B "$APOLLO_PY" "$@"
}

# json_get KEY [DEFAULT] — read KEY (dot path) from JSON on stdin.
# Strings print raw, everything else as compact JSON. Missing → DEFAULT (or rc 3).
json_get() {
  if [[ $# -ge 2 ]]; then
    py json get --file - --key "$1" --default "$2"
  else
    py json get --file - --key "$1"
  fi
}

# ── Read-only probes ─────────────────────────────────────────────────────────
# probe [--stdin] KEY -- CMD…
#   --stdin passes the caller's stdin to CMD (e.g. SQL for psql -f -); by
#   default CMD's stdin is /dev/null.
#   Always executes (even in --test) because it must not change anything.
#   With APOLLO_DEPLOY_FIXTURES set, $FIXTURES/<KEY> is printed instead and the
#   exit code is read from $FIXTURES/<KEY>.rc (default 0). KEY must be a stable
#   identifier: [a-z0-9._-] only (callers sanitise dynamic parts with
#   probe_key). In strict fixture mode a missing fixture fails (rc 127) instead
#   of falling through to the real command — used by the hermetic test harness.
probe_key() { local k="$*"; k="${k//[^A-Za-z0-9._-]/_}"; printf '%s' "${k,,}"; }

probe() {
  local use_stdin=0
  [[ "${1:-}" == --stdin ]] && { use_stdin=1; shift; }
  local key="$1"; shift
  [[ "${1:-}" == "--" ]] && shift
  if [[ -n "$FIXTURES" ]]; then
    if [[ -f "$FIXTURES/$key" || -f "$FIXTURES/$key.rc" ]]; then
      [[ $use_stdin == 1 ]] && cat >/dev/null
      [[ -f "$FIXTURES/$key" ]] && cat "$FIXTURES/$key"
      local rc=0
      [[ -f "$FIXTURES/$key.rc" ]] && rc="$(<"$FIXTURES/$key.rc")"
      return "$rc"
    fi
    if [[ "$FIXTURES_STRICT" == 1 ]]; then
      [[ $use_stdin == 1 ]] && cat >/dev/null
      printf 'probe: no fixture for key %q (strict fixture mode)\n' "$key" >&2
      [[ -n "${APOLLO_FIXTURE_MISSING_LOG:-}" ]] && printf '%s\n' "$key" >>"$APOLLO_FIXTURE_MISSING_LOG"
      return 127
    fi
  fi
  if [[ $use_stdin == 1 ]]; then "$@"; else "$@" </dev/null; fi
}

# ── Mutations ────────────────────────────────────────────────────────────────
_quote_cmd() {
  local out="" a q
  for a in "$@"; do printf -v q '%q' "$a"; out+="${out:+ }$q"; done
  printf '%s' "$out"
}

# run [--redact S]… [--sim-rc N] [--sim-out TEXT] [--stdin] [--quiet] [--] CMD…
#   Real mode: echoes "+ CMD" (secrets masked) to stderr, then executes CMD
#   with stdin from /dev/null (or the caller's stdin with --stdin).
#   --test: prints "[test] would run: CMD", drains stdin if --stdin, prints
#   --sim-out (if any) on stdout, and returns --sim-rc (default 0).
run() {
  local sim_rc=0 sim_out="" use_stdin=0 quiet=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --redact)  redact_add "$2"; shift 2 ;;
      --sim-rc)  sim_rc="$2"; shift 2 ;;
      --sim-out) sim_out="$2"; shift 2 ;;
      --stdin)   use_stdin=1; shift ;;
      --quiet)   quiet=1; shift ;;
      --)        shift; break ;;
      *)         break ;;
    esac
  done
  [[ $# -gt 0 ]] || { log_error "run: no command"; return 2; }
  local shown; shown="$(_quote_cmd "$@")"
  if is_test; then
    log_test "would run: $shown"
    [[ $use_stdin == 1 ]] && cat >/dev/null
    [[ -n "$sim_out" ]] && printf '%s\n' "$sim_out"
    return "$sim_rc"
  fi
  [[ $quiet == 1 ]] || printf '%s+ %s%s\n' "$C_DIM" "$(mask "$shown")" "$C_RESET" >&2
  _log_file_write "RUN   $shown"
  if [[ $use_stdin == 1 ]]; then "$@"; else "$@" </dev/null; fi
}

# as_owner CMD… — execute CMD (NOT via run: callers decide) as $REPO_OWNER,
# keeping the ssh agent. Used for ssh/git so the owner's keys/config apply.
as_owner() {
  if [[ $EUID -eq 0 && "$REPO_OWNER" != root ]]; then
    sudo -u "$REPO_OWNER" -H --preserve-env=SSH_AUTH_SOCK -- "$@"
  else
    "$@"
  fi
}

# run_as_owner [run opts] -- CMD… — a mutation executed as $REPO_OWNER.
run_as_owner() {
  local -a opts=()
  while [[ $# -gt 0 && "$1" != -- ]]; do opts+=("$1"); shift; done
  [[ "${1:-}" == -- ]] && shift
  if [[ $EUID -eq 0 && "$REPO_OWNER" != root ]]; then
    run "${opts[@]+"${opts[@]}"}" -- sudo -u "$REPO_OWNER" -H --preserve-env=SSH_AUTH_SOCK -- "$@"
  else
    run "${opts[@]+"${opts[@]}"}" -- "$@"
  fi
}

# write_file DEST MODE OWNER[:GROUP] [--secret|--env] [--no-backup]  <content
#   Writes stdin to DEST atomically (temp file + rename) with MODE/OWNER, after
#   backing the old file up under $BACKUP_DIR. No-op when content is identical.
#   --test: renders into $TEST_SANDBOX/fs/DEST and prints a unified diff
#   against the live file (--env masks values, --secret shows no content).
#   Sets WRITE_CHANGED=1 when the content differs from DEST.
write_file() {
  local dest="$1" mode="$2" owner="$3"; shift 3
  local show="diff" backup=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --secret) show="secret"; shift ;;
      --env) show="env"; shift ;;
      --no-backup) backup=0; shift ;;
      *) log_error "write_file: unknown option $1"; return 2 ;;
    esac
  done
  local user="${owner%%:*}" group="${owner#*:}"
  [[ "$owner" == *:* ]] || group="$(id -gn "$user" 2>/dev/null || echo "$user")"
  local tmp; tmp="$(mktemp "${TMPDIR:-/tmp}/apollo-write.XXXXXX")" || return 1
  cat >"$tmp"
  WRITE_CHANGED=0
  local current; current="$(live_file_path "$dest")"
  if [[ -f "$current" ]] && cmp -s "$tmp" "$current"; then
    rm -f "$tmp"; log_detail "unchanged: $dest"; return 0
  fi
  WRITE_CHANGED=1
  if is_test; then
    local sb="$TEST_SANDBOX/fs$dest"
    log_test "would write $dest (mode $mode, owner $user:$group)"
    # Diff BEFORE replacing the sandbox render: current may BE that render.
    _show_write_diff "$current" "$tmp" "$dest" "$show"
    mkdir -p "$(dirname "$sb")" && cp "$tmp" "$sb"
    rm -f "$tmp"
    return 0
  fi
  mkdir -p "$(dirname "$dest")" || { rm -f "$tmp"; return 1; }
  if [[ $backup == 1 && -f "$dest" ]]; then
    mkdir -p "$BACKUP_DIR$(dirname "$dest")" 2>/dev/null &&
      cp -a "$dest" "$BACKUP_DIR$dest" 2>/dev/null &&
      log_detail "backup: $BACKUP_DIR$dest"
  fi
  local staged="$dest.apollo-tmp.$$"
  if ! install -m "$mode" -o "$user" -g "$group" "$tmp" "$staged"; then
    rm -f "$tmp" "$staged"; log_error "write_file: could not stage $dest"; return 1
  fi
  rm -f "$tmp"
  sync -f "$staged" 2>/dev/null || true
  mv -f "$staged" "$dest" || { rm -f "$staged"; return 1; }
  log_detail "wrote $dest"
  _log_file_write "WRITE $dest"
  return 0
}

_show_write_diff() {
  local old="$1" new="$2" label="$3" show="$4"
  local oldf="$old"; [[ -f "$old" ]] || oldf=/dev/null
  if [[ "$show" == secret ]]; then
    log_detail "(secret content — $(wc -c <"$new") bytes, not shown)"
    return 0
  fi
  local d
  if [[ "$show" == env ]]; then
    d="$(diff -u --label "$label (live)" --label "$label (new)" \
          <(sed -E 's/^([[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=).*/\1****/' "$oldf") \
          <(sed -E 's/^([[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*=).*/\1****/' "$new") || true)"
  else
    d="$(diff -u --label "$label (live)" --label "$label (new)" "$oldf" "$new" || true)"
  fi
  local lines; lines="$(printf '%s\n' "$d" | wc -l)"
  printf '%s\n' "$d" | head -n 120 | while IFS= read -r l; do
    case "$l" in
      +*) printf '%s    %s%s\n' "$C_GREEN" "$(mask "$l")" "$C_RESET" ;;
      -*) printf '%s    %s%s\n' "$C_RED" "$(mask "$l")" "$C_RESET" ;;
      *)  printf '    %s\n' "$(mask "$l")" ;;
    esac
  done >&2
  (( lines > 120 )) && log_detail "… diff truncated ($lines lines; full render in $TEST_SANDBOX/fs$label)"
  return 0
}

# live_file_path DEST — the file holding DEST's current content for this run:
# the sandbox render once a --test step has "written" DEST; under fixtures
# $FIXTURES/fs/DEST (absent = the file doesn't exist) so the harness never
# reads the developer's real /etc; otherwise DEST itself.
live_file_path() {
  local dest="$1"
  if is_test && [[ -f "$TEST_SANDBOX/fs$dest" ]]; then printf '%s' "$TEST_SANDBOX/fs$dest"; return 0; fi
  if [[ -n "$FIXTURES" ]]; then printf '%s' "$FIXTURES/fs$dest"; return 0; fi
  printf '%s' "$dest"
}

# read_file PATH — print PATH as this run sees it (see live_file_path). rc 1 if absent.
read_file() {
  local p; p="$(live_file_path "$1")"
  [[ -f "$p" ]] || return 1
  cat "$p"
}

# fstab_text — /etc/fstab as this run sees it (see live_file_path).
fstab_text() { read_file /etc/fstab 2>/dev/null || true; }

# fstab_upsert MARKER LINE [--replace-target PATH]
#   Ensures /etc/fstab holds LINE tagged "# apollo-sfs:MARKER" (replacing an
#   older tagged line, or with --replace-target an untagged line mounting
#   PATH), then `systemctl daemon-reload`. NEVER mounts anything — callers start
#   the generated .mount unit themselves (see drives.sh).
fstab_upsert() {
  local marker="$1" line="$2" replace_target=""
  [[ "${3:-}" == --replace-target ]] && replace_target="$4"
  local tag="# apollo-sfs:$marker"
  local current; current="$(fstab_text)"
  local out="" l replaced=0
  while IFS= read -r l || [[ -n "$l" ]]; do
    if [[ "$l" == *"$tag" ]]; then
      [[ $replaced == 0 ]] && out+="$line  $tag"$'\n'; replaced=1; continue
    fi
    if [[ -n "$replace_target" && ! "$l" =~ ^[[:space:]]*# ]]; then
      local f2; f2="$(awk '{print $2}' <<<"$l")"
      if [[ "$f2" == "$replace_target" ]]; then
        [[ $replaced == 0 ]] && out+="# replaced by deploy.sh $(now_iso): $l"$'\n'"$line  $tag"$'\n'
        replaced=1; continue
      fi
    fi
    out+="$l"$'\n'
  done <<<"$current"
  [[ $replaced == 1 ]] || out+="$line  $tag"$'\n'
  printf '%s' "$out" | write_file /etc/fstab 0644 root:root || return 1
  if [[ $WRITE_CHANGED == 1 ]]; then run -- systemctl daemon-reload || return 1; fi
  return 0
}

# ensure_dir PATH [MODE] [OWNER[:GROUP]] — mkdir -p, then fix mode/owner if
# they differ (each change via run, so --test only prints it).
ensure_dir() {
  local p="$1" mode="${2:-}" owner="${3:-}"
  if [[ ! -d "$p" ]]; then
    run -- mkdir -p "$p" || return 1
    [[ -n "$mode" ]] && { run -- chmod "$mode" "$p" || return 1; }
    [[ -n "$owner" ]] && { run -- chown "$owner" "$p" || return 1; }
    return 0
  fi
  if [[ -n "$mode" && "$(stat -c %a "$p")" != "${mode#0}" ]]; then
    run -- chmod "$mode" "$p" || return 1
  fi
  if [[ -n "$owner" ]]; then
    local have; if [[ "$owner" == *:* ]]; then have="$(stat -c %U:%G "$p")"; else have="$(stat -c %U "$p")"; fi
    [[ "$have" == "$owner" ]] || { run -- chown "$owner" "$p" || return 1; }
  fi
  return 0
}

# ── Locking ──────────────────────────────────────────────────────────────────
# with_lock NAME [--wait SECONDS] [--] CMD… — flock a lock file around CMD.
#   NAME            → $LOCK_DIR/NAME.lock (node-local; /run/apollo-sfs is a
#                     non-sticky 0775 root:docker dir from tmpfiles.d)
#   cluster:NAME    → $CLUSTER_DIR/.locks/NAME.lock — shared between root runs
#                     on the manager and `_remote` ops running as the ssh user
#                     (both can open files in the repo-owned cluster/ dir).
# Opens the lock read-only (works whoever created it). Returns 4 when busy.
with_lock() {
  local name="$1"; shift
  local wait=0
  if [[ "${1:-}" == --wait ]]; then wait="$2"; shift 2; fi
  [[ "${1:-}" == -- ]] && shift
  local dir="$LOCK_DIR"
  if [[ "$name" == cluster:* ]]; then
    name="${name#cluster:}"
    if is_test; then dir="$TEST_SANDBOX/run"; else dir="$CLUSTER_DIR/.locks"; fi
  fi
  mkdir -p "$dir" 2>/dev/null || true
  local lf="$dir/$name.lock"
  [[ -e "$lf" ]] || ( umask 002; : >"$lf" ) 2>/dev/null || true
  local fd
  exec {fd}<"$lf" || { log_error "cannot open lock $lf"; return 4; }
  local -a fl=(-n); [[ "$wait" != 0 ]] && fl=(-w "$wait")
  if ! flock "${fl[@]}" "$fd"; then
    exec {fd}<&-
    log_error "another deploy.sh run holds $lf"
    return 4
  fi
  local rc=0
  "$@" || rc=$?
  exec {fd}<&-
  return "$rc"
}

# ── Privilege ────────────────────────────────────────────────────────────────
# need_root ORIGINAL_ARGS… — re-exec deploy.sh under sudo (keeping the ssh
# agent, TERM and APOLLO_* vars). No-op in --test or when already root.
need_root() {
  is_test && return 0
  [[ $EUID -eq 0 ]] && return 0
  cmd_exists sudo || die "This operation needs root and sudo is not installed."
  local keep="SSH_AUTH_SOCK,TERM,NO_COLOR" v
  while IFS= read -r v; do keep+=",$v"; done < <(compgen -e | grep '^APOLLO_' || true)
  log_info "Re-running with sudo…"
  exec sudo --preserve-env="$keep" -- "$APOLLO_ROOT/deploy.sh" "$@"
}

# ── Run-state store (planned values in --test, real results otherwise) ──────
state_set() { APOLLO_STATE["$1"]="$2"; }
state_get() {
  if [[ -n "${APOLLO_STATE[$1]+x}" ]]; then printf '%s' "${APOLLO_STATE[$1]}"; return 0; fi
  if [[ $# -ge 2 ]]; then printf '%s' "$2"; return 0; fi
  return 3
}
state_has() { [[ -n "${APOLLO_STATE[$1]+x}" ]]; }
state_unset() { unset 'APOLLO_STATE[$1]'; }

# ── node.json access (schema v1 — see docs/node_provisioning.md) ────────────
# node_json_exists — true if this run's node.json exists (sandbox copy in --test).
node_json_exists() { [[ -f "$NODE_JSON" ]]; }

# node_json_get KEY [DEFAULT] — dot-path read (e.g. deployment.cluster.role).
node_json_get() {
  [[ -f "$NODE_JSON" ]] || { [[ $# -ge 2 ]] && { printf '%s' "$2"; return 0; }; return 3; }
  if [[ $# -ge 2 ]]; then
    py json get --file "$NODE_JSON" --key "$1" --default "$2"
  else
    py json get --file "$NODE_JSON" --key "$1"
  fi
}

# node_json_merge OWNERKEY  <patch.json — deep-merge a JSON object into
# node.json[OWNERKEY] under the node lock (lists are replaced, not merged).
node_json_merge() {
  py json merge --file "$NODE_JSON" --owner "$1" --patch - --lock "$LOCK_DIR/node.lock"
}

# node_json_set KEY JSON_VALUE — set one dot-path key under the node lock.
node_json_set() {
  py json set --file "$NODE_JSON" --key "$1" --value "$2" --lock "$LOCK_DIR/node.lock"
}

# node_role — "manager" | "worker" | "" for this run (run-state first, then node.json).
node_role() {
  local r
  r="$(state_get role 2>/dev/null)" && [[ -n "$r" ]] && { printf '%s' "$r"; return 0; }
  node_json_get deployment.cluster.role "" 2>/dev/null || true
}

# deployment_valid [--quiet] — rc 0 when node.json holds a valid deployment
# (schema supported, deployment.last_success.revision >= 1); prints reasons.
deployment_valid() {
  local quiet=0; [[ "${1:-}" == --quiet ]] && quiet=1
  [[ -f "$NODE_JSON" ]] || { [[ $quiet == 1 ]] || log_warn "No node.json — this node has no recorded deployment."; return 5; }
  local out rc=0 kind msg
  out="$(py validate --file "$NODE_JSON" --hostname "$(this_hostname)" --text 2>/dev/null)" || rc=$?
  if [[ $rc -ne 0 && $quiet == 0 ]]; then
    log_warn "node.json does not hold a valid deployment:"
  fi
  if [[ $quiet == 0 ]]; then
    while IFS=' ' read -r kind msg; do
      case "$kind" in
        R) printf '    • %s\n' "$msg" >&2 ;;
        W) log_warn "$msg" ;;
      esac
    done <<<"$out"
  fi
  [[ $rc -eq 0 ]] || return 5
  return 0
}

# ── Alerts ───────────────────────────────────────────────────────────────────
_ack_preapproved() {
  local id="$1"
  [[ "$ACK_ALERTS" == all ]] && return 0
  [[ ",$ACK_ALERTS," == *",$id,"* ]]
}

# alert_ack LEVEL ID TITLE BODY [--retry] [--fix LABEL FN]
#   --fix adds an 'f' choice that runs FN (a repair, e.g. deleting a stale ssh
#   host key) and then returns 1 so the caller retries.
#   LEVEL: info|warn|crit. Shows a boxed alert that MUST be acknowledged.
#   Returns 0 when acknowledged, 1 when the user asked to retry (only offered
#   with --retry); exits 3 when the user quits. Non-interactive runs only
#   continue if the ID was pre-acknowledged with --ack=ID (or --ack=all).
alert_ack() {
  local level="$1" id="$2" title="$3" body="$4" retry=0 fix_label="" fix_fn=""
  shift 4
  while (($#)); do
    case "$1" in
      --retry) retry=1 ;;
      --fix) fix_label="$2"; fix_fn="$3"; shift 2 ;;
    esac
    shift
  done
  local col="$C_CYAN"; [[ $level == warn ]] && col="$C_YELLOW"; [[ $level == crit ]] && col="$C_RED"
  local bar; bar="$(printf '━%.0s' $(seq 1 70))"
  {
    printf '\n%s┏%s┓%s\n' "$col" "$bar" "$C_RESET"
    printf '%s┃ %s ALERT [%s]%s %s\n' "$col" "${level^^}" "$id" "$C_RESET" "$(mask "$title")"
    printf '%s┃%s\n' "$col" "$C_RESET"
    while IFS= read -r l; do printf '%s┃%s %s\n' "$col" "$C_RESET" "$(mask "$l")"; done <<<"$body"
    printf '%s┗%s┛%s\n' "$col" "$bar" "$C_RESET"
  } >&2
  _log_file_write "ALERT $level $id $title"
  if [[ "$NONINTERACTIVE" == 1 ]]; then
    if _ack_preapproved "$id"; then
      log_warn "alert $id auto-acknowledged (--ack)"
      ALERTS_ACKED+=("$(now_iso)|$level|$id|$title")
      return 0
    fi
    log_error "alert $id must be acknowledged; re-run interactively or pass --ack=$id"
    exit 3
  fi
  local ans prompt="Type 'ack' to acknowledge and continue"
  [[ $retry == 1 ]] && prompt+=", 'r' to retry"
  [[ -n "$fix_fn" ]] && prompt+=", 'f' to ${fix_label}"
  prompt+=", or 'q' to quit: "
  while true; do
    printf '%s%s%s' "$C_BOLD" "$prompt" "$C_RESET" >&2
    if ! _ui_read_line ans; then
      printf '\n' >&2
      if _ack_preapproved "$id"; then
        log_warn "alert $id auto-acknowledged (--ack)"
        ALERTS_ACKED+=("$(now_iso)|$level|$id|$title")
        return 0
      fi
      log_error "no input — alert $id was not acknowledged; aborting (pass --ack=$id to pre-acknowledge)"
      exit 3
    fi
    case "${ans,,}" in
      ack|acknowledge) ALERTS_ACKED+=("$(now_iso)|$level|$id|$title"); log_warn "acknowledged: $id"; return 0 ;;
      r|retry) [[ $retry == 1 ]] && return 1 ;;
      f|fix) if [[ -n "$fix_fn" ]]; then "$fix_fn" || log_warn "the repair did not complete"; return 1; fi ;;
      q|quit|exit) log_error "aborted at alert $id"; exit 3 ;;
    esac
  done
}

# ── Step framework ───────────────────────────────────────────────────────────
# step ID TITLE FN [--on manager|worker|any] [ARGS…]
#   FN returns 0 ok · 1 failed (→ alert_ack with retry) · 2 not applicable ·
#   3 deferred (recorded in DEFERRED_STEPS; the health step re-checks it).
#   On failure FN may set STEP_FAIL_REASON to a human explanation.
#   REMEMBER: `set -e` is OFF inside FN (it runs in an `||` list).
step() {
  local id="$1" title="$2" fn="$3"; shift 3
  local on=any
  if [[ "${1:-}" == --on ]]; then on="$2"; shift 2; fi
  STEP_INDEX=$((STEP_INDEX + 1))
  local hdr="[$STEP_INDEX/$STEP_TOTAL] $title"
  if [[ "$on" != any ]]; then
    local role; role="$(node_role)"
    if [[ "$role" != "$on" ]]; then
      printf '\n%s── %s %s(skipped — %s only)%s\n' "$C_DIM" "$hdr" "" "$on" "$C_RESET" >&2
      STEP_RESULTS[$id]="n/a"
      return 0
    fi
  fi
  printf '\n%s%s── %s %s%s\n' "$C_BOLD" "$C_BLUE" "$hdr" "$(printf '─%.0s' $(seq 1 $((60 - ${#hdr} > 3 ? 60 - ${#hdr} : 3))))" "$C_RESET" >&2
  CURRENT_STEP="$id"
  declare -F "$fn" >/dev/null || { log_error "internal: step function $fn is not defined"; return 1; }
  while true; do
    STEP_FAIL_REASON=""; STEP_FIX_FN=""; STEP_FIX_LABEL=""
    local rc=0
    "$fn" "$@" || rc=$?
    case "$rc" in
      0) STEP_RESULTS[$id]="ok"; log_ok "$title"; return 0 ;;
      2) STEP_RESULTS[$id]="n/a"; log_detail "$title — not applicable"; return 0 ;;
      3) STEP_RESULTS[$id]="deferred"; DEFERRED_STEPS+=("$id"); log_warn "$title — deferred (re-checked by the health step)"; return 0 ;;
      *)
        STEP_RESULTS[$id]="failed"
        _flow_record_failure "$id"
        local arc=0; local -a fixargs=()
        [[ -n "$STEP_FIX_FN" ]] && fixargs=(--fix "$STEP_FIX_LABEL" "$STEP_FIX_FN")
        alert_ack crit "step-$id" "Step failed: $title" \
          "${STEP_FAIL_REASON:-See the output above for details.}"$'\n'"Retrying re-runs this step; acknowledging continues with it marked failed." --retry "${fixargs[@]}" || arc=$?
        if [[ $arc -eq 1 ]]; then log_info "Retrying: $title"; continue; fi
        STEP_RESULTS[$id]="acknowledged-failure"
        return 0 ;;
    esac
  done
}

# flow_begin OP — record deployment.run = in_progress (real or sandbox node.json).
flow_begin() {
  RUN_OP="$1"
  STEP_INDEX=0
  local patch
  patch="{\"run\":{\"op\":$(json_escape "$1"),\"state\":\"in_progress\",\"run_id\":$(json_escape "$RUN_ID"),\"started_at\":$(json_escape "$(now_iso)"),\"failed_step\":null,\"test_mode\":$([[ $TEST_MODE == 1 ]] && echo true || echo false)}}"
  printf '%s' "$patch" | node_json_merge deployment >/dev/null 2>&1 || true
  _FLOW_OPEN=1
}

_flow_record_failure() {
  printf '{"run":{"failed_step":%s}}' "$(json_escape "$1")" | node_json_merge deployment >/dev/null 2>&1 || true
}

# flow_end OP — mark success: bump last_success.revision, flush acknowledged
# alerts, record step results.
flow_end() {
  local op="$1" rev
  rev="$(node_json_get deployment.last_success.revision 0 2>/dev/null || echo 0)"
  [[ "$rev" =~ ^[0-9]+$ ]] || rev=0
  local acks="[" first=1 a ts lvl id title
  for a in "${ALERTS_ACKED[@]+"${ALERTS_ACKED[@]}"}"; do
    IFS='|' read -r ts lvl id title <<<"$a"
    [[ $first == 1 ]] || acks+=","
    acks+="{\"at\":$(json_escape "$ts"),\"level\":$(json_escape "$lvl"),\"id\":$(json_escape "$id"),\"title\":$(json_escape "$title"),\"run_id\":$(json_escape "$RUN_ID")}"
    first=0
  done
  acks+="]"
  local steps="{" k f2=1
  for k in "${!STEP_RESULTS[@]}"; do
    [[ $f2 == 1 ]] || steps+=","
    steps+="$(json_escape "$k"):$(json_escape "${STEP_RESULTS[$k]}")"; f2=0
  done
  steps+="}"
  local outcome="succeeded"
  for k in "${!STEP_RESULTS[@]}"; do [[ "${STEP_RESULTS[$k]}" == acknowledged-failure ]] && outcome="succeeded-with-acknowledged-failures"; done
  printf '{"script_version":%s,"git_commit":%s,"last_success":{"revision":%d,"at":%s,"op":%s,"run_id":%s,"outcome":%s,"steps":%s},"run":{"state":"succeeded","finished_at":%s}}' \
    "$(json_escape "$SCRIPT_VERSION")" "$(json_escape "$(git -C "$APOLLO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)")" \
    "$((rev + 1))" "$(json_escape "$(now_iso)")" "$(json_escape "$op")" "$(json_escape "$RUN_ID")" \
    "$(json_escape "$outcome")" "$steps" "$(json_escape "$(now_iso)")" | node_json_merge deployment >/dev/null || true
  if [[ "$acks" != "[]" ]]; then
    py json append --file "$NODE_JSON" --key deployment.health.acknowledged_alerts --values "$acks" --lock "$LOCK_DIR/node.lock" >/dev/null 2>&1 || true
  fi
  _FLOW_OPEN=0
}

# flow_abort_trap [RC] — EXIT trap helper: mark an unfinished flow as failed
# (RC = the script's exit status, captured by the caller before anything
# else can overwrite $?).
flow_abort_trap() {
  local rc="${1:-$?}"
  if [[ "${_FLOW_OPEN:-0}" == 1 ]]; then
    printf '{"run":{"state":"failed","finished_at":%s,"exit_code":%d}}' "$(json_escape "$(now_iso)")" "$rc" |
      node_json_merge deployment >/dev/null 2>&1 || true
  fi
  return "$rc"
}

# ── Networking helpers shared by several libs ───────────────────────────────
# net_default_iface / net_lan_ip / net_lan_cidr — the interface carrying the
# default route, its primary IPv4, and that network's CIDR (e.g. 192.168.68.0/22).
net_default_iface() {
  probe ip-route-default -- ip -4 route show default | awk '/default/ {for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}'
}
net_lan_ip() {
  local ifc; ifc="${1:-$(net_default_iface)}"
  [[ -n "$ifc" ]] || return 1
  probe "ip-addr-$(probe_key "$ifc")" -- ip -4 -o addr show dev "$ifc" | awk '{print $4}' | head -n1 | cut -d/ -f1
}
net_lan_cidr() {
  local ifc cidr ip prefix
  ifc="${1:-$(net_default_iface)}"
  [[ -n "$ifc" ]] || return 1
  cidr="$(probe "ip-addr-$(probe_key "$ifc")" -- ip -4 -o addr show dev "$ifc" | awk '{print $4}' | head -n1)"
  [[ -n "$cidr" ]] || return 1
  py net-cidr "$cidr"
}

# ── Sandbox / init ───────────────────────────────────────────────────────────
# core_init — called once by deploy.sh after argument parsing.
core_init() {
  if is_test; then
    if [[ -z "$TEST_SANDBOX" ]]; then
      TEST_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/apollo-deploy-test.XXXXXX")" || die "cannot create test sandbox"
    fi
    mkdir -p "$TEST_SANDBOX"/{fs,run,ssh,log}
    # ssh runs as the repo owner (as_owner) even when deploy.sh runs as root:
    # it must traverse the sandbox to reach ssh/ (control socket, known_hosts).
    # Rendered files (fs/) may hold real secrets, so that subtree stays private.
    chmod 0711 "$TEST_SANDBOX"; chmod 0700 "$TEST_SANDBOX/fs" "$TEST_SANDBOX/log"; chmod 0777 "$TEST_SANDBOX/ssh"
    export TEST_SANDBOX APOLLO_TEST=1 APOLLO_TEST_SANDBOX="$TEST_SANDBOX"
    LOCK_DIR="$TEST_SANDBOX/run"
    BACKUP_DIR="$TEST_SANDBOX/backups"
    LOG_FILE="$TEST_SANDBOX/log/deploy.log"
    # Work on a sandbox copy of node.json so reads reflect reality but no write
    # can reach the device. --node-json PATH (test only) swaps in a fixture.
    local src="${TEST_NODE_JSON:-$NODE_JSON_REAL}"
    NODE_JSON="$TEST_SANDBOX/node.json"
    [[ -f "$src" ]] && cp "$src" "$NODE_JSON"
    : >"$LOG_FILE"
  else
    if [[ -z "$LOG_FILE" && $EUID -eq 0 ]]; then
      mkdir -p "$LOG_DIR" 2>/dev/null && LOG_FILE="$LOG_DIR/deploy-$RUN_ID.log" && : >"$LOG_FILE" 2>/dev/null || LOG_FILE=""
    fi
  fi
  export RUN_ID TEST_MODE NODE_JSON LOCK_DIR
}

# core_cleanup — EXIT handler: drop the sandbox unless --keep-sandbox.
core_cleanup() {
  if is_test && [[ -n "$TEST_SANDBOX" && -d "$TEST_SANDBOX" ]]; then
    if [[ "$KEEP_SANDBOX" == 1 ]]; then
      log_info "Test sandbox kept at: $TEST_SANDBOX"
    else
      rm -rf "$TEST_SANDBOX"
    fi
  fi
}
