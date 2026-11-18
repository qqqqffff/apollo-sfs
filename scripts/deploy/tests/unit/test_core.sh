# shellcheck shell=bash
# Unit tests for the WS0 foundation (core.sh / ui.sh). Each test_* runs in its
# own subshell with core+ui sourced, TEST_MODE=1 and a fresh sandbox.

_answers() { exec 3< <(printf '%s\n' "$@"); UI_TTY=0; }
_eq() { [[ "$1" == "$2" ]] || { echo "expected [$2] got [$1]"; return 1; }; }

test_fmt_bytes() {
  _eq "$(fmt_bytes 100000000000)" "100 GB" &&
  _eq "$(fmt_bytes 3200000000000)" "3.2 TB" &&
  _eq "$(fmt_bytes 8001563222016)" "8 TB" &&
  _eq "$(fmt_bytes 999)" "999 B" &&
  _eq "$(fmt_bytes 1500000)" "1.5 MB" &&
  _eq "$(fmt_bytes 0)" "0 B"
}

test_json_escape() {
  _eq "$(json_escape 'a"b\c')" '"a\"b\\c"' &&
  _eq "$(json_escape $'x\ny')" '"x\ny"' &&
  printf '{"k":%s}' "$(json_escape $'tab\there "q" \\ end')" | py json check --file -
}

test_probe_fixture_and_strict() {
  local d; d="$(mktemp -d)"
  printf 'hello\n' >"$d/greet"; printf '3' >"$d/fails.rc"
  FIXTURES="$d"; FIXTURES_STRICT=1
  _eq "$(probe greet -- false)" "hello" || return 1
  probe fails -- true; _eq "$?" 3 || return 1
  probe nofixture -- true 2>/dev/null; _eq "$?" 127
}

test_run_is_printed_not_executed_in_test_mode() {
  local marker; marker="$(mktemp -u)"
  run -- touch "$marker" 2>/dev/null
  [[ ! -e "$marker" ]] || { echo "run executed a command in --test"; return 1; }
  _eq "$(run --sim-out simulated -- false 2>/dev/null)" "simulated"
}

test_write_file_goes_to_sandbox() {
  local dest="/etc/apollo-sfs-unit-test.conf"
  printf 'a=1\n' | write_file "$dest" 0644 root:root 2>/dev/null || return 1
  [[ ! -e "$dest" ]] || { echo "real file was written"; return 1; }
  _eq "$(cat "$TEST_SANDBOX/fs$dest")" "a=1" || return 1
  _eq "$WRITE_CHANGED" 1 || return 1
  # identical rewrite is a no-op; read_file sees the sandbox render
  printf 'a=1\n' | write_file "$dest" 0644 root:root 2>/dev/null
  _eq "$WRITE_CHANGED" 0 && _eq "$(read_file "$dest")" "a=1"
}

test_fstab_upsert_tags_and_replaces() {
  mkdir -p "$TEST_SANDBOX/fs/etc"
  printf 'UUID=root / ext4 defaults 0 1\n/x:/y /pool fuse.mergerfs defaults 0 0\n' >"$TEST_SANDBOX/fs/etc/fstab"
  fstab_upsert pool-fast "/x:/y /pool fuse.mergerfs defaults,nofail 0 0" --replace-target /pool 2>/dev/null || return 1
  local f; f="$(cat "$TEST_SANDBOX/fs/etc/fstab")"
  grep -q '^/x:/y /pool fuse.mergerfs defaults,nofail 0 0  # apollo-sfs:pool-fast$' <<<"$f" || { echo "$f"; return 1; }
  grep -q '^# replaced by deploy.sh' <<<"$f" || { echo "old line not commented"; return 1; }
  # second upsert with the tag replaces in place (no duplicate)
  fstab_upsert pool-fast "/x:/y:/z /pool fuse.mergerfs defaults,nofail 0 0" 2>/dev/null
  _eq "$(grep -c 'apollo-sfs:pool-fast' "$TEST_SANDBOX/fs/etc/fstab")" 1
}

test_state_store() {
  state_set role manager
  _eq "$(state_get role)" manager && _eq "$(state_get nope fallback)" fallback && ! state_has nope
}

test_node_json_merge_and_validate() {
  printf '{"node":{"name":"n1"},"cluster":{"role":"worker"},"last_success":{"revision":2}}' | node_json_merge deployment || return 1
  _eq "$(node_json_get deployment.cluster.role)" worker || return 1
  FIXTURES="$(mktemp -d)"; printf 'n1\n' >"$FIXTURES/hostname"
  deployment_valid --quiet
}

test_ask_percent_bounds() {
  # 40% remaining, 1 role pending after this one: 40 and 0 are rejected, 39 ok
  _answers 40 0 39
  local v; ask_percent v "postgres shard" --remaining 40 --pending 1 --base 1000000000000 2>/dev/null || return 1
  _eq "$v" 39 || return 1
  # last role: empty answer takes the whole remaining balance
  _answers ""
  ask_percent v "blob storage shard" --remaining 25 --pending 0 --base 1000000000000 2>/dev/null || return 1
  _eq "$v" 25
}

test_checklist_line_mode() {
  _answers "" "2,4"
  local -a picked=()
  checklist picked "Roles" --min 1 a=A b=B c=C d=D 2>/dev/null || return 1
  _eq "${picked[*]}" "b d"
}

test_checklist_disabled_rejected() {
  _answers "b" "c"
  local -a picked=()
  checklist picked "Roles" --min 1 --disable "b=taken" a=A b=B c=C 2>/dev/null || return 1
  _eq "${picked[*]}" "c"
}

test_select_one_default_and_disabled() {
  _answers "" 
  local v; select_one v "Pick" --default b a=A b=B 2>/dev/null || return 1
  _eq "$v" b || return 1
  _answers 2 1
  select_one v "Pick" --disable "b=nope" a=A b=B 2>/dev/null || return 1
  _eq "$v" a
}

test_ask_validate_and_default() {
  _v_even() { (( $1 % 2 == 0 )) || { echo "odd" >&2; return 1; }; }
  _answers 3 4
  local v; ask v "Even number" --validate _v_even 2>/dev/null || return 1
  _eq "$v" 4 || return 1
  _answers ""
  ask v "Name" --default apollo 2>/dev/null; _eq "$v" apollo
}

test_alert_ack_requires_ack() {
  _answers "" "nope" "ack"
  alert_ack warn test-id "Title" "Body" 2>/dev/null || return 1
  _eq "${#ALERTS_ACKED[@]}" 1
}

test_alert_ack_preapproved_on_eof() {
  _answers
  ACK_ALERTS="test-id"
  alert_ack crit test-id "Title" "Body" 2>/dev/null
}

test_cluster_call_runs_local_op_on_manager() {
  source "$APOLLO_ROOT/scripts/deploy/lib/remote.sh"
  remote_op_echo_test() { printf '{"got":%s}' "$(json_escape "$(remote_req x)")"; }
  state_set role manager
  printf '{"x":"hello"}' >"$TEST_SANDBOX/req.json"
  cluster_call echo-test --in "$TEST_SANDBOX/req.json" 2>/dev/null || return 1
  _eq "$(mgr_data got)" hello
}

test_remote_main_unknown_op_and_proto() {
  source "$APOLLO_ROOT/scripts/deploy/lib/remote.sh"
  local out
  out="$(remote_main nope --proto 1 2>/dev/null)"
  _eq "$(printf '%s' "$out" | json_get error.code)" unknown_op || return 1
  out="$(remote_main nope --proto 99 2>/dev/null)"
  _eq "$(printf '%s' "$out" | json_get error.code)" proto_mismatch
}
