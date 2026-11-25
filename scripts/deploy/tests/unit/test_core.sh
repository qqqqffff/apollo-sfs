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

test_remote_op_stray_stdout_does_not_break_the_reply() {
  source "$APOLLO_ROOT/scripts/deploy/lib/remote.sh"
  remote_op_chatty() { echo "Updating service apollo-sfs_minio (id: abc)"; echo "{not json"; printf '{"a":{"b":[1,2]}}'; }
  remote_op_garbage() { echo "no reply at all"; }
  remote_op_failing() { echo "partial"; remote_fail my_code "the real reason"; return 1; }
  local out err="$TEST_SANDBOX/err"
  out="$(remote_main chatty --proto 1 2>"$err")" || { echo "rc: $out"; return 1; }
  _eq "$(printf '%s' "$out" | json_get data.a.b)" "[1,2]" || _eq "$(printf '%s' "$out" | json_get data.a.b)" "[1, 2]" || return 1
  grep -q "Updating service" "$err" || { echo "stray line lost"; return 1; }
  out="$(remote_main garbage --proto 1 2>/dev/null)"
  _eq "$(printf '%s' "$out" | json_get error.code)" bad_data || return 1
  # the op's own error code/message survive the subshell
  out="$(remote_main failing --proto 1 2>/dev/null)"
  _eq "$(printf '%s' "$out" | json_get error.code)" my_code || return 1
  _eq "$(printf '%s' "$out" | json_get error.message)" "the real reason"
}

test_fstab_foreign_only_flags_definite_mismatches() {
  source "$APOLLO_ROOT/scripts/deploy/lib/drives.sh"
  local m=/srv/minio/hdd-01 u=68885E19-aaaa p=11-22 l
  for l in "UUID=68885e19-AAAA $m xfs defaults 0 2" "UUID=\"68885e19-aaaa\" $m xfs defaults 0 2" "LABEL=hdd-01 $m xfs defaults 0 2" \
           "PARTUUID=11-22 $m xfs defaults 0 2" "/dev/sda1 $m xfs defaults 0 2" "/dev/disk/by-id/ata-x-part1 $m xfs defaults 0 2" \
           "#UUID=ffff $m xfs defaults 0 2" "UUID=ffff /srv/other xfs defaults 0 2"; do
    _eq "$(_drives_fstab_foreign "$m" "$u" "$p" <<<"$l")" "" || { echo "wrongly flagged: $l"; return 1; }
  done
  for l in "UUID=42aee94f $m xfs defaults 0 2 # apollo-sfs:drive-hdd-01" "PARTUUID=99-99 $m xfs defaults 0 2"; do
    _eq "$(_drives_fstab_foreign "$m" "$u" "$p" <<<"$l")" "$l" || return 1
  done
  _eq "$(_drives_fstab_foreign "$m" "$u" "" <<<"PARTUUID=99-99 $m xfs defaults 0 2")" ""
}

test_swarm_check_after_rename() {
  source "$APOLLO_ROOT/scripts/deploy/lib/system.sh"
  # a fake docker whose answers the test controls
  D_STATE=active D_ID=n1 D_CID=c1 D_CTL=true D_NAME=new D_SWNAME=new D_READY=$'n1 Ready\nw1 Ready'
  docker() {
    case "$*" in
      *'json .Swarm'*) printf '{"LocalNodeState":"%s","NodeID":"%s","ControlAvailable":%s,"Cluster":{"ID":"%s"}}' "$D_STATE" "$D_ID" "$D_CTL" "$D_CID" ;;
      *'{{.Name}}'*) echo "$D_NAME" ;;
      *'node inspect self'*) echo "$D_SWNAME" ;;
      *'node ls'*) echo "$D_READY" ;;
      *'node inspect w1'*) echo pi ;;
    esac
  }
  chk() { _system_swarm_check new n1 c1 "${1:-true}" "n1 w1"; }
  chk || { echo "healthy swarm refused: $SWARM_WHY"; return 1; }
  (D_STATE=locked; chk) && { echo "locked accepted"; return 1; }
  (D_STATE=inactive; chk) && { echo "inactive accepted"; return 1; }
  (D_ID=n2; chk) && { echo "changed node ID accepted"; return 1; }
  (D_CID=c2; chk) && { echo "changed swarm accepted"; return 1; }
  (D_CTL=false; chk) && { echo "lost manager accepted"; return 1; }
  (D_SWNAME=old; chk) && { echo "old swarm name accepted"; return 1; }
  (D_NAME=old; chk) && { echo "old docker name accepted"; return 1; }
  (D_READY=$'n1 Ready\nw1 Down'; chk) && { echo "missing worker accepted"; return 1; }
  D_READY=$'n1 Ready\nw1 Down'; chk; [[ "$SWARM_WHY" == *"node pi is not back"* ]] || { echo "why: $SWARM_WHY"; return 1; }
  # on a worker only its own identity is checked
  D_CTL=false D_SWNAME="" D_READY=""; chk false
}

test_stack_deploy_keeps_stdout_clean() {
  source "$APOLLO_ROOT/scripts/deploy/lib/stack.sh"
  _stack_export_env() { return 0; }
  docker() { [[ "$1 $2" == "stack deploy" ]] && echo "Updating service apollo-sfs_minio (id: abc)"; return 0; }
  NODES_STACK_FILE="$TEST_SANDBOX/nodes.yml"; : >"$NODES_STACK_FILE"
  local out
  out="$(TEST_MODE=0; STACK_NODES_ONLY=1 stack_deploy 2>"$TEST_SANDBOX/err")" || { cat "$TEST_SANDBOX/err"; return 1; }
  _eq "$out" "" || return 1
  grep -q "Updating service" "$TEST_SANDBOX/err"
}

test_undo_journal_and_rollback_plan() {
  declare -F undo_push >/dev/null || source "$APOLLO_ROOT/scripts/deploy/lib/undo.sh"
  RUN_OP=deploy
  printf 'a\n' | write_file /etc/apollo-unit-undo.conf 0644 root:root >/dev/null 2>&1
  printf 'b\n' | write_file /etc/apollo-unit-undo.conf 0644 root:root >/dev/null 2>&1   # second write: one entry
  undo_push "stop x" -- systemctl stop "x y.mount"
  undo_note "formatted /dev/zzz"
  _eq "$(undo_count)" 3 || return 1
  local out; out="$(_undo_list "$(undo_journal_path)" 2>&1)"
  # newest first, irreversible flagged
  [[ "$(sed -n 1p <<<"$out")" == *"CANNOT UNDO"*"formatted /dev/zzz"* ]] || { echo "bad order: $out"; return 1; }
  [[ "$(sed -n 3p <<<"$out")" == *"remove /etc/apollo-unit-undo.conf"* ]] || { echo "file entry: $out"; return 1; }
  _answers y
  out="$(undo_rollback 2>&1)" || { echo "rollback rc: $out"; return 1; }
  [[ "$out" == *"would run: systemctl stop x\ y.mount"* ]] || { echo "cmd not replayed: $out"; return 1; }
  [[ "$out" == *"would remove /etc/apollo-unit-undo.conf"* ]] || { echo "file not undone: $out"; return 1; }
  [[ ! -e /etc/apollo-unit-undo.conf ]]
}
