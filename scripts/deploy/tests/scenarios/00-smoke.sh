# shellcheck shell=bash
# 00-smoke — dispatcher basics: help, legacy-flag routing, restart/update refused
# without node.json, a full `deploy --test` walk stays hermetic.

_fx() {  # _fx NAME — build a fixture dir from common/ + fixtures/NAME
  local d="$T_WS/fx-$1"
  rm -rf "$d"; mkdir -p "$d"
  cp -a "$HARNESS_DIR/fixtures/common/." "$d/" 2>/dev/null || true
  [[ -d "$HARNESS_DIR/fixtures/$1" ]] && cp -a "$HARNESS_DIR/fixtures/$1/." "$d/"
  chmod -R a+rX "$d"
  printf '%s' "$d"
}
_answers() {  # _answers LINE… — write an answers file, print its path
  local f; f="$(mktemp "$T_WS/answers.XXXXXX")"
  printf '%s\n' "$@" >"$f"; chmod 0644 "$f"
  printf '%s' "$f"
}

smoke_help() {
  t_run "$(_fx smoke-wsl)" "$(_answers)" -- --help
  t_assert_rc 0
  t_assert_out_contains "./deploy.sh restart"
}
smoke_restart_refused() {
  t_run "$(_fx smoke-wsl)" "$(_answers)" -- --test restart
  t_assert_rc 5
  t_assert_out_contains "needs a valid deployment"
  t_assert_hermetic
}
smoke_update_refused() {
  t_run "$(_fx smoke-wsl)" "$(_answers)" -- update --test
  t_assert_rc 5
  t_assert_hermetic
}
smoke_real_mode_needs_no_fixtures() {
  t_run "$(_fx smoke-wsl)" "$(_answers)" -- deploy
  t_assert_rc 2
  t_assert_out_contains "only allowed together with --test"
}
smoke_menu_disables_restart() {
  t_run "$(_fx smoke-wsl)" "$(_answers restart quit)" -- --test
  t_assert_out_contains "restart  — restart this node's services + health check (unavailable"
  t_assert_rc 0
  t_assert_hermetic
}

t_scenario "smoke: --help" smoke_help
t_scenario "smoke: restart refused without node.json" smoke_restart_refused
t_scenario "smoke: update refused without node.json" smoke_update_refused
t_scenario "smoke: fixtures refused outside --test" smoke_real_mode_needs_no_fixtures
t_scenario "smoke: menu disables restart/update" smoke_menu_disables_restart
