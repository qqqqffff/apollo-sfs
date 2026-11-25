# shellcheck shell=bash
# 37-reserve-labels — a node's existing labels (sent as in_use) are never handed
# out again, even when the manager's registry has no record of that node yet
# (first adoption). Regression: the Pi's new drive was formatted as "nvme-01".

rl_fx() {
  local d="$T_WS/fx-$1"
  rm -rf "$d"; mkdir -p "$d"; cp -a "$HARNESS_DIR/fixtures/$1/." "$d/"; chmod -R a+rX "$d"
  printf '%s' "$d"
}

rl_existing_labels_are_skipped() {
  local fx; fx="$(rl_fx 37-reserve-labels)"
  t_run "$fx" "$fx/request.json" -- --test _remote reserve-labels --proto 1
  t_assert_rc 0
  t_assert_hermetic
  t_assert_out_matches '"labels": *\["nvme-03", *"nvme-04"\]'
}

t_scenario "drives: label reservation skips labels already on the node" rl_existing_labels_are_skipped
