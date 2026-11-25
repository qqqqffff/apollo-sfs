# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/lib/remote.sh — worker → manager RPC over SSH (WS0 contract).
#
# Swarm workers cannot run `docker service|node|stack`, so anything that needs
# the manager is executed ON the manager by its own deploy.sh:
#
#   worker:  mgr register-node --in node.json
#     └─ ssh <owner>@<manager> <repo>/deploy.sh _remote register-node --proto 1 [--test]
#   manager: remote_main → remote_op_register_node → JSON envelope on stdout
#
# Envelope (stdout of `_remote`, one JSON object):
#   {"proto":1,"op":"<op>","ok":true,"host":"<manager hostname>","test":false,"data":{…}}
#   {"proto":1,"op":"<op>","ok":false,"host":"…","error":{"code":"…","message":"…"}}
# Ops log human output to STDERR (relayed to the worker's terminal, prefixed
# "[manager]") and print their `data` JSON to STDOUT. Streaming ops (raw bytes,
# e.g. handover-export tar streams) skip the envelope.
#
# _remote ops run as the SSH user (a docker-group member) — NEVER via sudo.
# Mutating ops must honour --test (TEST_MODE=1) exactly like local steps.
#
# Adding an op: define `remote_op_<name with - → _>` in your lib. It receives
# the CLI args after the op name; the JSON request (if any) is in $REMOTE_REQ
# (read it with remote_req KEY [DEFAULT]). Fail with `remote_fail CODE MSG`.
# ─────────────────────────────────────────────────────────────────────────────

[[ -n "${_APOLLO_REMOTE_LOADED:-}" ]] && return 0
_APOLLO_REMOTE_LOADED=1

MGR_HOST="${MGR_HOST:-}"       # manager LAN address (no port)
MGR_USER="${MGR_USER:-}"       # ssh user on the manager (its repo owner)
MGR_REPO="${MGR_REPO:-}"       # repo path on the manager
MGR_RESPONSE=""                # last envelope received by mgr
SSH_CTL_DIR=""
declare -ga SSH_OPTS=()
REMOTE_STREAM_OPS=" handover-export "

# ── Client side ──────────────────────────────────────────────────────────────
# remote_context_load — fill MGR_* from node.json (restart/update) unless set.
remote_context_load() {
  local addr
  if [[ -z "$MGR_HOST" ]]; then
    addr="$(node_json_get deployment.cluster.manager.addr "" 2>/dev/null)"
    MGR_HOST="${addr%%:*}"
  fi
  [[ -n "$MGR_USER" ]] || MGR_USER="$(node_json_get deployment.cluster.ssh_user "$REPO_OWNER" 2>/dev/null)"
  [[ -n "$MGR_REPO" ]] || MGR_REPO="$(node_json_get deployment.cluster.repo_path "$APOLLO_ROOT" 2>/dev/null)"
  return 0
}

# ssh_prepare — build SSH_OPTS. Host keys must already be trusted (the
# membership step confirms the fingerprint first); in --test, known_hosts and
# the control socket live in the sandbox so nothing under ~/.ssh is touched.
ssh_prepare() {
  local kh=""
  if is_test; then
    SSH_CTL_DIR="$TEST_SANDBOX/ssh"
    mkdir -p "$SSH_CTL_DIR" && chmod 0777 "$SSH_CTL_DIR"
    kh="$SSH_CTL_DIR/known_hosts"
    if [[ ! -f "$kh" ]]; then
      local home; home="$(getent passwd "$REPO_OWNER" | cut -d: -f6)"
      if [[ -r "$home/.ssh/known_hosts" ]]; then cp "$home/.ssh/known_hosts" "$kh"; else : >"$kh"; fi
      chmod 0666 "$kh"
    fi
  else
    SSH_CTL_DIR="${LOCK_DIR}/ssh"
    if [[ $EUID -eq 0 ]]; then
      mkdir -p "$SSH_CTL_DIR" 2>/dev/null && chmod 0700 "$SSH_CTL_DIR" && chown "$REPO_OWNER" "$SSH_CTL_DIR" 2>/dev/null || true
    else
      mkdir -p "$SSH_CTL_DIR" 2>/dev/null || SSH_CTL_DIR="${TMPDIR:-/tmp}"
    fi
  fi
  SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
            -o StrictHostKeyChecking=yes -o "ControlPath=$SSH_CTL_DIR/%C" -o ControlMaster=no)
  [[ -n "$kh" ]] && SSH_OPTS+=(-o "UserKnownHostsFile=$kh")
  return 0
}

