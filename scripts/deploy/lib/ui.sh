# shellcheck shell=bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/lib/ui.sh — interactive prompts for deploy.sh (WS0 contract).
#
# All user input is read from fd $UI_FD (3). ui_init dups the original stdin
# there and points fd 0 at /dev/null, so ssh/docker/etc. can never swallow an
# answer. On a TTY you get arrow-key menus; otherwise (piped answers, used by
# the test harness) every prompt reads one line:
#   ask/ask_percent  → the value (empty line = default)
#   ask_yn           → y / n (empty = default)
#   select_one       → option number or key
#   checklist        → comma/space separated numbers or keys, or "all"
#   alert_ack        → ack / r / q
# All output goes to stderr.
# ─────────────────────────────────────────────────────────────────────────────

[[ -n "${_APOLLO_UI_LOADED:-}" ]] && return 0
_APOLLO_UI_LOADED=1

UI_TTY=0

# ui_init — call once, before any prompt.
ui_init() {
  exec 3<&0
  if [[ -t 3 && "${APOLLO_UI_INPUT:-}" != lines ]]; then UI_TTY=1; else UI_TTY=0; fi
  exec 0</dev/null
}

_ui_read_line() {   # _ui_read_line VAR [secret] — rc 1 on EOF
  local __v="$1" __secret="${2:-0}" __line=""
  if [[ $__secret == 1 && $UI_TTY == 1 ]]; then
    IFS= read -rs -u "$UI_FD" __line || return 1
    printf '\n' >&2
  else
    IFS= read -r -u "$UI_FD" __line || return 1
  fi
  # Echo piped answers so test transcripts read naturally.
  if [[ $UI_TTY == 0 ]]; then
    if [[ $__secret == 1 && -n "$__line" ]]; then printf '****\n' >&2; else printf '%s\n' "$__line" >&2; fi
  fi
  printf -v "$__v" '%s' "$__line"
}

_ui_eof() { log_error "No answer available for: $1 (input closed)"; exit 3; }

# ui_section TITLE — a bold sub-heading inside a step.
ui_section() { printf '\n%s%s%s\n' "$C_BOLD" "$1" "$C_RESET" >&2; }

# ui_kv KEY VALUE — aligned "key: value" line.
ui_kv() { printf '  %s%-22s%s %s\n' "$C_DIM" "$1" "$C_RESET" "$(mask "$2")" >&2; }

