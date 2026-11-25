# shellcheck shell=bash
# 35-ws3b-stack — manager-side registration on today's cluster: the first
# adoption seeds the legacy per-node services so the generated stack file is
# IDENTICAL to what runs today (no restarts), labels + DB row are applied, and
# the one-time constraint migration is deferred when nobody can confirm it.

ws3b_fx() {
  local d="$T_WS/fx-$1"
  rm -rf "$d"; mkdir -p "$d"; cp -a "$HARNESS_DIR/fixtures/$1/." "$d/"; chmod -R a+rX "$d"
  printf '%s' "$d"
}

ws3b_register_manager() {
  local fx; fx="$(ws3b_fx 35-manager-adopt)"
  t_run "$fx" "$fx/request.json" -- --test --keep-sandbox _remote register-node --proto 1
  t_assert_rc 0
  t_assert_hermetic
  t_assert_out_matches '^\{"proto":1,"op":"register-node","ok":true'
  t_assert_out_contains "First adoption: recording the existing per-node services"
  t_assert_out_matches 'would run: docker node update --label-add apollo-manager=true apollo-sfs-1'
  t_assert_out_matches 'would run: docker node update .*--label-add apollo-role-blob-storage-shard=true .*apollo-sfs-1'
  t_assert_out_matches 'would run: docker exec -i 4f2c9a1b7d3e psql .* -v host=apollo-sfs-1 -v role=manager'
  t_assert_out_contains "each restarts ONCE"
  t_assert_out_matches 'would run: docker stack deploy --resolve-image changed -c [^ ]*/cluster/docker-stack.nodes.yml apollo-sfs'
  t_assert_out_not_contains "-c ${T_WS}/repo/docker-stack.yml"
  local sb; sb="$(sed -n 's/^Test sandbox kept at: //p' <<<"$T_OUT" | tail -n1)"
  local nodes; nodes="$(find "$sb/fs" -name docker-stack.nodes.yml | head -n1)"
  [[ -f "$nodes" ]] || { _t_fail "no nodes file rendered"; return; }
  python3 -I -B "$T_WS/repo/scripts/node-status/apollo_node.py" stack compare \
    --a "$T_WS/repo/scripts/deploy/templates/legacy-node-services.yml" --b "$nodes" >/dev/null ||
    _t_fail "the generated per-node services differ from today's (adoption would restart them)"
}

t_scenario "stack: manager adoption renders today's services unchanged" ws3b_register_manager
