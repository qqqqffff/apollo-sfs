# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/tests/lib.sh — harness helpers (sourced by run.sh).
#
# Hermetic scenario runs:
#   * a READ-ONLY copy of the repo (no .env, no data) in a temp workspace;
#   * run as `nobody` (when the harness runs as root) with HOME read-only and
#     TMPDIR the only writable place → any write outside the --test sandbox fails;
#   * PATH shims (tests/shims) record any mutating command or any read-only
#     command called without `probe` → the scenario fails;
#   * probes replay fixtures strictly (APOLLO_FIXTURES_STRICT=1); missing
#     fixture keys are reported.
# ─────────────────────────────────────────────────────────────────────────────

HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SRC="$(cd "$HARNESS_DIR/../../.." && pwd)"
T_WS=""
T_OUT=""
T_RC=0
T_PASSES=0
T_FAILS=0
T_CURRENT=""
declare -a T_FAILED_NAMES=()

t_workspace_init() {
  T_WS="$(mktemp -d "${TMPDIR:-/tmp}/apollo-harness.XXXXXX")"
  chmod 0755 "$T_WS"
  mkdir -p "$T_WS/repo" "$T_WS/home" "$T_WS/tmp"
  local p
  for p in deploy.sh docker-stack.yml scripts nginx fail2ban db keycloak docs .gitignore; do
    [[ -e "$REPO_SRC/$p" ]] && cp -a "$REPO_SRC/$p" "$T_WS/repo/"
  done
  chmod 1777 "$T_WS/tmp"
  chmod -R a-w "$T_WS/repo" "$T_WS/home"
}

t_workspace_cleanup() {
  [[ -n "$T_WS" && -d "$T_WS" ]] || return 0
  if [[ "${T_KEEP:-0}" == 1 ]]; then echo "harness workspace kept: $T_WS"; return 0; fi
  chmod -R u+w "$T_WS" 2>/dev/null
  rm -rf "$T_WS"
}

# t_run FIXTURE_DIR ANSWERS_FILE [--as-root] -- deploy.sh ARGS…
t_run() {
  local fixtures="$1" answers="$2"; shift 2
  local as_root=0
  [[ "${1:-}" == --as-root ]] && { as_root=1; shift; }
  [[ "${1:-}" == -- ]] && shift
  : >"$T_WS/shim.log"; : >"$T_WS/missing.log"
  chmod 0666 "$T_WS/shim.log" "$T_WS/missing.log"
  local -a envv=(env -i
    PATH="$HARNESS_DIR/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    HOME="$T_WS/home" TMPDIR="$T_WS/tmp" TERM=dumb NO_COLOR=1 LANG=C.UTF-8 LC_ALL=C.UTF-8
    SHIM_LOG="$T_WS/shim.log" APOLLO_UI_INPUT=lines
    APOLLO_DEPLOY_FIXTURES="$fixtures" APOLLO_FIXTURES_STRICT=1
    APOLLO_FIXTURE_MISSING_LOG="$T_WS/missing.log")
  local -a asuser=()
  if [[ $EUID -eq 0 && $as_root == 0 ]]; then
    asuser=(setpriv --reuid=65534 --regid=65534 --clear-groups --)
  fi
  T_RC=0
  T_OUT="$("${asuser[@]}" "${envv[@]}" bash "$T_WS/repo/deploy.sh" "$@" <"$answers" 2>&1)" || T_RC=$?
  [[ "${T_VERBOSE:-0}" == 1 ]] && printf '%s\n' "$T_OUT" | sed 's/^/      │ /'
  return 0
}

_t_fail() {
  printf '    \033[31m✖ %s\033[0m\n' "$*"
  T_SCENARIO_OK=0
}

t_assert_rc() {
  [[ "$T_RC" == "$1" ]] || _t_fail "exit code $T_RC, expected $1"
}
t_assert_out_contains() {
  grep -qF -- "$1" <<<"$T_OUT" || _t_fail "output does not contain: $1"
}
t_assert_out_matches() {
  grep -qE -- "$1" <<<"$T_OUT" || _t_fail "output does not match /$1/"
}
t_assert_out_not_contains() {
  if grep -qF -- "$1" <<<"$T_OUT"; then _t_fail "output unexpectedly contains: $1"; fi
}
t_assert_hermetic() {
  if [[ -s "$T_WS/shim.log" ]]; then
    _t_fail "commands escaped the --test guard:"
    sed 's/^/        /' "$T_WS/shim.log"
  fi
  if [[ -s "$T_WS/missing.log" ]]; then
    _t_fail "probes without fixtures: $(sort -u "$T_WS/missing.log" | tr '\n' ' ')"
  fi
  if grep -q '\[harness shim\]' <<<"$T_OUT"; then _t_fail "a shim fired (see output)"; fi
}

# t_scenario NAME FN — run one scenario function, print pass/fail.
t_scenario() {
  local name="$1" fn="$2"
  T_CURRENT="$name"; T_SCENARIO_OK=1
  printf '  • %s\n' "$name"
  "$fn"
  if [[ $T_SCENARIO_OK == 1 ]]; then
    T_PASSES=$((T_PASSES + 1))
  else
    T_FAILS=$((T_FAILS + 1)); T_FAILED_NAMES+=("$name")
    if [[ "${T_VERBOSE:-0}" != 1 ]]; then
      printf '      last output (tail):\n'
      printf '%s\n' "$T_OUT" | tail -n 25 | sed 's/^/      │ /'
    fi
  fi
}