# ui_table "COL1|COL2|…" "row1c1|row1c2|…" … — simple aligned table.
ui_table() {
  local -a widths=() rows=("$@")
  local r i cell
  for r in "${rows[@]}"; do
    IFS='|' read -r -a cells <<<"$r"
    for i in "${!cells[@]}"; do
      cell="${cells[$i]}"
      (( ${#cell} > ${widths[$i]:-0} )) && widths[$i]=${#cell}
    done
  done
  local first=1
  for r in "${rows[@]}"; do
    IFS='|' read -r -a cells <<<"$r"
    local line="  "
    for i in "${!cells[@]}"; do line+="$(printf "%-$(( ${widths[$i]} + 2 ))s" "${cells[$i]}")"; done
    if [[ $first == 1 ]]; then printf '%s%s%s\n' "$C_BOLD" "$(mask "$line")" "$C_RESET" >&2; first=0
    else printf '%s\n' "$(mask "$line")" >&2; fi
  done
}

# fmt_bytes N — human size in decimal units, using the largest unit whose
# value is >= 1 (the "lowest storage denominator"): 100000000000 → "100 GB",
# 3200000000000 → "3.2 TB". Values < 10 get one decimal, others none.
fmt_bytes() {
  awk -v n="${1:-0}" 'BEGIN {
    split("B KB MB GB TB PB EB", u, " "); i = 1
    if (n < 0) n = 0
    while (n >= 1000 && i < 7) { n /= 1000; i++ }
    if (i == 1) printf "%d %s", n, u[i]
    else if (n < 10) { s = sprintf("%.1f", n); sub(/\.0$/, "", s); printf "%s %s", s, u[i] }
    else printf "%d %s", n + 0.5, u[i]
  }'
}

# ask VAR QUESTION [--default D] [--validate FN] [--secret] [--generate FN]
#     [--hint TEXT] [--allow-empty]
#   FN receives the candidate value; it must print a reason (stderr) and
#   return non-zero to reject it. --generate FN prints a generated value when
#   the user answers "g". Secrets are added to the redaction list.
ask() {
  local __var="$1" q="$2"; shift 2
  local def="" has_def=0 validator="" secret=0 gen="" hint="" allow_empty=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --default) def="$2"; has_def=1; shift 2 ;;
      --validate) validator="$2"; shift 2 ;;
      --secret) secret=1; shift ;;
      --generate) gen="$2"; shift 2 ;;
      --hint) hint="$2"; shift 2 ;;
      --allow-empty) allow_empty=1; shift ;;
      *) log_error "ask: unknown option $1"; return 2 ;;
    esac
  done
  [[ -n "$hint" ]] && printf '  %s%s%s\n' "$C_DIM" "$hint" "$C_RESET" >&2
  local shown_def=""
  if [[ $has_def == 1 && -n "$def" ]]; then
    if [[ $secret == 1 ]]; then shown_def=" [keep current]"; else shown_def=" [$(mask "$def")]"; fi
  fi
  local genhint=""; [[ -n "$gen" ]] && genhint=" (g = generate)"
  local val
  while true; do
    printf '%s?%s %s%s%s: ' "$C_CYAN" "$C_RESET" "$q" "$shown_def" "$genhint" >&2
    if ! _ui_read_line val "$secret"; then
      printf '\n' >&2
      if [[ $has_def == 1 ]]; then val="$def"; else _ui_eof "$q"; fi
    fi
    if [[ -z "$val" ]]; then
      if [[ $has_def == 1 ]]; then val="$def"
      elif [[ $allow_empty == 1 ]]; then :
      else log_warn "A value is required."; continue
      fi
    fi
    if [[ -n "$gen" && "$val" == g ]]; then
      val="$("$gen")" || { log_error "generator failed"; continue; }
      [[ $secret == 1 ]] && redact_add "$val"
      log_detail "generated a new value"
    fi
    if [[ -n "$validator" && ! ( -z "$val" && $allow_empty == 1 ) ]]; then
      "$validator" "$val" || continue
    fi
    [[ $secret == 1 ]] && redact_add "$val"
    printf -v "$__var" '%s' "$val"
    return 0
  done
}

# ask_yn QUESTION [y|n] — rc 0 for yes, 1 for no.
ask_yn() {
  local q="$1" def="${2:-n}" ans
  local hint="[y/N]"; [[ $def == y ]] && hint="[Y/n]"
  while true; do
    printf '%s?%s %s %s: ' "$C_CYAN" "$C_RESET" "$q" "$hint" >&2
    if ! _ui_read_line ans; then printf '\n' >&2; ans="$def"; fi
    [[ -z "$ans" ]] && ans="$def"
    case "${ans,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) log_warn "Please answer y or n." ;;
    esac
  done
}

# confirm_typed EXPECTED MESSAGE — the user must type EXPECTED exactly.
# rc 0 when confirmed, 1 otherwise (never loops — a mismatch cancels).
confirm_typed() {
  local expected="$1" msg="$2" ans
  printf '%s%s%s\n' "$C_YELLOW" "$msg" "$C_RESET" >&2
  printf '%s?%s Type %s%s%s to continue (anything else cancels): ' "$C_CYAN" "$C_RESET" "$C_BOLD" "$expected" "$C_RESET" >&2
  if ! _ui_read_line ans; then printf '\n' >&2; return 1; fi
  if [[ "$ans" == "$expected" ]]; then return 0; fi
  log_warn "Confirmation did not match — cancelled."
  return 1
}

