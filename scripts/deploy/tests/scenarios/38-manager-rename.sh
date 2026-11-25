# shellcheck shell=bash
# 38-manager-rename — renaming the MANAGER keeps the swarm: every docker command
# addresses it by node ID, the worker stays listed, its record/labels carry over,
# and the manager checks its connection to every worker.

MR_ID=mgr00000000000000000000001
mr_fx() { local d="$T_WS/fx-38"; rm -rf "$d"; mkdir -p "$d"; cp -a "$HARNESS_DIR/fixtures/38-manager-rename/." "$d/"; chmod -R a+rX "$d"; printf '%s' "$d"; }
mr_answers() { local f; f="$(mktemp "$T_WS/answers.XXXXXX")"; printf '%s\n' "$@" >"$f"; chmod 0644 "$f"; printf '%s' "$f"; }
MR_STATE=(--state role=manager --state node_name=nh-manager-001 --state 'previous_names=["apollo-sfs-1"]')

mr_identity() {
  local fx; fx="$(mr_fx)"
  t_run "$fx" "$(mr_answers nh-manager-001 y)" -- --test --node-json "$fx/manager-node.json" _step deploy_step_identity
  t_assert_rc 0; t_assert_hermetic
  t_assert_out_contains "other nodes            nh-fast-node-001"
  t_assert_out_contains "would run: hostnamectl set-hostname nh-manager-001"
  t_assert_out_contains "would run: systemctl stop docker.service docker.socket"
  t_assert_out_contains "swarm-state.tgz"
  t_assert_out_contains "would run: systemctl start docker.service"
  t_assert_out_contains "would verify that the swarm is unchanged: node ID mgr000000000, swarm ID swarm0000000, name 'nh-manager-001' accepted, 2 node(s) Ready as before"
}

mr_name_taken() {
  local fx; fx="$(mr_fx)"
  t_run "$fx" "$(mr_answers nh-fast-node-001 apollo-sfs-1)" -- --test --node-json "$fx/manager-node.json" _step deploy_step_identity
  t_assert_out_contains "'nh-fast-node-001' is already used by another node"
}

mr_membership() {
  local fx; fx="$(mr_fx)"
  t_run "$fx" "$(mr_answers "")" -- --test --node-json "$fx/manager-node.json" "${MR_STATE[@]}" _step deploy_step_membership
  t_assert_rc 0; t_assert_hermetic
  t_assert_out_not_contains "No other Apollo SFS nodes"
  t_assert_out_matches 'nh-fast-node-001 +192\.168\.68\.63 +worker .*ready +swarm'
  t_assert_out_contains "apollo-sfs-1 -> nh-manager-001 (planned)"
  t_assert_out_contains "would run: docker node update --label-add apollo-server=apollo-sfs $MR_ID"
  t_assert_out_not_contains "docker swarm init"
  t_assert_out_not_matches() { grep -qE -- "$1" <<<"$T_OUT" && _t_fail "output unexpectedly matches /$1/"; return 0; }
  t_assert_out_not_matches '^ +\? +192\.168\.68\.57'   # the manager must not list itself as an unknown node
}

mr_register() {
  local fx; fx="$(mr_fx)"
  t_run "$fx" "$fx/request.json" -- --test --keep-sandbox _remote register-node --proto 1
  t_assert_rc 0; t_assert_hermetic
  t_assert_out_matches '^\{"proto":1,"op":"register-node","ok":true'
  t_assert_out_contains "Retiring the record for the old name 'apollo-sfs-1' (now 'nh-manager-001')"
  t_assert_out_matches "would run: docker node update .*apollo-role-blob-storage-shard=true.* $MR_ID"
  t_assert_out_matches 'psql .* -v host=nh-manager-001 -v role=manager .*-v prev=apollo-sfs-1'
  t_assert_out_not_contains "claimed by both"
  local sb; sb="$(sed -n 's/^Test sandbox kept at: //p' <<<"$T_OUT" | tail -n1)"
  local nodes; nodes="$(find "$sb/fs" -name docker-stack.nodes.yml | head -n1)"
  [[ -f "$nodes" ]] || { _t_fail "no nodes file rendered"; return; }
  python3 -I -B "$T_WS/repo/scripts/node-status/apollo_node.py" stack compare \
    --a "$T_WS/repo/scripts/deploy/templates/legacy-node-services.yml" --b "$nodes" >/dev/null ||
    _t_fail "renaming the manager changed per-node services (they would restart)"
}

mr_register_reused_name() {
  # The old name now belongs to ANOTHER node: its record must not be taken over.
  local fx; fx="$(mr_fx)"
  printf '%s nh-manager-001\nother0000000000000000001 apollo-sfs-1\n' "$MR_ID" >"$fx/docker-node-ids"
  t_run "$fx" "$fx/request.json" -- --test _remote register-node --proto 1
  t_assert_out_not_contains "Retiring the record for the old name"
}

mr_worker_heartbeat_ok() {
  local fx; fx="$(mr_fx)"
  t_run "$fx" "$(mr_answers "")" -- --test --node-json "$fx/manager-node.json" "${MR_STATE[@]}" _step restart_step_heartbeat
  t_assert_hermetic
  t_assert_out_contains "Worker nh-fast-node-001 (192.168.68.63)"
  t_assert_out_matches 'network +pass +reachable at 192\.168\.68\.63'
  t_assert_out_matches 'overlay +pass +api -> minio:9000'
  t_assert_out_matches 'disk nvme-02 +pass'
  t_assert_out_matches 'worker nh-fast-node-001 +pass'
  t_assert_out_not_contains "Worker apollo-sfs-1"
}

mr_worker_heartbeat_down() {
  local fx; fx="$(mr_fx)"
  echo 1 >"$fx/tcp-192.168.68.63-7946.rc"; echo 1 >"$fx/overlay-minio.rc"
  cp "$fx/cluster-nodes/nh-fast-node-001.json" "$fx/cluster-nodes/gone.json"; sed -i 's/"hostname": "nh-fast-node-001"/"hostname": "gone"/' "$fx/cluster-nodes/gone.json"
  t_run "$fx" "$(mr_answers "")" -- --test --node-json "$fx/manager-node.json" "${MR_STATE[@]}" _step restart_step_heartbeat
  t_assert_out_matches 'network +fail +192\.168\.68\.63 does not answer'
  t_assert_out_matches 'worker nh-fast-node-001 +warn +fail: network, overlay'
  t_assert_out_matches 'worker gone +warn +fail: swarm'
}

t_scenario "manager rename: Docker restart keeps and verifies the swarm" mr_identity
t_scenario "manager rename: a worker's name is refused" mr_name_taken
t_scenario "manager rename: the worker stays listed, labels go by node ID" mr_membership
t_scenario "manager rename: record and DB row carry over, no service restarts" mr_register
t_scenario "manager rename: a name reused by another node is left alone" mr_register_reused_name
t_scenario "manager heartbeat: worker connection is checked" mr_worker_heartbeat_ok
t_scenario "manager heartbeat: an unreachable or missing worker is reported" mr_worker_heartbeat_down
