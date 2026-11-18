# shellcheck shell=bash
# 20-ws2-drives — the drives step: adopt today's Pi without touching data,
# format a blank disk on a fresh node only after a typed confirmation.

ws2_fx() {
  local d="$T_WS/fx-$1"
  rm -rf "$d"; mkdir -p "$d"
  cp -a "$HARNESS_DIR/fixtures/$1/." "$d/"
  chmod -R a+rX "$d"
  printf '%s' "$d"
}
ws2_answers() { local f; f="$(mktemp "$T_WS/answers.XXXXXX")"; printf '%s\n' "$@" >"$f"; chmod 0644 "$f"; printf '%s' "$f"; }
ws2_sandbox() { sed -n 's/^Test sandbox kept at: //p' <<<"$T_OUT" | tail -n1; }

ws2_pi_adopt() {
  t_run "$(ws2_fx 20-pi-adopt)" "$(ws2_answers "")" -- --test --keep-sandbox --state role=worker _step deploy_step_drives
  t_assert_rc 0
  t_assert_hermetic
  t_assert_out_contains "adopt nvme-01"
  t_assert_out_contains "mmcblk0 (unavailable: system"
  t_assert_out_not_contains "wipefs"
  t_assert_out_not_contains "mkfs"
  t_assert_out_not_contains "sgdisk"
  t_assert_out_matches 'would write /etc/fstab'
  t_assert_out_matches '\+.*/minio/pool +fuse\.mergerfs .*nofail'
  t_assert_out_contains "The manager receives metrics for: nvme-01 nvme-02"
  t_assert_out_contains "STEP_RESULT deploy_step_drives=ok"
  local sb; sb="$(ws2_sandbox)"
  local req; req="$(cat "$sb"/mgr-requests/register-node.*.json 2>/dev/null)"
  grep -q '"phase": *"drives"' <<<"$req" || _t_fail "register-node request is not phase=drives"
  grep -q '"label": *"nvme-02"' <<<"$req" || _t_fail "register-node request lacks nvme-02"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); dep=d["deployment"]; assert dep["storage"]["tier"]=="fast"; assert dep["pools"][0]["path"].endswith("/minio/pool"); assert all(x["adopted"] for x in dep["drives"])' "$sb/node.json" ||
    _t_fail "node.json drives/pools/storage not recorded as expected"
}

ws2_fresh_format() {
  # sdb holds NTFS data (needs ERASE), sda is blank (needs its name): pick only sda.
  t_run "$(ws2_fx 20-fresh-format)" "$(ws2_answers "sda" "sda")" -- --test --keep-sandbox --state role=worker _step deploy_step_drives
  t_assert_rc 0
  t_assert_hermetic
  t_assert_out_contains "sdd (unavailable: in_use"
  t_assert_out_contains "would run: wipefs -a /dev/sda"
  t_assert_out_contains "would run: sgdisk --zap-all /dev/sda"
  t_assert_out_matches 'would run: sgdisk -n1:0:0 -t1:8300 -c1:hdd-02 -u1:'
  t_assert_out_contains "would run: mkfs.xfs -f -L hdd-02 /dev/sda1"
  t_assert_out_contains "would run: chattr +i /srv/minio/hdd-02"
  t_assert_out_matches 'UUID=planned-hdd-02 +/srv/minio/hdd-02 +xfs +defaults,noatime,nofail,prjquota'
  t_assert_out_matches 'would run: systemctl start srv-minio-hdd.+x2d02\.mount'
  t_assert_out_not_contains "mount -a"
  t_assert_out_not_contains "/dev/sdb"
}

ws2_foreign_needs_erase() {
  # Choosing the NTFS disk but typing the wrong confirmation must not wipe it.
  t_run "$(ws2_fx 20-fresh-format)" "$(ws2_answers "sdb" "yes")" -- --test --keep-sandbox --state role=worker _step deploy_step_drives
  t_assert_hermetic
  t_assert_out_contains "Everything on /dev/sdb will be destroyed."
  t_assert_out_contains "Skipping sdb."
  t_assert_out_not_contains "wipefs"
}

t_scenario "drives: adopt today's Pi (nothing formatted, pool gains nofail)" ws2_pi_adopt
t_scenario "drives: format a blank disk after typed confirmation" ws2_fresh_format
t_scenario "drives: a disk with data needs 'ERASE <dev>'" ws2_foreign_needs_erase