# _ui_parse_opts — shared option parsing for select_one/checklist.
# Sets: _UI_KEYS _UI_LABELS _UI_DISABLED(assoc key→reason) _UI_PRESELECT(assoc)
_ui_parse_opts() {
  _UI_KEYS=(); _UI_LABELS=(); _UI_DISABLED=(); _UI_PRESELECT=(); _UI_DEFAULT=""; _UI_MIN=1; _UI_ALLKEY=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --disable) _UI_DISABLED["${2%%=*}"]="${2#*=}"; shift 2 ;;
      --preselect) _UI_PRESELECT["$2"]=1; shift 2 ;;
      --default) _UI_DEFAULT="$2"; shift 2 ;;
      --min) _UI_MIN="$2"; shift 2 ;;
      --all-key) _UI_ALLKEY=1; shift ;;
      *=*) _UI_KEYS+=("${1%%=*}"); _UI_LABELS+=("${1#*=}"); shift ;;
      *) log_error "ui: bad option entry '$1' (expected KEY=LABEL)"; return 2 ;;
    esac
  done
}
declare -ga _UI_KEYS=() _UI_LABELS=()
declare -gA _UI_DISABLED=() _UI_PRESELECT=()

_ui_key_index() {  # _ui_key_index TOKEN → index on stdout (number or key)
  local t="$1" i
  if [[ "$t" =~ ^[0-9]+$ ]] && (( t >= 1 && t <= ${#_UI_KEYS[@]} )); then echo $((t - 1)); return 0; fi
  for i in "${!_UI_KEYS[@]}"; do [[ "${_UI_KEYS[$i]}" == "$t" ]] && { echo "$i"; return 0; }; done
  return 1
}

# select_one VAR TITLE [--default KEY] [--disable KEY=REASON]… KEY=LABEL…
select_one() {
  local __var="$1" title="$2"; shift 2
  _ui_parse_opts "$@" || return 2
  local n=${#_UI_KEYS[@]} i
  (( n > 0 )) || { log_error "select_one: no options"; return 2; }
  local cur=0
  if [[ -n "$_UI_DEFAULT" ]]; then cur="$(_ui_key_index "$_UI_DEFAULT" || echo 0)"; fi
  # skip disabled default
  for (( i = 0; i < n; i++ )); do
    [[ -z "${_UI_DISABLED[${_UI_KEYS[$cur]}]+x}" ]] && break
    cur=$(( (cur + 1) % n ))
  done
  if [[ $UI_TTY == 1 ]]; then
    local key rest lines=$((n + 2)) notice=""
    tput civis >&2 2>/dev/null || true
    _draw_one() {
      local j mark
      printf '\r\033[2K%s%s%s\n' "$C_BOLD" "$title" "$C_RESET" >&2
      for (( j = 0; j < n; j++ )); do
        local k="${_UI_KEYS[$j]}" lab="${_UI_LABELS[$j]}"
        if [[ -n "${_UI_DISABLED[$k]+x}" ]]; then
          printf '\r\033[2K    %s%s (unavailable: %s)%s\n' "$C_DIM" "$lab" "${_UI_DISABLED[$k]}" "$C_RESET" >&2
        elif (( j == cur )); then
          printf '\r\033[2K  %s> %s%s\n' "$C_CYAN$C_BOLD" "$lab" "$C_RESET" >&2
        else
          printf '\r\033[2K    %s\n' "$lab" >&2
        fi
      done
      printf '\r\033[2K  %s↑/↓ move · enter select · q quit%s %s\n' "$C_DIM" "$C_RESET" "$notice" >&2
    }
    _draw_one
    while true; do
      IFS= read -rsn1 -u "$UI_FD" key || { tput cnorm >&2 2>/dev/null; _ui_eof "$title"; }
      if [[ $key == $'\x1b' ]]; then read -rsn2 -t 0.1 -u "$UI_FD" rest || rest=""; key+="$rest"; fi
      notice=""
      case "$key" in
        $'\x1b[A'|k|K) for (( i = 0; i < n; i++ )); do cur=$(( (cur - 1 + n) % n )); [[ -z "${_UI_DISABLED[${_UI_KEYS[$cur]}]+x}" ]] && break; done ;;
        $'\x1b[B'|j|J) for (( i = 0; i < n; i++ )); do cur=$(( (cur + 1) % n )); [[ -z "${_UI_DISABLED[${_UI_KEYS[$cur]}]+x}" ]] && break; done ;;
        ""|$'\n'|$'\r')
          if [[ -z "${_UI_DISABLED[${_UI_KEYS[$cur]}]+x}" ]]; then break; fi
          notice="(that option is unavailable)" ;;
        q|Q) tput cnorm >&2 2>/dev/null || true; log_error "Cancelled."; exit 3 ;;
      esac
      printf '\033[%dA' "$lines" >&2
      _draw_one
    done
    tput cnorm >&2 2>/dev/null || true
    printf -v "$__var" '%s' "${_UI_KEYS[$cur]}"
    return 0
  fi
  # line mode
  printf '%s%s%s\n' "$C_BOLD" "$title" "$C_RESET" >&2
  for (( i = 0; i < n; i++ )); do
    local k="${_UI_KEYS[$i]}"
    if [[ -n "${_UI_DISABLED[$k]+x}" ]]; then
      printf '   %d) %s (unavailable: %s)\n' $((i + 1)) "${_UI_LABELS[$i]}" "${_UI_DISABLED[$k]}" >&2
    else
      printf '   %d) %s\n' $((i + 1)) "${_UI_LABELS[$i]}" >&2
    fi
  done
  local ans idx
  while true; do
    printf '%s?%s Choose [%s]: ' "$C_CYAN" "$C_RESET" "${_UI_KEYS[$cur]}" >&2
    if ! _ui_read_line ans; then printf '\n' >&2; ans=""; [[ -n "$_UI_DEFAULT" ]] || _ui_eof "$title"; fi
    [[ -z "$ans" ]] && ans="${_UI_KEYS[$cur]}"
    [[ "$ans" == q ]] && { log_error "Cancelled."; exit 3; }
    if idx="$(_ui_key_index "$ans")" && [[ -z "${_UI_DISABLED[${_UI_KEYS[$idx]}]+x}" ]]; then
      printf -v "$__var" '%s' "${_UI_KEYS[$idx]}"; return 0
    fi
    log_warn "Not a valid choice: $ans"
  done
}

