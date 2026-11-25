#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/tests/run.sh — test harness for deploy.sh and its libraries.
#
#   scripts/deploy/tests/run.sh                 everything
#   scripts/deploy/tests/run.sh lint|python|unit|scenarios
#   T_VERBOSE=1 … run.sh scenarios              show full scenario output
#   T_KEEP=1 …                                  keep the harness workspace
#   SHELLCHECK=/path/to/shellcheck …            lint with shellcheck too
#   T_ONLY='20-*' …                             only scenario/unit files matching the glob
#
# Tiers:
#   lint       bash -n on every shell file (+ shellcheck when available)
#   python     python3 -I -B -m unittest for scripts/node-status (tests/python)
#   unit       tests/unit/test_*.sh — pure bash functions (allocation maths,
#              renderers, parsers); each test_* function runs in a subshell
#   scenarios  tests/scenarios/*.sh — hermetic `deploy.sh --test …` runs
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/tests/lib.sh
source "$HERE/lib.sh"
WHICH="${1:-all}"
rc_total=0

tier() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

run_lint() {
  tier "lint"
  local f bad=0
  while IFS= read -r f; do
    if ! bash -n "$f" 2>/tmp/apollo-lint.$$; then echo "  ✖ bash -n $f"; sed 's/^/      /' /tmp/apollo-lint.$$; bad=1; fi
  done < <(cd "$REPO_SRC" && { echo deploy.sh; find scripts/deploy -name '*.sh' -not -path '*/tests/shims/*'; find fail2ban db -name '*.sh'; } | sed "s|^|$REPO_SRC/|")
  rm -f /tmp/apollo-lint.$$
  local sc="${SHELLCHECK:-$(command -v shellcheck || true)}"
  if [[ -n "$sc" ]]; then
    ( cd "$REPO_SRC" && "$sc" -x -S warning -e SC1091,SC2034,SC2154 deploy.sh scripts/deploy/lib/*.sh scripts/deploy/flows/*.sh scripts/deploy/tests/*.sh ) || bad=1
  else
    echo "  (shellcheck not found — set SHELLCHECK=… to enable)"
  fi
  if [[ $bad == 0 ]]; then echo "  ✔ lint clean"; else rc_total=1; fi
}

run_python() {
  tier "python"
  if ! ls "$HERE"/python/test_*.py >/dev/null 2>&1; then echo "  (no python tests)"; return; fi
  local out prc=0
  out="$(cd "$HERE/python" && APOLLO_NODE_STATUS_DIR="$REPO_SRC/scripts/node-status" \
      python3 -B -m unittest discover -s . -p "${T_PY_PATTERN:-test_*.py}" -t . 2>&1)" || prc=$?
  printf '%s\n' "$out" | tail -n 30 | sed 's/^/  /'
  (( prc == 0 )) || rc_total=1
}

run_unit() {
  tier "unit"
  local f fn n_pass=0 n_fail=0
  shopt -s nullglob
  for f in "$HERE"/unit/test_*.sh; do
    # shellcheck disable=SC2053  # T_ONLY is a glob on purpose
    [[ -n "${T_ONLY:-}" && "$(basename "$f")" != $T_ONLY ]] && continue
    printf '  %s\n' "$(basename "$f")"
    while IFS= read -r fn; do
      if ( export APOLLO_ROOT="$REPO_SRC" TEST_MODE=1 NO_COLOR=1
           TMPDIR="$(mktemp -d)"; cd "$TMPDIR" || exit 1
           # shellcheck source=/dev/null
           source "$REPO_SRC/scripts/deploy/lib/core.sh"
           # shellcheck source=/dev/null
           source "$REPO_SRC/scripts/deploy/lib/ui.sh"
           # shellcheck source=/dev/null
           source "$REPO_SRC/scripts/deploy/lib/undo.sh"
           # shellcheck source=/dev/null
           source "$f"
           exec 3</dev/null
           core_init >/dev/null 2>&1
           "$fn" ) >/tmp/apollo-unit.$$ 2>&1; then
        n_pass=$((n_pass + 1)); printf '    ✔ %s\n' "$fn"
      else
        n_fail=$((n_fail + 1)); printf '    \033[31m✖ %s\033[0m\n' "$fn"; sed 's/^/        /' /tmp/apollo-unit.$$ | tail -n 15
      fi
    done < <(grep -oE '^test_[A-Za-z0-9_]+\(\)' "$f" | tr -d '()')
  done
  rm -f /tmp/apollo-unit.$$
  echo "  unit: $n_pass passed, $n_fail failed"
  (( n_fail == 0 )) || rc_total=1
}

run_scenarios() {
  tier "scenarios"
  t_workspace_init
  trap t_workspace_cleanup EXIT
  local f
  shopt -s nullglob
  for f in "$HERE"/scenarios/*.sh; do
    # shellcheck disable=SC2053  # T_ONLY is a glob on purpose
    [[ -n "${T_ONLY:-}" && "$(basename "$f")" != $T_ONLY ]] && continue
    # shellcheck source=/dev/null
    source "$f"
  done
  echo "  scenarios: $T_PASSES passed, $T_FAILS failed${T_FAILED_NAMES[*]:+ (${T_FAILED_NAMES[*]})}"
  (( T_FAILS == 0 )) || rc_total=1
}

case "$WHICH" in
  all) run_lint; run_python; run_unit; run_scenarios ;;
  lint) run_lint ;;
  python) run_python ;;
  unit) run_unit ;;
  scenarios) run_scenarios ;;
  *) echo "usage: $0 [all|lint|python|unit|scenarios]" >&2; exit 2 ;;
esac
exit "$rc_total"