# ssh_master_start — open a persistent master connection (explicitly, never
# from inside $(…) where a backgrounded master could hold the pipe open).
ssh_master_start() {
  [[ -n "$FIXTURES" ]] && return 0
  [[ -n "$MGR_HOST" ]] || return 1
  ((${#SSH_OPTS[@]})) || ssh_prepare
  as_owner ssh "${SSH_OPTS[@]/ControlMaster=no/ControlMaster=yes}" -o ControlPersist=600 -fN \
    "$MGR_USER@$MGR_HOST" </dev/null >/dev/null 2>&1
}

# ssh_master_start_password — like ssh_master_start but authenticates with the
# manager user's password (asked on the terminal, once). Later mgr calls reuse
# the control socket, so no key has to be installed. Nothing is written to
# ~/.ssh: the socket lives in $SSH_CTL_DIR (the sandbox in --test).
ssh_master_start_password() {
  [[ -n "$MGR_HOST" ]] || return 1
  ((${#SSH_OPTS[@]})) || ssh_prepare
  local -a o=()
  local x
  for x in "${SSH_OPTS[@]}"; do [[ "$x" == BatchMode=yes ]] && x=BatchMode=no; o+=("${x/ControlMaster=no/ControlMaster=yes}"); done
  log_info "Enter the password for $MGR_USER@$MGR_HOST when prompted (used once to open a session; nothing is stored)."
  as_owner ssh "${o[@]}" -o PreferredAuthentications=password,keyboard-interactive \
    -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=3 -o ControlPersist=600 -fN \
    "$MGR_USER@$MGR_HOST" </dev/tty
}

ssh_master_stop() {
  [[ -n "$FIXTURES" ]] && return 0
  [[ -n "$MGR_HOST" && ${#SSH_OPTS[@]} -gt 0 ]] || return 0
  as_owner ssh "${SSH_OPTS[@]}" -O exit "$MGR_USER@$MGR_HOST" </dev/null >/dev/null 2>&1 || true
}

# ssh_hostkey_reset — forget the manager's saved host key (known_hosts entry
# and any control socket) so the next attempt re-verifies its fingerprint.
ssh_hostkey_reset() {
  local host="${MGR_HOST:-}" home kh
  [[ -n "$host" ]] || { log_error "no manager address known"; return 1; }
  home="$(getent passwd "$REPO_OWNER" | cut -d: -f6)"
  kh="$home/.ssh/known_hosts"; is_test && kh="${SSH_CTL_DIR:-$TEST_SANDBOX/ssh}/known_hosts"
  ssh_master_stop
  log_info "Deleting the saved ssh host key for $host from $kh …"
  run_as_owner -- ssh-keygen -R "$host" -f "$kh" || true
  run_as_owner -- rm -f "$kh.old" || true
  log_ok "Saved host key removed — you will be asked to verify the fingerprint again."
  return 0
}

# ssh_hostkey_changed — rc 0 when ssh refuses the manager because the saved
# host key no longer matches (reinstalled OS, new SD card, …).
ssh_hostkey_changed() {
  [[ -n "$FIXTURES" || -z "$MGR_HOST" ]] && return 1
  ((${#SSH_OPTS[@]})) || ssh_prepare
  local out
  out="$(as_owner ssh "${SSH_OPTS[@]}" "$MGR_USER@$MGR_HOST" -- true </dev/null 2>&1 || true)"
  [[ "$out" == *"HOST IDENTIFICATION HAS CHANGED"* || "$out" == *"Host key verification failed"* ]]
}

# mgr_reachable — rc 0 if we can run commands on the manager over ssh.
mgr_reachable() {
  if [[ -n "$FIXTURES" ]]; then probe mgr-reachable -- false >/dev/null; return $?; fi
  [[ -n "$MGR_HOST" ]] || return 1
  ((${#SSH_OPTS[@]})) || ssh_prepare
  as_owner ssh "${SSH_OPTS[@]}" "$MGR_USER@$MGR_HOST" -- true </dev/null >/dev/null 2>&1
}

# mgr OP [--in FILE|-] [--stream] [--quiet] [--] [ARGS…]
#   Runs `deploy.sh _remote OP` on the manager. The JSON request is read from
#   FILE (or this function's stdin with "-"); without --in the remote stdin is
#   empty. On return MGR_RESPONSE holds the envelope. --stream sends the raw
#   remote stdout to our stdout instead (no envelope).
#   rc: 0 ok · 1 op error (logged) · 6 protocol mismatch · 255 ssh failure.
mgr() {
  local op="$1"; shift
  local input="" stream=0 quiet=0 rc=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --in) input="$2"; shift 2 ;;
      --stream) stream=1; shift ;;
      --quiet) quiet=1; shift ;;
      --) shift; break ;;
      *) break ;;
    esac
  done
  MGR_RESPONSE=""
  if [[ -n "$FIXTURES" ]] && { [[ -f "$FIXTURES/mgr-$op" || -f "$FIXTURES/mgr-$op.rc" ]] || [[ "$FIXTURES_STRICT" == 1 ]]; }; then
    # Fixture mode (test harness): replay $FIXTURES/mgr-<op> as the envelope
    # and keep every request under $TEST_SANDBOX/mgr-requests/ so scenarios
    # can assert what this node would have sent to the manager.
    if [[ -n "$TEST_SANDBOX" ]]; then
      mkdir -p "$TEST_SANDBOX/mgr-requests"
      local reqf; reqf="$TEST_SANDBOX/mgr-requests/$op.$(date +%s%N).json"
      if [[ -n "$input" && "$input" != - ]]; then cp "$input" "$reqf"
      elif [[ "$input" == - ]]; then cat >"$reqf"
      else printf '{}' >"$reqf"; fi
    fi
    MGR_RESPONSE="$(probe "mgr-$op" -- false)" || rc=$?
    if [[ $stream == 1 ]]; then printf '%s' "$MGR_RESPONSE"; return "$rc"; fi
  else
    [[ -n "$MGR_HOST" && -n "$MGR_USER" && -n "$MGR_REPO" ]] || { log_error "mgr: manager address/user/repo unknown"; return 1; }
    ((${#SSH_OPTS[@]})) || ssh_prepare
    local rcmd a q
    printf -v rcmd '%q _remote %q --proto %q' "$MGR_REPO/deploy.sh" "$op" "$PROTO"
    is_test && rcmd+=" --test"
    for a in "$@"; do printf -v q '%q' "$a"; rcmd+=" $q"; done
    local -a sshcmd=(ssh "${SSH_OPTS[@]}" "$MGR_USER@$MGR_HOST" -- "$rcmd")
    if [[ $stream == 1 ]]; then
      if [[ "$input" == - ]]; then as_owner "${sshcmd[@]}" 2> >(_mgr_relay) || rc=$?
      elif [[ -n "$input" ]]; then as_owner "${sshcmd[@]}" <"$input" 2> >(_mgr_relay) || rc=$?
      else as_owner "${sshcmd[@]}" </dev/null 2> >(_mgr_relay) || rc=$?; fi
      return "$rc"
    fi
    if [[ "$input" == - ]]; then MGR_RESPONSE="$(as_owner "${sshcmd[@]}" 2> >(_mgr_relay))" || rc=$?
    elif [[ -n "$input" ]]; then MGR_RESPONSE="$(as_owner "${sshcmd[@]}" <"$input" 2> >(_mgr_relay))" || rc=$?
    else MGR_RESPONSE="$(as_owner "${sshcmd[@]}" </dev/null 2> >(_mgr_relay))" || rc=$?; fi
  fi
  if [[ $rc -eq 255 ]]; then
    [[ $quiet == 1 ]] || log_error "Cannot reach the manager over ssh (${MGR_USER:-?}@${MGR_HOST:-?})."
    STEP_FIX_FN=ssh_hostkey_reset; STEP_FIX_LABEL="delete the saved ssh host key and reconnect"
    return 255
  fi
  _envelope_check "$op" "$quiet" "$rc"
}

# _envelope_check OP QUIET RC — validate MGR_RESPONSE; rc 0 ok / 1 / 6.
_envelope_check() {
  local op="$1" quiet="$2" rc="$3"
  if [[ -z "$MGR_RESPONSE" ]] || ! printf '%s' "$MGR_RESPONSE" | py json check --file - 2>/dev/null; then
    [[ $quiet == 1 ]] || log_error "Manager returned no valid response for '$op' (rc $rc). Is deploy.sh on the manager up to date?"
    return 1
  fi
  local ok code msg
  ok="$(printf '%s' "$MGR_RESPONSE" | json_get ok false)"
  if [[ "$ok" != true ]]; then
    code="$(printf '%s' "$MGR_RESPONSE" | json_get error.code unknown)"
    msg="$(printf '%s' "$MGR_RESPONSE" | json_get error.message "")"
    [[ $quiet == 1 ]] || log_error "Manager op '$op' failed [$code]: $msg"
    [[ "$code" == proto_mismatch ]] && return 6
    return 1
  fi
  return 0
}

# cluster_call OP [--in FILE|-] [--quiet] [--] [ARGS…]
#   Run a manager op wherever it has to run: directly in-process (subshell) when
#   THIS node is the manager, else via `mgr` over ssh. Same contract as mgr:
#   envelope in MGR_RESPONSE (read with mgr_data), rc 0 / 1 / 6 / 255.
#   Libraries should call cluster_call rather than mgr unless they specifically
#   need the old manager during a handover.
cluster_call() {
  local op="$1"; shift
  if [[ "$(node_role)" != manager ]] || state_has force_remote_manager; then
    mgr "$op" "$@"
    return $?
  fi
  local input="" quiet=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --in) input="$2"; shift 2 ;;
      --quiet) quiet=1; shift ;;
      --) shift; break ;;
      *) break ;;
    esac
  done
  local req="{}"
  if [[ "$input" == - ]]; then req="$(cat)"; elif [[ -n "$input" ]]; then req="$(cat "$input")"; fi
  [[ -n "${req//[[:space:]]/}" ]] || req="{}"
  local rc=0
  MGR_RESPONSE="$(REMOTE_REQ="$req" remote_main "$op" --proto "$PROTO" "$@")" || rc=$?
  _envelope_check "$op" "$quiet" "$rc"
}

_mgr_relay() { sed -u 's/^/    [manager] /' >&2; }

# mgr_data KEY [DEFAULT] — read data.KEY from the last envelope.
mgr_data() {
  if [[ $# -ge 2 ]]; then printf '%s' "$MGR_RESPONSE" | json_get "data.$1" "$2"
  else printf '%s' "$MGR_RESPONSE" | json_get "data.$1"; fi
}

# ── Server side ──────────────────────────────────────────────────────────────
REMOTE_REQ="{}"
REMOTE_OP=""
REMOTE_ERR_CODE=""
REMOTE_ERR_MSG=""
REMOTE_ERR_FILE=""

# remote_fail CODE MESSAGE — record an op error (returns 1 for `|| return`).
remote_fail() {
  REMOTE_ERR_CODE="$1"; REMOTE_ERR_MSG="$2"
  # Ops run in a subshell (their stdout is captured): hand the error over in a file.
  [[ -n "$REMOTE_ERR_FILE" ]] && printf '%s\n%s' "$1" "$2" >"$REMOTE_ERR_FILE"
  log_error "$2"
  return 1
}

# remote_req KEY [DEFAULT] — read KEY from the JSON request body.
remote_req() {
  if [[ $# -ge 2 ]]; then printf '%s' "$REMOTE_REQ" | json_get "$1" "$2"
  else printf '%s' "$REMOTE_REQ" | json_get "$1"; fi
}

# remote_req_to_file — write the request body to a temp file, print its path.
remote_req_to_file() {
  local f; f="$(mktemp "${TMPDIR:-/tmp}/apollo-remote-req.XXXXXX")" || return 1
  printf '%s' "$REMOTE_REQ" >"$f"
  printf '%s' "$f"
}

_remote_envelope_ok() {
  printf '{"proto":%d,"op":%s,"ok":true,"host":%s,"test":%s,"data":%s}\n' \
    "$PROTO" "$(json_escape "$REMOTE_OP")" "$(json_escape "$(hostname)")" \
    "$([[ $TEST_MODE == 1 ]] && echo true || echo false)" "$1"
}
_remote_envelope_err() {
  printf '{"proto":%d,"op":%s,"ok":false,"host":%s,"test":%s,"error":{"code":%s,"message":%s}}\n' \
    "$PROTO" "$(json_escape "$REMOTE_OP")" "$(json_escape "$(hostname)")" \
    "$([[ $TEST_MODE == 1 ]] && echo true || echo false)" "$(json_escape "$1")" "$(json_escape "$2")"
}

# _remote_extract_reply — stdin: an op's stdout polluted by other commands.
# Prints the last JSON object that starts a line; everything else → stderr.
# rc 1 when there is none.
_remote_extract_reply() {
  python3 -I -c '
import json, re, sys
text, dec, pos, found = sys.stdin.read(), json.JSONDecoder(), 0, None
for m in re.finditer(r"^\{", text, re.M):
    if m.start() < pos:
        continue
    try:
        obj, end = dec.raw_decode(text, m.start())
    except ValueError:
        continue
    found, pos = (m.start(), end, obj), end
if found is None:
    sys.exit(1)
for line in (text[:found[0]] + "\n" + text[found[1]:]).splitlines():
    if line.strip():
        print(line, file=sys.stderr)
print(json.dumps(found[2]))'
}

# remote_main OP [--proto N] [ARGS…] — entry point for `deploy.sh _remote`.
# (--test is consumed by deploy.sh's global flag parsing before this runs.)
remote_main() {
  REMOTE_OP="${1:-}"; shift || true
  local peer_proto="$PROTO"
  local -a args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --proto) peer_proto="$2"; shift 2 ;;
      *) args+=("$1"); shift ;;
    esac
  done
  if [[ -z "$REMOTE_OP" ]]; then _remote_envelope_err usage "no op given"; return 2; fi
  if ! [[ "$peer_proto" =~ ^[0-9]+$ ]] || (( peer_proto < PROTO_MIN || peer_proto > PROTO )); then
    _remote_envelope_err proto_mismatch "peer speaks protocol $peer_proto; this manager accepts $PROTO_MIN–$PROTO (update deploy.sh on the older node)"
    return 6
  fi
  local fn="remote_op_${REMOTE_OP//-/_}"
  if ! declare -F "$fn" >/dev/null; then
    _remote_envelope_err unknown_op "unknown _remote op '$REMOTE_OP' (manager deploy.sh $SCRIPT_VERSION)"
    return 2
  fi
  if [[ "$REMOTE_STREAM_OPS" == *" $REMOTE_OP "* ]]; then
    "$fn" "${args[@]+"${args[@]}"}"
    return $?
  fi
  local data rc=0
  REMOTE_ERR_CODE=""; REMOTE_ERR_MSG=""
  REMOTE_ERR_FILE="$(mktemp "${TMPDIR:-/tmp}/apollo-remote-err.XXXXXX" 2>/dev/null || true)"
  data="$("$fn" "${args[@]+"${args[@]}"}")" || rc=$?
  if [[ -n "$REMOTE_ERR_FILE" ]]; then
    if [[ -s "$REMOTE_ERR_FILE" ]]; then
      REMOTE_ERR_CODE="$(head -n1 "$REMOTE_ERR_FILE")"; REMOTE_ERR_MSG="$(tail -n +2 "$REMOTE_ERR_FILE")"
    fi
    rm -f "$REMOTE_ERR_FILE"; REMOTE_ERR_FILE=""
  fi
  if [[ $rc -ne 0 ]]; then
    [[ -n "$data" && "$REMOTE_OP" != join-token ]] && printf '%s\n' "$data" >&2
    _remote_envelope_err "${REMOTE_ERR_CODE:-op_failed}" "${REMOTE_ERR_MSG:-op $REMOTE_OP failed (rc $rc)}"
    return 1
  fi
  [[ -n "${data//[[:space:]]/}" ]] || data="{}"
  if ! printf '%s' "$data" | py json check --file - >/dev/null 2>&1; then
    # A command inside the op wrote to stdout. The work is done by now, so keep
    # the reply and send the stray lines to the log instead of failing the op.
    local clean
    if ! clean="$(printf '%s' "$data" | _remote_extract_reply)"; then
      [[ "$REMOTE_OP" == join-token ]] || printf '%s\n' "$data" >&2
      _remote_envelope_err bad_data "op $REMOTE_OP produced invalid JSON (its output is in the log above)"
      return 1
    fi
    data="$clean"
  fi
  _remote_envelope_ok "$data"
  return 0
}