# checklist ARRAY TITLE [--min N] [--disable KEY=REASON]… [--preselect KEY]…
#           [--all-key] KEY=LABEL…
#   Multi-select (≥ --min, default 1). Fills ARRAY with the chosen keys in
#   option order. --all-key: pressing 'a' (TTY) / answering "all!" selects
#   every enabled option and confirms immediately; sets CHECKLIST_ALL=1.
CHECKLIST_ALL=0
checklist() {
  local __arr="$1" title="$2"; shift 2
  _ui_parse_opts "$@" || return 2
  local n=${#_UI_KEYS[@]} i
  local -a sel=()
  for (( i = 0; i < n; i++ )); do
    if [[ -n "${_UI_PRESELECT[${_UI_KEYS[$i]}]+x}" && -z "${_UI_DISABLED[${_UI_KEYS[$i]}]+x}" ]]; then sel[$i]=1; else sel[$i]=0; fi
  done
  CHECKLIST_ALL=0
  if [[ $UI_TTY == 1 ]]; then
    local cur=0 key rest notice="" lines=$((n + 3))
    for (( i = 0; i < n; i++ )); do [[ -z "${_UI_DISABLED[${_UI_KEYS[$i]}]+x}" ]] && { cur=$i; break; }; done
    tput civis >&2 2>/dev/null || true
    _draw_cl() {
      local j mark
      printf '\r\033[2K%s%s%s\n' "$C_BOLD" "$title" "$C_RESET" >&2
      local help="↑/↓ (j/k) move · space toggle · enter confirm"
      [[ $_UI_ALLKEY == 1 ]] && help+=" · a select all + confirm"
      help+=" · q quit"
      printf '\r\033[2K  %s%s%s\n' "$C_DIM" "$help" "$C_RESET" >&2
      for (( j = 0; j < n; j++ )); do
        local k="${_UI_KEYS[$j]}" lab="${_UI_LABELS[$j]}"
        mark=" "; [[ ${sel[$j]} == 1 ]] && mark="x"
        if [[ -n "${_UI_DISABLED[$k]+x}" ]]; then
          printf '\r\033[2K    %s[-] %s (unavailable: %s)%s\n' "$C_DIM" "$lab" "${_UI_DISABLED[$k]}" "$C_RESET" >&2
        elif (( j == cur )); then
          printf '\r\033[2K  %s> [%s] %s%s\n' "$C_CYAN$C_BOLD" "$mark" "$lab" "$C_RESET" >&2
        else
          printf '\r\033[2K    [%s] %s\n' "$mark" "$lab" >&2
        fi
      done
      printf '\r\033[2K%s\n' "$notice" >&2
    }
    _draw_cl
    while true; do
      IFS= read -rsn1 -u "$UI_FD" key || { tput cnorm >&2 2>/dev/null; _ui_eof "$title"; }
      if [[ $key == $'\x1b' ]]; then read -rsn2 -t 0.1 -u "$UI_FD" rest || rest=""; key+="$rest"; fi
      notice=""
      case "$key" in
        $'\x1b[A'|k|K) for (( i = 0; i < n; i++ )); do cur=$(( (cur - 1 + n) % n )); [[ -z "${_UI_DISABLED[${_UI_KEYS[$cur]}]+x}" ]] && break; done ;;
        $'\x1b[B'|j|J) for (( i = 0; i < n; i++ )); do cur=$(( (cur + 1) % n )); [[ -z "${_UI_DISABLED[${_UI_KEYS[$cur]}]+x}" ]] && break; done ;;
        ' ') [[ -z "${_UI_DISABLED[${_UI_KEYS[$cur]}]+x}" ]] && sel[$cur]=$(( 1 - sel[cur] )) ;;
        a|A)
          if [[ $_UI_ALLKEY == 1 ]]; then
            for (( i = 0; i < n; i++ )); do [[ -z "${_UI_DISABLED[${_UI_KEYS[$i]}]+x}" ]] && sel[$i]=1; done
            CHECKLIST_ALL=1; break
          fi ;;
        q|Q) tput cnorm >&2 2>/dev/null || true; log_error "Cancelled."; exit 3 ;;
        ""|$'\n'|$'\r')
          local sum=0; for (( i = 0; i < n; i++ )); do sum=$((sum + sel[i])); done
          if (( sum >= _UI_MIN )); then break; fi
          notice="  ${C_YELLOW}(select at least $_UI_MIN option$([[ $_UI_MIN -gt 1 ]] && echo s) first)${C_RESET}" ;;
      esac
      printf '\033[%dA' "$lines" >&2
      _draw_cl
    done
    tput cnorm >&2 2>/dev/null || true
  else
    printf '%s%s%s\n' "$C_BOLD" "$title" "$C_RESET" >&2
    for (( i = 0; i < n; i++ )); do
      local k="${_UI_KEYS[$i]}"
      if [[ -n "${_UI_DISABLED[$k]+x}" ]]; then
        printf '   %d) %s (unavailable: %s)\n' $((i + 1)) "${_UI_LABELS[$i]}" "${_UI_DISABLED[$k]}" >&2
      else
        printf '   %d) [%s] %s\n' $((i + 1)) "$([[ ${sel[$i]} == 1 ]] && echo x || echo ' ')" "${_UI_LABELS[$i]}" >&2
      fi
    done
    local ans tok idx ok eof
    while true; do
      eof=0
      printf '%s?%s Select (numbers/keys, comma separated%s; empty = keep marked): ' "$C_CYAN" "$C_RESET" \
        "$([[ $_UI_ALLKEY == 1 ]] && echo '; "all!" = everything + confirm')" >&2
      if ! _ui_read_line ans; then printf '\n' >&2; ans=""; eof=1; fi
      if [[ "$ans" == "all!" && $_UI_ALLKEY == 1 ]]; then
        for (( i = 0; i < n; i++ )); do [[ -z "${_UI_DISABLED[${_UI_KEYS[$i]}]+x}" ]] && sel[$i]=1; done
        CHECKLIST_ALL=1; break
      fi
      if [[ -n "$ans" ]]; then
        local -a newsel=(); for (( i = 0; i < n; i++ )); do newsel[$i]=0; done
        ok=1
        if [[ "$ans" == all ]]; then
          for (( i = 0; i < n; i++ )); do [[ -z "${_UI_DISABLED[${_UI_KEYS[$i]}]+x}" ]] && newsel[$i]=1; done
        else
          for tok in ${ans//,/ }; do
            if idx="$(_ui_key_index "$tok")" && [[ -z "${_UI_DISABLED[${_UI_KEYS[$idx]}]+x}" ]]; then newsel[$idx]=1
            else log_warn "Not a valid/available choice: $tok"; ok=0; fi
          done
        fi
        [[ $ok == 1 ]] || continue
        sel=("${newsel[@]}")
      fi
      local sum=0; for (( i = 0; i < n; i++ )); do sum=$((sum + sel[i])); done
      if (( sum >= _UI_MIN )); then break; fi
      log_warn "Select at least $_UI_MIN option(s)."
      [[ $eof == 1 ]] && _ui_eof "$title"
    done
  fi
  local -a out=()
  for (( i = 0; i < n; i++ )); do [[ ${sel[$i]} == 1 ]] && out+=("${_UI_KEYS[$i]}"); done
  # assign to the caller's array by name
  eval "$__arr=(\"\${out[@]}\")"
  return 0
}

