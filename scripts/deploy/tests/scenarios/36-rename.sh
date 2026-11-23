# shellcheck shell=bash
# 36-rename — the Pi (legacy record "apollo-sfs", serving the fast tier) is
# renamed: the manager carries its record over to the new name and retires the
# old one, so the generated stack never lists node-agent-fast/minio twice.

rename_fx() {
  local d="$T_WS/fx-$1"
  rm -rf "$d"; mkdir -p "$d"; cp -a "$HARNESS_DIR/fixtures/$1/." "$d/"; chmod -R a+rX "$d"
  printf '%s' "$d"
}

rename_register_pi() {
  local fx; fx="$(rename_fx 36-pi-rename)"
  t_run "$fx" "$fx/request.json" -- --test --keep-sandbox _remote register-node --proto 1
  t_assert_rc 0
  t_assert_hermetic
  t_assert_out_matches '^\{"proto":1,"op":"register-node","ok":true'
  t_assert_out_contains "Retiring the record for the old name 'apollo-sfs' (now 'nh-fast-node-001')"
  t_assert_out_not_contains "claimed by both"
  local sb; sb="$(sed -n 's/^Test sandbox kept at: //p' <<<"$T_OUT" | tail -n1)"
  local nodes; nodes="$(find "$sb/fs" -name docker-stack.nodes.yml | head -n1)"
  [[ -f "$nodes" ]] || { _t_fail "no nodes file rendered"; return; }
  python3 -I -B "$T_WS/repo/scripts/node-status/apollo_node.py" stack compare \
    --a "$T_WS/repo/scripts/deploy/templates/legacy-node-services.yml" --b "$nodes" >/dev/null ||
    _t_fail "renaming the Pi changed its services (they would restart)"
}

t_scenario "stack: renaming the Pi carries its blob storage over (no duplicate services)" rename_register_pi
