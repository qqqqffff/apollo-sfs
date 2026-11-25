# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/undo.sh — rollback journal for deploy / update / restart.
#
# Every change a run makes on THIS node is journaled as it happens:
#   file  — written by write_file: restored from its backup (or removed if the
#           run created it). Automatic for every write_file.
#   cmd   — a command that reverses a system change (stop a mount unit, leave
#           the swarm, re-add a pool branch …), registered by the code that
#           made the change, right after it succeeded.
#   fn    — like cmd, but a deploy.sh function (e.g. asks the manager to scale).
#   note  — a change that CANNOT be undone (formatting a disk, changes made on
#           the manager). Listed so the user knows what stays.
#
# When a run quits or fails, the user is offered a rollback (newest change
# first). `./deploy.sh rollback [RUN_ID]` replays a journal later. In --test
# the journal lives in the sandbox and a rollback only prints what it would do.
#
# Journal: $BACKUP_DIR/journal (real) — fields separated by \x1f.
# ─────────────────────────────────────────────────────────────────────────────

UNDO_SEP=$'\x1f'
declare -gA UNDO_FILES_SEEN=()
UNDO_DISABLED="${UNDO_DISABLED:-0}"   # rollback itself does not journal

undo_journal_path() {
  if is_test; then printf '%s' "${TEST_SANDBOX:-/nonexistent}/journal"; else printf '%s' "$BACKUP_DIR/journal"; fi
}

_undo_append() {   # KIND DESC PAYLOAD…
  [[ "$UNDO_DISABLED" == 1 || "${RUN_OP:-}" == _remote ]] && return 0
  local j; j="$(undo_journal_path)"
  mkdir -p "$(dirname "$j")" 2>/dev/null || return 0
  local IFS="$UNDO_SEP"
  printf '%s\n' "$*" >>"$j" 2>/dev/null || true
}

# undo_push DESC -- CMD… — CMD (run through `run`) reverses the change just made.
undo_push() {
  local desc="$1"; shift; [[ "${1:-}" == -- ]] && shift
  local q; printf -v q '%q ' "$@"
  _undo_append cmd "$desc" "${q% }"
}

# undo_push_fn DESC -- FN ARGS… — a deploy.sh function that reverses the change.
undo_push_fn() {
  local desc="$1"; shift; [[ "${1:-}" == -- ]] && shift
  local q; printf -v q '%q ' "$@"
  _undo_append fn "$desc" "${q% }"
}

# undo_note DESC — a change that cannot be rolled back.
undo_note() { _undo_append note "$1" ""; }

# undo_file DEST BACKUP — called by write_file before the first write of DEST
# in this run (BACKUP empty = DEST did not exist).
undo_file() {
  local dest="$1" backup="$2"
  [[ -n "${UNDO_FILES_SEEN[$dest]:-}" ]] && return 0
  UNDO_FILES_SEEN[$dest]=1
  _undo_append file "$( [[ -n "$backup" ]] && echo "restore $dest" || echo "remove $dest (created by this run)")" "$dest" "$backup"
}

undo_count() {
  local j="${1:-$(undo_journal_path)}"
  [[ -f "$j" ]] || { echo 0; return 0; }
  grep -c . "$j" 2>/dev/null || true
}

# _undo_list JOURNAL — print the numbered rollback plan (newest first).
_undo_list() {
  local j="$1" n=0 kind desc tag
  while IFS="$UNDO_SEP" read -r kind desc _; do
    n=$((n + 1))
    case "$kind" in
      file) tag="restore" ;; cmd|fn) tag="undo" ;; note) tag="CANNOT UNDO" ;; *) tag="?" ;;
    esac
    printf '  %2d. [%s] %s\n' "$n" "$tag" "$desc" >&2
  done < <(tac "$j")
}