# ask_percent VAR LABEL --remaining R --pending P --base BYTES [--default D]
#   Integer percentage prompt for storage allocation:
#     * shows "R% remaining — <R% of BASE in the largest decimal unit>"
#     * accepts 1 … R−P when P roles are still pending after this one (i.e.
#       strictly less than the remaining balance), or 1 … R for the last role
#     * the last role (P == 0) defaults to the whole remaining balance.
ask_percent() {
  local __var="$1" label="$2"; shift 2
  local rem="" pend=0 base=0 def=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --remaining) rem="$2"; shift 2 ;;
      --pending) pend="$2"; shift 2 ;;
      --base) base="$2"; shift 2 ;;
      --default) def="$2"; shift 2 ;;
      *) log_error "ask_percent: unknown option $1"; return 2 ;;
    esac
  done
  local max=$(( rem - pend ))
  (( max >= 1 )) || { log_error "ask_percent: nothing left to allocate for $label"; return 1; }
  [[ -z "$def" && $pend -eq 0 ]] && def="$rem"
  [[ -n "$def" ]] && (( def > max )) && def="$max"
  local rem_bytes; rem_bytes=$(awk -v b="$base" -v p="$rem" 'BEGIN{printf "%.0f", b*p/100}')
  printf '  %s%d%% remaining — %s%s' "$C_BOLD" "$rem" "$(fmt_bytes "$rem_bytes")" "$C_RESET" >&2
  if (( pend > 0 )); then
    printf '   %s(%d more role%s still to allocate — enter less than %d%%)%s\n' "$C_DIM" "$pend" \
      "$([[ $pend -gt 1 ]] && echo s)" "$rem" "$C_RESET" >&2
  else
    printf '\n' >&2
  fi
  _ask_percent_validate() {
    local v="$1"
    [[ "$v" =~ ^[0-9]+$ ]] || { log_warn "Enter a whole number of percent."; return 1; }
    if (( v < 1 || v > max )); then
      if (( pend > 0 )); then log_warn "Enter 1–$max (must stay below the remaining $rem% so $pend more role(s) can be allocated)."
      else log_warn "Enter 1–$max."; fi
      return 1
    fi
    log_detail "$v% of the drives = $(fmt_bytes "$(awk -v b="$base" -v p="$v" 'BEGIN{printf "%.0f", b*p/100}')")"
    return 0
  }
  if [[ -n "$def" ]]; then
    ask "$__var" "Allocation for $label (%)" --default "$def" --validate _ask_percent_validate
  else
    ask "$__var" "Allocation for $label (%)" --validate _ask_percent_validate
  fi
}

# ui_pause MESSAGE — wait for Enter (no-op in line mode on EOF).
ui_pause() {
  local _x
  printf '%s%s%s ' "$C_DIM" "${1:-Press Enter to continue…}" "$C_RESET" >&2
  _ui_read_line _x || printf '\n' >&2
}