# undo_rollback [JOURNAL] [--yes] — show the plan, confirm, roll back newest
# first. rc 0 done (or nothing to do) / 1 some steps failed / 3 declined.
undo_rollback() {
  local j="" yes=0
  while (($#)); do case "$1" in --yes) yes=1 ;; *) j="$1" ;; esac; shift; done
  [[ -n "$j" ]] || j="$(undo_journal_path)"
  if [[ ! -s "$j" ]]; then log_info "Nothing to roll back — this run changed nothing on this node."; return 0; fi
  local total notes
  total="$(undo_count "$j")"
  notes="$(grep -c "^note$UNDO_SEP" "$j" 2>/dev/null || true)"
  ui_section "Roll back $total change(s) on this node (newest first)"
  _undo_list "$j"
  [[ "${notes:-0}" -gt 0 ]] && log_warn "$notes change(s) marked CANNOT UNDO stay as they are."
  if [[ $yes == 0 ]] && ! (ask_yn "Roll these changes back now?" n); then   # subshell: EOF must not kill the EXIT trap
    if is_test; then log_info "Rollback skipped (test mode: nothing was changed anyway)."
    else log_info "Rollback skipped. You can still run it later: sudo ./deploy.sh rollback $(basename "$(dirname "$j")")"; fi
    return 3
  fi
  local kind desc a b failed=0 reload_systemd=0 reload_nginx=0 reload_docker=0
  UNDO_DISABLED=1
  while IFS="$UNDO_SEP" read -r kind desc a b; do
    case "$kind" in
      file)
        case "$a" in
          /etc/fstab|/etc/systemd/*) reload_systemd=1 ;;
          /etc/nginx/*) reload_nginx=1 ;;
          /etc/docker/daemon.json) reload_docker=1 ;;
        esac
        if is_test; then
          log_test "would $( [[ -n "$b" ]] && echo "restore $a from this run's backup" || echo "remove $a")"
          continue
        fi
        if [[ -n "$b" ]]; then
          if is_test || [[ -f "$b" ]]; then run -- cp -a "$b" "$a" || { log_error "could not restore $a"; failed=1; continue; }
          else log_error "backup $b is missing — $a not restored"; failed=1; continue; fi
        else
          run -- rm -f "$a" || { failed=1; continue; }
        fi
        log_ok "$desc" ;;
      cmd)
        if eval "run -- $a"; then log_ok "$desc"; else log_warn "failed: $desc"; failed=1; fi ;;
      fn)
        if eval "$a"; then log_ok "$desc"; else log_warn "failed: $desc"; failed=1; fi ;;
      note)
        log_detail "left as is: $desc" ;;
    esac
  done < <(tac "$j")
  ((reload_systemd)) && { run -- systemctl daemon-reload || failed=1; }
  ((reload_nginx)) && { run -- sh -c 'nginx -t && systemctl reload nginx' || { log_warn "nginx config test failed after the restore"; failed=1; }; }
  ((reload_docker)) && { run -- systemctl reload docker || failed=1; }
  UNDO_DISABLED=0
  if ! is_test; then mv -f "$j" "$j.rolled-back-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true; fi
  if ((failed)); then log_warn "Rollback finished with errors (see above)."; return 1; fi
  log_ok "Rollback complete."
  return 0
}

# undo_offer RC — EXIT path of deploy/update/restart: offer the rollback.
undo_offer() {
  local rc="$1" j; j="$(undo_journal_path)"
  [[ "$rc" -ne 0 && -s "$j" ]] || return 0
  [[ "${RUN_OP:-}" =~ ^(deploy|update|restart)$ ]] || return 0
  printf '\n' >&2
  log_warn "The ${RUN_OP} run stopped (exit $rc) after changing this node."
  if [[ "$NONINTERACTIVE" == 1 ]]; then
    is_test || log_info "To undo its changes: sudo ./deploy.sh rollback $(basename "$(dirname "$j")")"
    return 0
  fi
  undo_rollback "$j" || true
}

# _undo_scale SERVICE REPLICAS — rollback helper (asks the manager on workers).
_undo_scale() {
  local svc="$1" n="$2" f rc=0
  [[ -n "${MGR_HOST:-}" ]] || remote_context_load >/dev/null 2>&1 || true
  f="$(mktemp "${TMPDIR:-/tmp}/apollo-scale.XXXXXX")"
  printf '{"services":{"%s":%d}}' "$svc" "$n" >"$f"
  cluster_call scale --in "$f" || rc=$?
  rm -f "$f"
  return "$rc"
}

# cmd_rollback [RUN_ID] — `./deploy.sh rollback`: list journals, pick one.
cmd_rollback() {
  local id="${1:-}" j
  if [[ -z "$id" ]]; then
    local -a opts=()
    local f
    while IFS= read -r f; do
      local rid; rid="$(basename "$(dirname "$f")")"
      opts+=("$rid=$rid — $(undo_count "$f") change(s), $(date -r "$f" '+%Y-%m-%d %H:%M' 2>/dev/null)")
    done < <(find "$BACKUP_ROOT" -mindepth 2 -maxdepth 2 -name journal -size +0 -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2-)
    if ((${#opts[@]} == 0)); then log_info "No run with changes left to roll back under $BACKUP_ROOT."; return 0; fi
    select_one id "Which run should be rolled back? (newest first)" "${opts[@]}" quit="quit"
    [[ "$id" == quit ]] && return 0
  fi
  [[ "$id" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid run id '$id'"
  j="$BACKUP_ROOT/$id/journal"
  [[ -s "$j" ]] || die "no rollback journal for run $id ($j)"
  undo_rollback "$j"
}
